'use strict'
/**
 * 全局钩子探针 —— 不依赖 Electron，单独验证 uiohook-napi 能不能收到键鼠事件。
 *
 *   node app/tools/hookprobe.js [输出文件]
 *
 * 桌宠「没反应」时，第一件要分清的事是：**钩子收不到事件**，还是
 * **收到了但渲染层没表现**。这个探针只回答前半个问题 ——
 * 它和桌宠用同一个库、同一个钩子，但不涉及任何规则、表情、音效。
 *
 * 三种结果的含义：
 *   keys/moves 在涨          → 钩子没问题，去查规则或渲染层（用桌宠的 DSHPET_INPUTDEBUG）
 *   全是 0                   → 事件根本没到进程：安全软件拦截、权限不足，
 *                              或者这台机器当前拒绝合成输入（见 tools/inputcheck.ps1）
 *   uIOhook.start() 抛异常   → 库没装好 / ABI 不匹配
 *
 * 给了输出文件时会同时写文件 —— 因为用 WMI / 计划任务启动时拿不到 stdout。
 */

const fs = require('fs')

const LOG = process.argv[2] || null
if (LOG) fs.writeFileSync(LOG, '')

function say (s) {
  if (LOG) fs.appendFileSync(LOG, s + '\n')
  console.log(s)
}

const { uIOhook } = require('uiohook-napi')

let keys = 0
let clicks = 0
let moves = 0
const codes = []

uIOhook.on('keydown', (e) => { keys++; if (codes.length < 40) codes.push(e.keycode) })
uIOhook.on('mousedown', () => { clicks++ })
uIOhook.on('mousemove', () => { moves++ })

say(`探针已启动 pid=${process.pid}`)
try {
  uIOhook.start()
  say('uIOhook.start() 正常返回')
} catch (e) {
  say('uIOhook.start() 抛异常: ' + e.message)
}

const SECONDS = 15
let tick = 0
const timer = setInterval(() => {
  tick++
  say(`t=${tick}s 键=${keys} 点击=${clicks} 移动=${moves} codes=[${codes.join(',')}]`)
  if (tick >= SECONDS) {
    clearInterval(timer)
    try { uIOhook.stop() } catch { /* ignore */ }
    process.exit(0)
  }
}, 1000)
