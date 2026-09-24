'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  /** 渲染层用它决定要不要打调试日志（preload 能读到 process.env） */
  inputDebug: !!process.env.DSHPET_INPUTDEBUG,

  init: () => ipcRenderer.invoke('pet:init'),

  /** 指针是否落在模型不透明像素上 */
  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),
  /** 拖动结束，保存锚点位置 */
  savePosition: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  /** 滚轮调整大小，持久化 */
  setHeight: (h) => ipcRenderer.send('pet:height', h),
  /** 右键 -> 原生菜单 */
  openMenu: () => ipcRenderer.send('pet:contextmenu'),
  quit: () => ipcRenderer.send('pet:quit'),
  log: (msg) => ipcRenderer.send('pet:log', String(msg)),

  /* ---- 输入联动 ---- */
  needFocus: (on) => ipcRenderer.send('pet:need-focus', !!on),
  /** 光标是否在面板上（决定窗口要不要允许被激活） */
  setPanelHover: (on) => ipcRenderer.send('pet:panel-hover', !!on),
  /** 当前反应（跟随时机：打字/点击/空闲/回来…） */
  onReact: (fn) => ipcRenderer.on('pet:react', (_e, r) => fn(r)),
  /** 每一次按键的跟手节拍 */
  onKeyPulse: (fn) => ipcRenderer.on('pet:keypulse', (_e, p) => fn(p)),
  onEvents: (fn) => ipcRenderer.on('pet:events', (_e, ev) => fn(ev)),

  /* ---- 聊天 ---- */
  chatInit: () => ipcRenderer.invoke('pet:chat-init'),
  chatSend: (text) => ipcRenderer.invoke('pet:chat-send', String(text == null ? '' : text)),
  chatSaveConfig: (patch) => ipcRenderer.invoke('pet:chat-save-config', patch),
  chatTest: () => ipcRenderer.invoke('pet:chat-test'),
  chatClear: () => ipcRenderer.send('pet:chat-clear'),
  onChatPanel: (fn) => ipcRenderer.on('pet:chatpanel', (_e, p) => fn(p)),
  onChatMessage: (fn) => ipcRenderer.on('pet:chat-message', (_e, m) => fn(m)),
  onChatDelta: (fn) => ipcRenderer.on('pet:chat-delta', (_e, p) => fn(p)),
  onChatReply: (fn) => ipcRenderer.on('pet:chat-reply', (_e, p) => fn(p)),
  onChatThinking: (fn) => ipcRenderer.on('pet:chat-thinking', (_e, p) => fn(p)),
  onChatCleared: (fn) => ipcRenderer.on('pet:chat-cleared', (_e, p) => fn(p)),

  onAction: (fn) => ipcRenderer.on('pet:action', (_e, a) => fn(a)),
  onSize: (fn) => ipcRenderer.on('pet:size', (_e, h) => fn(h)),
  onPosition: (fn) => ipcRenderer.on('pet:position', (_e, p) => fn(p)),
  onWorkArea: (fn) => ipcRenderer.on('pet:workArea', (_e, wa) => fn(wa)),
  /** 可交互期间主进程轮询来的真实光标位置（此时 mousemove 不再转发） */
  onCursor: (fn) => ipcRenderer.on('pet:cursor', (_e, p) => fn(p)),
  onBubbleSetting: (fn) => ipcRenderer.on('pet:bubbleSetting', (_e, on) => fn(on)),
  /** 宠物旁边常驻状态条的内容（打字速度等） */
  onHud: (fn) => ipcRenderer.on('pet:hud', (_e, h) => fn(h)),
  onHudSetting: (fn) => ipcRenderer.on('pet:hudSetting', (_e, on) => fn(on)),

  /* ---- 其他设置（三级窗口） ---- */
  onSettingsPanel: (fn) => ipcRenderer.on('pet:settings-panel', (_e, p) => fn(p)),
  onSettingsChanged: (fn) => ipcRenderer.on('pet:settings-changed', (_e, s) => fn(s)),
  settingsGet: () => ipcRenderer.invoke('pet:settings-get'),
  settingsSet: (key, value) => ipcRenderer.send('pet:settings-set', { key, value }),
  settingsDo: (what) => ipcRenderer.send('pet:settings-do', { what }),

  /* ---- 调试抓图 ---- */
  onShot: (fn) => ipcRenderer.on('pet:shot', (_e, spec) => fn(spec)),
  saveShot: (payload) => ipcRenderer.send('pet:shot-save', payload),
})
