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
  if (!has('noignore')) win.setIgnoreMouseEvents(true, { forward: true })

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
function setInteractive (on) {
  if (!win || win.isDestroyed()) return
  const next = settings.clickThrough ? !!on : true
  if (next === interactive) return
  interactive = next
  try {
    win.setIgnoreMouseEvents(!interactive, { forward: true })
  } catch (e) {
    log('切换鼠标穿透失败:', e.message)
  }
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

  uIOhook.on('keydown', (e) => {
    if (!settings.hotkeys) return
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

  // panel 不是互动，只是开关面板
  if (name === 'panel') {
    win?.webContents.send('pet:panel', { toggle: true })
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
    if (menuOpen) return
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

  // 窗口平时是 focusable:false（不抢焦点、不进 Alt+Tab），
  // 但重命名要打字，所以临时允许聚焦
  ipcMain.on('pet:need-focus', (_e, on) => {
    if (!win || win.isDestroyed()) return
    try {
      win.setFocusable(!!on)
      if (on) win.focus()
    } catch (e) {
      log('切换窗口可聚焦失败:', e.message)
    }
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
