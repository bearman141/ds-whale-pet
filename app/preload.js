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

  /* ---- 养成 ---- */
  gameAction: (name) => ipcRenderer.send('pet:game-action', String(name)),
  setName: (name) => ipcRenderer.send('pet:set-name', String(name)),
  gameReset: () => ipcRenderer.send('pet:game-reset'),
  needFocus: (on) => ipcRenderer.send('pet:need-focus', !!on),
  onGame: (fn) => ipcRenderer.on('pet:game', (_e, g) => fn(g)),
  onEvents: (fn) => ipcRenderer.on('pet:events', (_e, ev) => fn(ev)),
  onPanel: (fn) => ipcRenderer.on('pet:panel', (_e, p) => fn(p)),

  onAction: (fn) => ipcRenderer.on('pet:action', (_e, a) => fn(a)),
  onSize: (fn) => ipcRenderer.on('pet:size', (_e, h) => fn(h)),
  onPosition: (fn) => ipcRenderer.on('pet:position', (_e, p) => fn(p)),
  onWorkArea: (fn) => ipcRenderer.on('pet:workArea', (_e, wa) => fn(wa)),
  onBubbleSetting: (fn) => ipcRenderer.on('pet:bubbleSetting', (_e, on) => fn(on)),
})
