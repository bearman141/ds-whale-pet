'use strict'
/**
 * DS鲸鱼娘 桌宠 —— Electron 主进程
 *
 * 架构：
 *   - 一个覆盖主显示器工作区的「全屏透明无边框」窗口
 *   - 默认鼠标穿透（setIgnoreMouseEvents + forward），只有指针真正落在
 *     模型不透明像素上时才切换为可交互，保证其余区域的点击照常落到桌面
 *   - 渲染进程用 PIXI + pixi-live2d-display(Cubism 4) 绘制模型
 */

const {
  app, BrowserWindow, Tray, Menu, ipcMain, protocol, net,
  screen, nativeImage, globalShortcut, shell, dialog,
} = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { buildCatalog } = require('./catalog')
const { Game, STAT_META, STAT_KEYS, titleFor, ACTIONS } = require('./game')
const {
  normalizeConfig, configReady, maskKey, buildSystemPrompt, parseReply,
  requestChat, buildMessages, CHAT_EMOTION_POOL, CHAT_MOTION_POOL,
} = require('./chat')

/* ================================================================== *
 * 基础路径 / 日志
 * ================================================================== */
const APP_DIR = __dirname
const MODEL_DIR = path.join(APP_DIR, 'model')
const MODEL_FILE = path.join(MODEL_DIR, 'c_0120.model3.json')
const ASSET_ICON = path.join(APP_DIR, 'assets', 'icon.png')

app.setPath('userData', path.join(app.getPath('appData'), 'DSWhalePet'))
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
const STATE_FILE = path.join(app.getPath('userData'), 'pet-state.json')
const CHAT_FILE = path.join(app.getPath('userData'), 'chat.json')
const HISTORY_FILE = path.join(app.getPath('userData'), 'chat-history.json')
const LOG_FILE = path.join(app.getPath('userData'), 'pet.log')

fs.mkdirSync(app.getPath('userData'), { recursive: true })

let logStream = null
function log (...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`
  console.log(line)
  try {
    if (!logStream) logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
    logStream.write(line + '\n')
  } catch { /* 日志失败不影响运行 */ }
}

/* ================================================================== *
 * 调试用变体开关（DSHPET_VARIANT=a,b,c）
 * 透明窗口在部分 Windows / 显卡组合下会出现「画布有内容但整窗不合成」，
 * 这里保留一组开关用于定位与自救。
 * ================================================================== */
const VARIANT = process.env.DSHPET_VARIANT || ''
const has = (k) => VARIANT.split(',').map((s) => s.trim()).includes(k)

if (has('nohw')) app.disableHardwareAcceleration()
if (has('nogpucomp')) app.commandLine.appendSwitch('disable-gpu-compositing')
if (has('angle-gl')) app.commandLine.appendSwitch('use-angle', 'gl')
if (has('angle-d3d11')) app.commandLine.appendSwitch('use-angle', 'd3d11')
if (has('angle-d3d9')) app.commandLine.appendSwitch('use-angle', 'd3d9')
if (has('inprocgpu')) app.commandLine.appendSwitch('in-process-gpu')
if (VARIANT) log('调试变体:', VARIANT)

// 音效要在没有用户手势的情况下就能播（她自己是不会「先点一下页面」的）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/* ================================================================== *
 * 设置
 * ================================================================== */
const SIZE_PRESETS = { small: 260, medium: 380, large: 520, huge: 700 }

const DEFAULT_SETTINGS = {
  size: 'medium',
  height: null,         // 滚轮调过之后的具体高度，优先于 size
  x: null,              // 宠物锚点（底部中心）屏幕坐标
  y: null,
  alwaysOnTop: true,
  clickThrough: true,   // true = 按像素穿透；false = 整窗始终可交互
  hotkeys: true,        // 全局热键总开关
  bubble: true,         // 触发时显示气泡
  showHint: true,       // 首次运行提示
  sfx: true,            // 互动音效
  sfxVolume: 0.6,       // 0..1
}

function loadSettings () {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

let settings = loadSettings()
let saveTimer = null
function saveSettings () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
    } catch (e) {
      log('保存设置失败', e.message)
    }
  }, 250)
}

/* ================================================================== *
 * 自定义协议：pet://local/<相对 APP_DIR 的路径>
 * 用真正的 fetch-able origin 提供模型文件，避免 file:// 的资源加载限制
 * ================================================================== */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

function registerProtocol () {
  protocol.handle('pet', (request) => {
    let rel
    try {
      rel = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const target = path.normalize(path.join(APP_DIR, rel))
    if (!target.startsWith(APP_DIR)) {
      log('协议访问越界，已拒绝:', rel)
      return new Response('forbidden', { status: 403 })
    }
    if (!fs.existsSync(target)) {
      log('协议 404:', rel)
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

/* ================================================================== *
 * 模型目录检查
 * ================================================================== */
function ensureModelFile () {
  if (fs.existsSync(MODEL_FILE)) return true
  log('缺少 model3.json，尝试自动生成…')
  try {
    require('./tools/make-model3').build(MODEL_DIR)
    return fs.existsSync(MODEL_FILE)
  } catch (e) {
    log('自动生成 model3.json 失败:', e.message)
    return false
  }
}

/* ================================================================== *
 * 主窗口
 * ================================================================== */
let win = null
let tray = null
let interactive = false
let menuOpen = false
let catalog = { expressions: [], motions: [], hotkeys: [] }

/** 调试：DSHPET_OPAQUE=1 时用不透明洋红背景启动，用来区分
 *  「没画出来」和「画出来了但透明窗口没被合成」 */
const DEBUG_OPAQUE = process.env.DSHPET_OPAQUE === '1'
const DEBUG_EMPTY = process.env.DSHPET_EMPTY === '1'

function workArea () {
  return screen.getPrimaryDisplay().workArea
}

function defaultPosition () {
  const wa = workArea()
  return { x: Math.round(wa.x + wa.width - 220), y: Math.round(wa.y + wa.height - 20) }
}

function petPosition () {
  const d = defaultPosition()
  const x = Number.isFinite(settings.x) ? settings.x : d.x
  const y = Number.isFinite(settings.y) ? settings.y : d.y
  return { x, y }
}

function createWindow () {
  const wa = workArea()

  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: !DEBUG_OPAQUE,
    backgroundColor: DEBUG_OPAQUE ? '#ff00ff' : '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: has('focusable'),
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
  // 只在「按像素穿透」开启时才开始忽略鼠标；关掉时窗口本来就该一直可点。
  // （以前无条件设 true，会导致启动时 clickThrough=false 的情况下永远收不到
  //   鼠标移动，于是永远切不回来。）
  if (settings.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })

  win.once('ready-to-show', () => {
    win.showInactive()
    // 显示之后再设一次：只在构造/显示前调用有时不生效
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
    log('窗口已显示', wa)
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      log('窗口状态自检:', {
        visible: win.isVisible(),
        alwaysOnTop: win.isAlwaysOnTop(),
        focusable: win.isFocusable(),
        bounds: win.getBounds(),
        opacity: win.getOpacity(),
        transparent: !DEBUG_OPAQUE,
        empty: DEBUG_EMPTY,
        osBuild: `${process.getSystemVersion()}`,
      })
    }, 3000)
  })

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  // 页面就绪后补推一次养成快照（启动时的那次 tick 早于渲染进程订阅）
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => { sendGame() }, 400)

    // 调试：DSHPET_CHAT_PROBE="你好" 时自动发一条，用来验证聊天链路
    if (process.env.DSHPET_CHAT_PROBE) {
      setTimeout(() => {
        log('聊天自检：发送 ->', process.env.DSHPET_CHAT_PROBE)
        chatSend(process.env.DSHPET_CHAT_PROBE).then(
          (r) => log('聊天自检：结果 ->', JSON.stringify(r)),
          (e) => log('聊天自检：异常 ->', e && e.message),
        )
      }, 3500)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log('渲染进程崩溃:', details)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('页面加载失败:', code, desc, url)
  })

  win.loadURL('pet://local/renderer/index.html')
  return win
}

/* ------------------------------------------------------------------ *
 * 鼠标穿透
 * ------------------------------------------------------------------ */
let cursorTimer = null

/**
 * 可交互期间主动轮询真实光标位置。
 *
 * 踩过的坑：setIgnoreMouseEvents(true, {forward:true}) 会转发 mousemove，
 * 但一旦切成 false（可交互），Electron 就不再转发了 —— 渲染进程再也收不到
 * mousemove，pointer 会**冻在进入时的位置**，于是它永远发现不了你已经离开面板，
 * 窗口就卡在「可交互」状态，后续点击全落在错误的地方。
 *
 * screen.getCursorScreenPoint() 不受这个限制，用 60ms 轮询补上。
 */
function startCursorPoll () {
  if (cursorTimer || !win || win.isDestroyed()) return
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !interactive) return
    try {
      const p = screen.getCursorScreenPoint()
      win.webContents.send('pet:cursor', { x: p.x, y: p.y })
    } catch { /* ignore */ }
  }, 60)
}

function stopCursorPoll () {
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null }
}

function setInteractive (on) {
  if (!win || win.isDestroyed()) return
  const next = settings.clickThrough ? !!on : true
  if (next === interactive) return
  interactive = next
  try {
    win.setIgnoreMouseEvents(!interactive, { forward: true })
    log(`setIgnoreMouseEvents(${!interactive})  可交互=${interactive}`)
  } catch (e) {
    log('切换鼠标穿透失败:', e.message)
  }
  // 可交互时 mousemove 不再转发，改用轮询喂坐标；不可交互时恢复转发
  if (interactive) startCursorPoll()
  else stopCursorPoll()
}
function hardResetInteraction () {
  interactive = false
  if (win && !win.isDestroyed()) {
    try { win.setIgnoreMouseEvents(!settings.clickThrough, { forward: true }) } catch { /* ignore */ }
  }
}

/* ================================================================== *
 * 全局热键
 * ================================================================== */
const MODIFIER_TOKENS = new Set(['Alt', 'LAlt', 'RAlt', 'Ctrl', 'LCtrl', 'RCtrl', 'Shift', 'RShift', 'Meta'])

/** 规范化写法 -> uiohook 可能的枚举名（不同版本命名有差异，逐个尝试） */
const KEY_NAME_CANDIDATES = {
  Alt: ['Alt', 'LeftAlt'], LAlt: ['Alt', 'LeftAlt'], RAlt: ['AltRight', 'RightAlt'],
  Ctrl: ['Ctrl', 'LeftCtrl'], LCtrl: ['Ctrl', 'LeftCtrl'], RCtrl: ['CtrlRight', 'RightCtrl'],
  Shift: ['Shift', 'LeftShift'], RShift: ['ShiftRight', 'RightShift'],
  Meta: ['Meta', 'LeftMeta'], RMeta: ['MetaRight', 'RightMeta'],
  Del: ['Delete', 'Del'], Ins: ['Insert', 'Ins'],
  PageUp: ['PageUp'], PageDown: ['PageDown'],
  Home: ['Home'], End: ['End'], Enter: ['Enter', 'Return'], Space: ['Space'], Tab: ['Tab'],
  Esc: ['Escape', 'Esc'], Backspace: ['Backspace'],
  Up: ['ArrowUp', 'Up'], Down: ['ArrowDown', 'Down'],
  Left: ['ArrowLeft', 'Left'], Right: ['ArrowRight', 'Right'],
  NumDec: ['NumpadDecimal', 'NumpadPeriod', 'Decimal', 'NumDec'],
  NumMul: ['NumpadMultiply', 'Multiply', 'NumMul'],
  NumDiv: ['NumpadDivide', 'Divide', 'NumDiv'],
  NumAdd: ['NumpadAdd', 'Add', 'NumAdd'],
  NumSub: ['NumpadSubtract', 'Subtract', 'NumSub'],
  NumEnter: ['NumpadEnter'],
  Num0: ['Numpad0', 'Num0'], Num1: ['Numpad1', 'Num1'], Num2: ['Numpad2', 'Num2'],
  Num3: ['Numpad3', 'Num3'], Num4: ['Numpad4', 'Num4'], Num5: ['Numpad5', 'Num5'],
  Num6: ['Numpad6', 'Num6'], Num7: ['Numpad7', 'Num7'], Num8: ['Numpad8', 'Num8'],
  Num9: ['Numpad9', 'Num9'],
}
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEY_NAME_CANDIDATES[c] = [c]
for (let d = 0; d <= 9; d++) KEY_NAME_CANDIDATES[String(d)] = [`Digit${d}`, String(d)]
for (let f = 1; f <= 24; f++) KEY_NAME_CANDIDATES[`F${f}`] = [`F${f}`]

let keyTokenByCode = new Map()   // uiohook keycode -> 规范化 token
let pressedCodes = new Set()
let hotkeyIndex = new Map()      // 规范化 combo -> action
let hookStarted = false
const shortcutRegistered = []

function comboKey (tokens) {
  return [...tokens].sort().join('+')
}

function buildHotkeyIndex () {
  hotkeyIndex = new Map()
  for (const h of catalog.hotkeys) {
    const tokens = h.combo.split('+')
    const key = comboKey(tokens)
    if (hotkeyIndex.has(key)) log('热键冲突，后者覆盖前者:', h.combo)
    hotkeyIndex.set(key, h)
  }
}

function startUiohook () {
  let mod
  try {
    mod = require('uiohook-napi')
  } catch (e) {
    log('uiohook-napi 不可用:', e.message)
    return false
  }
  const { uIOhook, UiohookKey } = mod
  if (!uIOhook || !UiohookKey) return false

  // 反向映射：keycode -> token
  keyTokenByCode = new Map()
  const missing = []
  for (const token of Object.keys(KEY_NAME_CANDIDATES)) {
    const names = KEY_NAME_CANDIDATES[token]
    let code
    for (const n of names) {
      if (UiohookKey[n] !== undefined) { code = UiohookKey[n]; break }
    }
    if (code === undefined) { missing.push(token); continue }
    if (!keyTokenByCode.has(code)) keyTokenByCode.set(code, token)
  }
  if (missing.length) log('uiohook 缺少按键枚举（这些组合将不可用）:', missing.join(','))

  // libuiohook 在 Windows 上对 PageUp / PageDown / 方向键 / Home / End 这类键，
  // 有时会**带上扩展位**报上来：实测 PageUp 报 61001 (0xEE49)，
  // 而 UiohookKey.PageUp 的枚举值是 3657 (0x0E49)。只登记枚举值的话，
  // 这些热键（按键归位、吹泡泡糖…）在真键盘上也会完全失灵。
  // 扩展位形式是 0xEE00 | (低字节)，所以两种都登记。
  let extAdded = 0
  for (const [code, token] of [...keyTokenByCode]) {
    const ext = 0xEE00 | (code & 0xFF)
    if (ext !== code && !keyTokenByCode.has(ext)) {
      keyTokenByCode.set(ext, token)
      extAdded++
    }
  }
  log(`按键映射就绪：${keyTokenByCode.size} 个键码（其中 ${extAdded} 个是扩展位形式）`)

  uIOhook.on('keydown', (e) => {
    if (!settings.hotkeys) return
    if (process.env.DSHPET_KEYDEBUG) {
      log(`[key] code=${e.keycode} token=${keyTokenByCode.get(e.keycode) || '(未映射)'} ` +
        `shift=${e.shiftKey} ctrl=${e.ctrlKey} alt=${e.altKey} meta=${e.metaKey}`)
    }
    if (pressedCodes.has(e.keycode)) return   // 忽略自动重复
    pressedCodes.add(e.keycode)
    const tokens = new Set()
    for (const c of pressedCodes) {
      const t = keyTokenByCode.get(c)
      if (t) tokens.add(t)
    }
    const hit = hotkeyIndex.get(comboKey(tokens))
    if (hit) fireAction(hit)
  })
  uIOhook.on('keyup', (e) => pressedCodes.delete(e.keycode))

  try {
    uIOhook.start()
    hookStarted = true
    log('全局键盘钩子已启动，热键数量:', hotkeyIndex.size)
    return true
  } catch (e) {
    log('启动全局键盘钩子失败:', e.message)
    return false
  }
}

/** Electron accelerator 能表达的写法（无法表达 Delete/小键盘 作为修饰键的组合） */
function toAccelerator (combo) {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  if (['NumDec', 'NumMul', 'NumDiv', 'PageUp'].includes(key) && parts.length > 1) return null
  const mods = parts.slice(0, -1)
  const modMap = { Alt: 'Alt', LAlt: 'Alt', RAlt: 'Alt', Ctrl: 'Control', LCtrl: 'Control', RCtrl: 'Control', Shift: 'Shift' }
  const out = []
  for (const m of mods) {
    const mapped = modMap[m]
    if (!mapped) return null
    if (!out.includes(mapped)) out.push(mapped)
  }
  const keyMap = { Del: 'Delete', Esc: 'Escape', PageUp: 'PageUp', PageDown: 'PageDown', NumDec: 'numdec', NumMul: 'nummult' }
  out.push(keyMap[key] || key)
  return out.join('+')
}

function startGlobalShortcuts () {
  let ok = 0
  const skipped = []
  for (const h of catalog.hotkeys) {
    const acc = toAccelerator(h.combo)
    if (!acc) { skipped.push(h.combo); continue }
    try {
      if (globalShortcut.register(acc, () => settings.hotkeys && fireAction(h))) {
        shortcutRegistered.push(acc)
        ok++
      } else {
        skipped.push(h.combo)
      }
    } catch {
      skipped.push(h.combo)
    }
  }
  log(`globalShortcut 回退模式：注册 ${ok} 个，未覆盖 ${skipped.length} 个 ->`, skipped.join(', '))
}

function stopHotkeys () {
  if (hookStarted) {
    try { require('uiohook-napi').uIOhook.stop() } catch { /* ignore */ }
    hookStarted = false
  }
  for (const acc of shortcutRegistered) {
    try { globalShortcut.unregister(acc) } catch { /* ignore */ }
  }
  shortcutRegistered.length = 0
  pressedCodes.clear()
}

function startHotkeys () {
  stopHotkeys()
  buildHotkeyIndex()
  if (!settings.hotkeys) { log('热键已关闭'); return }
  if (!startUiohook()) startGlobalShortcuts()
}

/** 把一个动作发给渲染进程执行 */
function fireAction (action) {
  if (!win || win.isDestroyed()) return
  // 养成互动在主进程直接结算，不需要绕渲染进程
  if (action.kind === 'action') {
    log('触发:', action.label || action.target)
    gameAct(action.target)
    return
  }
  log('触发:', action.label, action.combo ? `(${action.combo})` : '')
  win.webContents.send('pet:action', {
    kind: action.kind,
    target: action.target,
    label: action.label,
  })
}

/* ================================================================== *
 * 养成系统
 *
 * 引擎（game.js）是纯逻辑，这里只负责：定时 tick、持久化、
 * 把事件翻译成渲染指令、以及把快照推给状态面板。
 * ================================================================== */
let game = null
let gameSaveTimer = null
let gameTimer = null

const TICK_MS = 20000

function loadGame () {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    game = Game.load(raw)
    log('读取养成存档：', `Lv.${game.s.level}「${titleFor(game.s.level)}」 已相处 ${((Date.now() - game.s.birth) / 3600000).toFixed(1)} 小时`)
  } catch (e) {
    game = new Game()
    if (e.code !== 'ENOENT') log('养成存档损坏，已重置：', e.message)
    else log('未找到养成存档，创建新档')
  }
}

function saveGame (immediate = false) {
  if (!game) return
  clearTimeout(gameSaveTimer)
  const write = () => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(game.serialize(), null, 2))
    } catch (e) {
      log('保存养成存档失败:', e.message)
    }
  }
  if (immediate) write()
  else gameSaveTimer = setTimeout(write, 400)
}

function sendGame () {
  if (!win || win.isDestroyed() || !game) return
  win.webContents.send('pet:game', {
    snapshot: game.snapshot(),
    statMeta: STAT_META,
    statKeys: STAT_KEYS,
  })
}

/** 把引擎事件翻译成渲染指令；log 类同时落进面板事件流 */
function dispatchEvents (events) {
  if (!events || !events.length) return
  if (!game || !win || win.isDestroyed()) return
  for (const ev of events) {
    if (ev.type === 'log') game.pushLog(ev.icon, ev.text)
  }
  win.webContents.send('pet:events', events)
}

function gameTick () {
  if (!game) return
  const { events } = game.tick()
  dispatchEvents(events)
  saveGame()
  sendGame()
}

function startGameLoop () {
  loadGame()
  gameTick()
  clearInterval(gameTimer)
  gameTimer = setInterval(gameTick, TICK_MS)
  log(`养成循环已启动（每 ${TICK_MS / 1000} 秒一跳）`)
}

/** 执行一次养成互动 */
function gameAct (name) {
  if (!game) return { ok: false, reason: '养成系统还没就绪' }

  // 这两个不是互动，只是开面板
  if (name === 'panel') {
    win?.webContents.send('pet:panel', { toggle: true })
    return { ok: true }
  }
  if (name === 'chat') {
    win?.webContents.send('pet:chatpanel', { toggle: true })
    return { ok: true }
  }

  const res = game.act(name)
  if (!res.ok && !/再等等/.test(res.reason || '')) log('互动被拒:', name, res.reason)
  dispatchEvents(res.events)
  saveGame(true)
  sendGame()
  return res
}

/* ================================================================== *
 * 聊天（OpenAI 兼容接口）
 *
 * 关键点：
 *  - 提示词里会塞进她当前的养成状态，所以同样一句话，
 *    饿的时候和吃饱的时候口气不一样
 *  - 让她在回复开头带 [表情:xxx][动作:xxx]，解析出来后
 *    直接喂给渲染进程的分层表情栈 —— 聊天内容能驱动表情和动作
 *  - 走 Electron 的 net.fetch 而不是 Node 的 fetch，
 *    因为 net.fetch 会吃系统代理设置（这台机器上 GitHub/OpenAI 都得走代理）
 * ================================================================== */
let chatConfig = null
let chatHistory = []
let chatBusy = false

function loadChat () {
  try {
    chatConfig = normalizeConfig(JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')))
  } catch (e) {
    chatConfig = normalizeConfig(null)
    if (e.code !== 'ENOENT') log('聊天配置损坏，已重置：', e.message)
  }
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    chatHistory = Array.isArray(h) ? h.filter((m) => m && m.role && m.content) : []
  } catch {
    chatHistory = []
  }
  log('聊天配置：', configReady(chatConfig)
    ? `${chatConfig.model} @ ${chatConfig.baseUrl}${chatConfig.apiKey ? '（已配置密钥）' : '（无密钥）'}`
    : '未启用', `| 历史 ${chatHistory.length} 条`)
}

function saveChatConfig () {
  try { fs.writeFileSync(CHAT_FILE, JSON.stringify(chatConfig, null, 2)) } catch (e) { log('保存聊天配置失败:', e.message) }
}

function saveChatHistory () {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory.slice(-120)))
  } catch (e) { log('保存聊天记录失败:', e.message) }
}

/** 给渲染进程看的配置：密钥只回掩码，绝不回明文 */
function chatPublicConfig () {
  return {
    enabled: chatConfig.enabled,
    baseUrl: chatConfig.baseUrl,
    model: chatConfig.model,
    temperature: chatConfig.temperature,
    maxTokens: chatConfig.maxTokens,
    stream: chatConfig.stream,
    historyLimit: chatConfig.historyLimit,
    systemExtra: chatConfig.systemExtra,
    hasKey: !!chatConfig.apiKey,
    keyMask: maskKey(chatConfig.apiKey),
    ready: configReady(chatConfig),
  }
}

function chatSaveConfig (patch) {
  const next = { ...chatConfig }
  if (patch && typeof patch === 'object') {
    for (const k of ['enabled', 'baseUrl', 'model', 'temperature', 'maxTokens', 'stream', 'historyLimit', 'systemExtra']) {
      if (patch[k] !== undefined) next[k] = patch[k]
    }
    // 密钥只在明确传了新值时才覆盖；clearKey 表示清空
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
    if (patch.clearKey) next.apiKey = ''
  }
  chatConfig = normalizeConfig(next)
  saveChatConfig()
  log('聊天配置已更新:', chatConfig.baseUrl, '|', chatConfig.model, chatConfig.apiKey ? '| 有密钥' : '| 无密钥')
  return chatPublicConfig()
}

const chatTo = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function chatSend (text) {
  const say = String(text == null ? '' : text).trim().slice(0, 2000)
  if (!say) return { ok: false, error: '消息是空的' }
  if (chatBusy) return { ok: false, error: '她还在想上一条呢' }

  if (!configReady(chatConfig)) {
    chatTo('pet:chat-reply', { ok: false, needSetup: true, error: '还没配置聊天接口' })
    return { ok: false, error: '未配置' }
  }

  chatBusy = true
  chatTo('pet:chat-thinking', { on: true })

  // 先记下用户这句，界面上立刻显示
  chatHistory.push({ role: 'user', content: say })
  saveChatHistory()
  chatTo('pet:chat-message', { role: 'user', content: say })

  // 思考中的小表现
  dispatchEvents([
    { type: 'expression', target: '呆呆眼', ttl: 4000, layer: 'event' },
  ])

  try {
    const snap = game ? game.snapshot() : null
    const allowed = (pool, have) => pool.filter((n) => !have || have.has(n))
    const emotions = allowed(CHAT_EMOTION_POOL, catalog.expressionNames)
    const motions = allowed(CHAT_MOTION_POOL, catalog.motionNames)

    const system = buildSystemPrompt(snap, { emotions, motions, extra: chatConfig.systemExtra })
    const messages = buildMessages(system, chatHistory.slice(0, -1), say, chatConfig.historyLimit)

    const raw = await requestChat(chatConfig, messages, {
      fetchImpl: (url, opts) => net.fetch(url, opts),
      onDelta: (full) => chatTo('pet:chat-delta', { text: full }),
    })

    const parsed = parseReply(raw)
    chatHistory.push({ role: 'assistant', content: parsed.text })
    if (chatHistory.length > 200) chatHistory = chatHistory.slice(-200)
    saveChatHistory()

    // 聊天也算陪伴：涨好感 / 心情 / 经验
    const res = game ? game.noteChat() : null
    if (res && res.events.length) dispatchEvents(res.events)
    if (res) { saveGame(true); sendGame() }

    // 她的回复反过来驱动表情和动作
    const evs = []
    if (parsed.emotion && (!catalog.expressionNames || catalog.expressionNames.has(parsed.emotion))) {
      evs.push({ type: 'expression', target: parsed.emotion, ttl: 9000, layer: 'event' })
    }
    if (parsed.motion && (!catalog.motionNames || catalog.motionNames.has(parsed.motion))) {
      evs.push({ type: 'motion', target: parsed.motion, label: parsed.motion })
    }
    if (parsed.text && parsed.text.length <= 70) {
      evs.push({ type: 'bubble', text: parsed.text, ms: 3600 })
    }
    if (evs.length) dispatchEvents(evs)

    log('聊天回复:', parsed.emotion ? `[${parsed.emotion}]` : '', parsed.text.slice(0, 60))
    chatTo('pet:chat-reply', { ok: true, text: parsed.text, emotion: parsed.emotion, motion: parsed.motion })
    return { ok: true }
  } catch (e) {
    const msg = String((e && e.message) || e)
    log('聊天失败:', msg)
    dispatchEvents([
      { type: 'bubble', text: '呜……我脑子卡住了' },
      { type: 'expression', target: '晕晕', ttl: 5000, layer: 'event' },
    ])
    chatTo('pet:chat-reply', { ok: false, error: msg })
    return { ok: false, error: msg }
  } finally {
    chatBusy = false
    chatTo('pet:chat-thinking', { on: false })
  }
}

/* ================================================================== *
 * 菜单
 * ================================================================== */
function withMenuFocus (fn) {
  // 无焦点窗口弹出原生菜单：临时允许聚焦，弹完还原
  if (!win || win.isDestroyed()) return
  const wasFocusable = win.isFocusable()
  try { win.setFocusable(true) } catch { /* ignore */ }
  menuOpen = true
  setInteractive(true)
  fn()
  setTimeout(() => {
    menuOpen = false
    try { if (!wasFocusable) win.setFocusable(false) } catch { /* ignore */ }
    setInteractive(false)
  }, 400)
}

function makeMenuTemplate (extra = []) {
  const exprItems = catalog.expressions.map((e) => ({
    label: e.label,
    click: () => fireAction({ kind: 'expression', target: e.name, label: e.label }),
  }))
  const motionItems = catalog.motions.map((m) => ({
    label: m.label,
    click: () => fireAction({ kind: 'motion', target: m.name, label: m.label }),
  }))
  const sizeItems = Object.keys(SIZE_PRESETS).map((k) => ({
    label: { small: '小', medium: '中', large: '大', huge: '超大' }[k],
    type: 'radio',
    checked: settings.size === k,
    click: () => applySetting('size', k),
  }))
  sizeItems.push({ type: 'separator' }, { label: '（也可在宠物上滚滚轮）', enabled: false })

  /* ---- 养成：照顾她 ---- */
  const s = game ? game.s : null
  const careItems = []
  if (s) {
    careItems.push(
      {
        label: `${game.mood ? game.mood.emoji : '🐋'} Lv.${s.level}「${titleFor(s.level)}」· ${game.mood ? game.mood.name : ''}`,
        enabled: false,
      },
      { type: 'separator' },
    )
    for (const key of ['feed', 'play', 'pet', 'clean', 'gift', 'sleep']) {
      const a = ACTIONS[key]
      if (!a) continue
      const can = game.canDo(key)
      const cd = Math.ceil(Math.max(0, (s.cooldowns[key] || 0) - Date.now()) / 1000)
      careItems.push({
        label: `${a.icon} ${a.label}${can.ok ? '' : `　（${cd > 0 ? cd + 's' : can.reason}）`}`,
        enabled: can.ok,
        click: () => gameAct(key),
      })
    }
    careItems.push(
      { type: 'separator' },
      {
        label: `🍚 饱食 ${Math.round(s.stats.satiety)}　💗 心情 ${Math.round(s.stats.mood)}`,
        enabled: false,
      },
      {
        label: `⚡ 精力 ${Math.round(s.stats.energy)}　🫧 清洁 ${Math.round(s.stats.clean)}`,
        enabled: false,
      },
      { label: `❤️ 好感 ${s.affection.toFixed(1)} / 100`, enabled: false },
    )
  } else {
    careItems.push({ label: '养成系统未就绪', enabled: false })
  }

  return [
    ...extra,
    { type: 'separator' },
    { label: '🐋 照顾她', submenu: careItems },
    { label: '💬 和她聊天', click: () => win?.webContents.send('pet:chatpanel', { toggle: true }) },
    {
      label: '📊 状态面板',
      click: () => win?.webContents.send('pet:panel', { toggle: true }),
    },
    { type: 'separator' },
    { label: '😊 表情', submenu: exprItems },
    { label: '🎬 动作', submenu: motionItems },
    {
      label: '✨ 随机换表情',
      click: () => fireAction({ kind: 'random-expression', target: '', label: '随机表情' }),
    },
    {
      label: '↩️ 按键归位（清除表情）',
      click: () => fireAction({ kind: 'reset', target: '', label: '按键归位' }),
    },
    { type: 'separator' },
    { label: '📏 大小', submenu: sizeItems },
    { label: '🎯 回到右下角', click: () => resetPosition() },
    { type: 'separator' },
    {
      label: '📌 总在最前',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (mi) => applySetting('alwaysOnTop', mi.checked),
    },
    {
      label: '🖱️ 按像素穿透（只点模型）',
      type: 'checkbox',
      checked: settings.clickThrough,
      click: (mi) => applySetting('clickThrough', mi.checked),
    },
    {
      label: '⌨️ 全局热键',
      type: 'checkbox',
      checked: settings.hotkeys,
      click: (mi) => applySetting('hotkeys', mi.checked),
    },
    {
      label: '💬 触发气泡',
      type: 'checkbox',
      checked: settings.bubble,
      click: (mi) => applySetting('bubble', mi.checked),
    },
    {
      label: '🔊 互动音效',
      type: 'checkbox',
      checked: settings.sfx,
      click: (mi) => applySetting('sfx', mi.checked),
    },
    {
      label: '🔉 音效音量',
      submenu: [
        { label: '小', type: 'radio', checked: settings.sfxVolume <= 0.35, click: () => applySetting('sfxVolume', 0.3) },
        { label: '中', type: 'radio', checked: settings.sfxVolume > 0.35 && settings.sfxVolume <= 0.8, click: () => applySetting('sfxVolume', 0.6) },
        { label: '大', type: 'radio', checked: settings.sfxVolume > 0.8, click: () => applySetting('sfxVolume', 1) },
        { type: 'separator' },
        { label: '▶ 试听', click: () => win?.webContents.send('pet:sfx-test', {}) },
      ],
    },
    { type: 'separator' },
    {
      label: '🚀 开机自动启动',
      type: 'checkbox',
      checked: isAutoLaunchOn(),
      click: (mi) => {
        setAutoLaunch(mi.checked)
        refreshTray()
      },
    },
    { label: '📖 按键表 / 说明', click: () => openReadme() },
    { label: '🗂️ 打开模型文件夹', click: () => shell.openPath(MODEL_DIR) },
    { type: 'separator' },
    { label: '❌ 退出', click: () => quitApp() },
  ]
}

function popupMenu (extra = []) {
  withMenuFocus(() => {
    const menu = Menu.buildFromTemplate(makeMenuTemplate(extra))
    menu.popup({ window: win, callback: () => { menuOpen = false } })
  })
}

function refreshTray () {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(makeMenuTemplate([
    { label: '🐋 DS鲸鱼娘 桌宠', enabled: false },
    { type: 'separator' },
  ])))
}

/* ================================================================== *
 * 设置应用
 * ================================================================== */
function applySetting (key, value) {
  settings[key] = value
  saveSettings()

  switch (key) {
    case 'size':
      settings.height = null
      saveSettings()
      win?.webContents.send('pet:size', SIZE_PRESETS[value])
      break
    case 'alwaysOnTop':
      win?.setAlwaysOnTop(!!value, 'floating')
      break
    case 'clickThrough':
      hardResetInteraction()
      break
    case 'hotkeys':
      startHotkeys()
      break
    case 'bubble':
      win?.webContents.send('pet:bubbleSetting', !!value)
      break
    case 'sfx':
    case 'sfxVolume':
      win?.webContents.send('pet:sfxSetting', { enabled: settings.sfx, volume: settings.sfxVolume })
      break
    default:
      break
  }
  refreshTray()
}

/* ------------------------------------------------------------------ *
 * 开机自启
 * ------------------------------------------------------------------ */
function autoLaunchArgs () {
  // 开发态（未打包）时，登录项必须带上应用目录参数，否则只会启动 electron.exe
  return app.isPackaged ? [] : [APP_DIR]
}

function isAutoLaunchOn () {
  try {
    return app.getLoginItemSettings({ path: process.execPath, args: autoLaunchArgs() }).openAtLogin
  } catch {
    return false
  }
}

function setAutoLaunch (on) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: process.execPath,
      args: autoLaunchArgs(),
    })
    log('开机自启 ->', !!on)
  } catch (e) {
    log('设置开机自启失败:', e.message)
  }
}

function resetPosition () {
  const d = defaultPosition()
  settings.x = d.x
  settings.y = d.y
  saveSettings()
  win?.webContents.send('pet:position', d)
}

function openReadme () {
  const p = path.join(APP_DIR, '按键表.txt')
  if (fs.existsSync(p)) shell.openPath(p)
}

function quitApp () {
  log('退出')
  stopHotkeys()
  clearInterval(gameTimer)
  saveGame(true)
  try { tray?.destroy() } catch { /* ignore */ }
  app.exit(0)
}

/* ================================================================== *
 * IPC
 * ================================================================== */
function setupIpc () {
  ipcMain.on('pet:log', (_e, msg) => log('[pet]', msg))

  ipcMain.on('pet:interactive', (_e, on) => {
    if (menuOpen) { log('忽略可交互请求：菜单正打开着'); return }
    setInteractive(on)
  })

  ipcMain.on('pet:move', (_e, pos) => {
    if (typeof pos?.x === 'number' && typeof pos?.y === 'number') {
      settings.x = Math.round(pos.x)
      settings.y = Math.round(pos.y)
      saveSettings()
    }
  })

  ipcMain.on('pet:height', (_e, h) => {
    if (typeof h !== 'number' || !Number.isFinite(h)) return
    settings.height = Math.round(Math.min(1000, Math.max(160, h)))
    settings.size = 'custom'
    saveSettings()
  })

  ipcMain.on('pet:contextmenu', () => {
    if (menuOpen) return
    popupMenu()
  })

  ipcMain.on('pet:quit', () => quitApp())

  /* ---- 养成 ---- */
  ipcMain.on('pet:game-action', (_e, name) => gameAct(String(name || '')))

  /**
   * 光标进入面板 —— 这是「面板里能打字」的关键。
   *
   * 窗口平时是 focusable:false（不抢前台焦点、不进 Alt+Tab）。但这样 Windows
   * 不会把键盘焦点给它，输入框看着有光标却打不进字。
   *
   * 所以：光标一进面板就把窗口变成「可激活」，之后用户点输入框时由 Windows
   * 自己完成激活 —— 这是最可靠的路子，比在 JS 里 setFocusable+focus 猜要稳。
   * 光标离开且窗口没被聚焦时再恢复成不抢焦点。这样点宠物本身仍然不会抢焦点。
   */
  let panelHover = false
  ipcMain.on('pet:panel-hover', (_e, on) => {
    if (!win || win.isDestroyed()) return
    const next = !!on
    if (next === panelHover) return
    panelHover = next
    try {
      if (next) {
        win.setFocusable(true)
        log('光标进入面板：窗口已允许被激活')
      } else if (!win.isFocused()) {
        win.setFocusable(false)
        log('光标离开面板：窗口恢复为不抢焦点')
      }
    } catch (e) {
      log('切换窗口可激活状态失败:', e.message)
    }
  })

  // 兜底：输入框拿到 DOM 焦点后再主动要一次系统焦点（有些情况下点击不会
  // 自动激活窗口，比如面板刚展开的那一下）。
  //
  // 注意这里必须「已经获得焦点就立刻返回」：否则 win.focus() 会让输入框
  // 失焦又重获，focus 事件再触发一次 needFocus，滚成死循环。
  let focusLoop = null
  ipcMain.on('pet:need-focus', (_e, on) => {
    if (!win || win.isDestroyed()) return

    if (!on) {
      clearTimeout(focusLoop); focusLoop = null
      if (!win.isFocused() && !panelHover) {
        try { win.setFocusable(false) } catch { /* ignore */ }
      }
      return
    }

    if (!win.isFocusable()) {
      try { win.setFocusable(true) } catch (e) { log('setFocusable(true) 失败:', e.message) }
    }
    // 已经是焦点窗口就什么都别做，避免打断正在进行的输入
    if (win.isFocused()) { clearTimeout(focusLoop); focusLoop = null; return }
    if (focusLoop) return   // 已经有一轮在跑了

    let tries = 0
    const attempt = () => {
      focusLoop = null
      if (!win || win.isDestroyed() || win.isFocused()) return
      if (++tries > 10) { log('文本输入：试了 10 次仍拿不到焦点'); return }
      try {
        win.focus()
        win.webContents.focus()
      } catch (e) { log('focus() 失败:', e.message) }
      focusLoop = setTimeout(attempt, 60)
    }
    attempt()
  })

  ipcMain.on('pet:set-name', (_e, name) => {
    if (!game) return
    const n = String(name || '').trim().slice(0, 12)
    if (!n) return
    game.s.name = n
    saveGame(true)
    sendGame()
    log('改名 ->', n)
  })

  ipcMain.on('pet:game-reset', async () => {
    if (!game) return
    withMenuFocus(() => {})
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '重新领养'],
      defaultId: 0,
      cancelId: 0,
      title: '重新领养',
      message: '要重新领养一只吗？',
      detail: `当前进度（Lv.${game.s.level}「${titleFor(game.s.level)}」、好感 ${game.s.affection.toFixed(1)}）会被清空，且无法恢复。`,
    })
    if (response !== 1) return
    game = new Game()
    saveGame(true)
    sendGame()
    dispatchEvents([
      { type: 'log', icon: '🐋', text: '重新领养了一只小鲸鱼' },
      { type: 'bubble', text: '你好呀，初次见面！' },
      { type: 'expression', target: '开心兴奋', ttl: 5000, layer: 'event' },
    ])
    log('已重新领养')
  })

  /* ---- 聊天 ---- */
  ipcMain.handle('pet:chat-init', () => ({
    config: chatPublicConfig(),
    history: chatHistory.slice(-40),
    busy: chatBusy,
  }))

  ipcMain.handle('pet:chat-send', (_e, text) => chatSend(text))

  ipcMain.handle('pet:chat-save-config', (_e, patch) => chatSaveConfig(patch))

  ipcMain.handle('pet:chat-test', async () => {
    if (!configReady(chatConfig)) return { ok: false, error: '请先填写接口地址和模型名' }
    const wasStream = chatConfig.stream
    try {
      // 测试连通性时强制非流式，拿完整响应好判断
      const probe = { ...chatConfig, stream: false, maxTokens: 64 }
      const raw = await requestChat(probe, [
        { role: 'system', content: '你只能用一句话回答。' },
        { role: 'user', content: '在吗？' },
      ], { fetchImpl: (url, opts) => net.fetch(url, opts) })
      log('聊天连通性测试成功:', String(raw).slice(0, 80))
      return { ok: true, sample: String(raw).slice(0, 200) }
    } catch (e) {
      log('聊天连通性测试失败:', e.message)
      return { ok: false, error: String((e && e.message) || e) }
    } finally {
      chatConfig.stream = wasStream
    }
  })

  ipcMain.on('pet:chat-clear', () => {
    chatHistory = []
    saveChatHistory()
    chatTo('pet:chat-cleared', {})
    log('聊天记录已清空')
  })

  ipcMain.handle('pet:init', () => {
    // 首次运行提示只显示一次
    const firstRun = !!settings.showHint
    if (firstRun) {
      settings.showHint = false
      saveSettings()
    }

    return {
      modelUrl: 'pet://local/model/c_0120.model3.json',
      catalog: {
        expressions: catalog.expressions.map((e) => ({ name: e.name, file: e.file, label: e.label })),
        motions: catalog.motions.map((m) => ({ name: m.name, file: m.file, label: m.label, loop: !!m.loop })),
        hotkeys: catalog.hotkeys,
      },
      settings: { ...settings, showHint: firstRun },
      petHeight: settings.height || SIZE_PRESETS[settings.size] || SIZE_PRESETS.medium,
      position: petPosition(),
      workArea: workArea(),
      game: game ? { snapshot: game.snapshot(), statMeta: STAT_META, statKeys: STAT_KEYS } : null,
    }
  })
}

/* ================================================================== *
 * 生命周期
 * ================================================================== */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    win?.showInactive()
  })

  app.whenReady().then(() => {
    log('==== DS鲸鱼娘 桌宠启动 ====', { electron: process.versions.electron, chrome: process.versions.chrome })

    Menu.setApplicationMenu(null)
    registerProtocol()

    if (!ensureModelFile()) {
      log('模型文件缺失，仍然继续启动以便查看错误')
    }

    catalog = buildCatalog(MODEL_DIR)
    catalog.expressionNames = new Set(catalog.expressions.map((e) => e.name))
    catalog.motionNames = new Set(catalog.motions.map((m) => m.name))
    log(`目录：表情 ${catalog.expressions.length} 个，动作 ${catalog.motions.length} 个，热键 ${catalog.hotkeys.length} 条`)

    setupIpc()
    createWindow()

    const icon = nativeImage.createFromPath(ASSET_ICON)
    try {
      tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
      tray.setToolTip('DS鲸鱼娘 桌宠 — 右键打开菜单')
      tray.on('click', () => tray.popUpContextMenu())
      tray.on('double-click', () => win?.webContents.send('pet:action', { kind: 'random-expression', label: '随机表情' }))
      refreshTray()
    } catch (e) {
      log('创建托盘失败:', e.message)
    }

    loadChat()
    startHotkeys()
    startGameLoop()

    screen.on('display-metrics-changed', () => {
      if (!win || win.isDestroyed()) return
      const wa = workArea()
      win.setBounds(wa)
      win.webContents.send('pet:workArea', wa)
    })
  })

  app.on('window-all-closed', (e) => {
    // 托盘常驻，不随窗口关闭退出
    e?.preventDefault?.()
  })

  app.on('before-quit', () => stopHotkeys())
}
