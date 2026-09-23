'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
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
  /** 每一次鼠标按下（全局，不只是点在模型上） */
  onClickPulse: (fn) => ipcRenderer.on('pet:clickpulse', (_e, p) => fn(p)),
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
  onSfxSetting: (fn) => ipcRenderer.on('pet:sfxSetting', (_e, s) => fn(s)),
  onSfxTest: (fn) => ipcRenderer.on('pet:sfx-test', () => fn()),
})
