'use strict'
/**
 * 输入联动引擎（纯逻辑，不依赖 Electron / DOM，可以直接单测）
 *
 * 思路参考 BongoCat：桌宠跟着你**真实的键鼠操作**做反应，而不是靠一套养成数值。
 *
 * 但规则引擎的形状我沿用了原来养成系统那一套 —— 从高优先级往下找第一条成立的
 * 反应，条件一变表情/台词立刻跟着变。只是把条件从「饱食度 < 28」换成了
 * 「打字速度 ≥ 5 键/秒」「空闲超过 10 分钟」这类真实输入信号。
 *
 * 设计上刻意**克制**：打字本身不触发表情（只给一个跟手的节拍脉冲），
 * 只有「明显在猛敲」「在看别处」「刚开始点」「刚回来」这些状态才出声。
 */

/* ================================================================== *
 * 参数
 * ================================================================== */

const WINDOW_MS = 4000          // 滑动窗口：只统计最近 4 秒
const RATE_MS = 2000            // 打字速度按最近 2 秒算
const BURST_MS = 600            // 爆发判定窗口
const CLICK_MS = 2500           // 连点判定窗口
const WHEEL_MS = 2000           // 滚轮判定窗口
const WAKE_IDLE_MS = 90000      // 空闲超过 90 秒再动，算「刚回来」
const SLEEP_IDLE_MS = 600000    // 10 分钟没动静 → 睡着
const DOZE_IDLE_MS = 150000     // 2.5 分钟没动静 → 犯困
const MIN_DWELL_MS = 1200       // 反应最小驻留时间（防阈值抖动导致表情闪烁）

/* 打字速度档位（键/秒） */
const RATE_EXCITED = 4.0        // 调到 4.0：5.0 对普通人偏难触发，反馈太少见
const RATE_TYPING = 0.8

/* ================================================================== *
 * 反应规则
 *
 * when(stats, ctx) 成立即生效；从上往下第一条命中的胜出。
 * ================================================================== */

const REACTIONS = [
  {
    id: 'sleeping', priority: 100, emoji: '💤', name: '睡着了', sfx: null,
    when: (s) => s.idleSeconds > SLEEP_IDLE_MS / 1000,
    reason: '你已经 10 分钟没碰键鼠了',
    expressions: ['闭眼口水'],
    bubbles: ['Zzz……', '（睡得很香）', '（翻了个身）'],
    motions: [],
    pulse: 0,
  },
  {
    id: 'dozing', priority: 80, emoji: '😪', name: '犯困', sfx: 'sleepy',
    // 深夜也要「相对安静」才算犯困 —— 否则凌晨三点猛敲键盘她还在打哈欠，很出戏
    when: (s, c) => s.idleSeconds > DOZE_IDLE_MS / 1000 || (c.lateNight && s.idleSeconds > 30),
    reason: '有点安静，或者是深夜',
    expressions: ['晕晕'],
    bubbles: ['好困……', '（打了个哈欠）', '你还回来吗……'],
    motions: [],
    pulse: 0.4,
  },
  {
    id: 'back', priority: 75, emoji: '❗', name: '你回来啦', sfx: 'wake',
    when: (s) => s.wokeSecondsAgo !== null && s.wokeSecondsAgo < 6,
    reason: '你离开一阵子又动了键鼠',
    expressions: ['感叹号'],
    bubbles: ['诶！你回来啦', '（一下子精神了）', '想你！'],
    motions: [],
    pulse: 1.4,
  },
  {
    id: 'excited', priority: 70, emoji: '🤩', name: '被你带嗨了', sfx: 'happy',
    when: (s) => s.keysPerSec >= RATE_EXCITED,
    reason: '你打字快得飞起（≥ 5 键/秒）',
    expressions: ['星星眼'],
    bubbles: ['哇，好快！', '（跟着你的节奏抖）', '手速好猛！'],
    motions: ['自拍简单'],
    pulse: 1.8,
  },
  {
    id: 'working', priority: 60, emoji: '⌨️', name: '在陪你打字', sfx: null,
    when: (s) => s.keysPerSec >= RATE_TYPING,
    reason: '你正在敲键盘',
    expressions: [],
    bubbles: [],
    motions: [],
    pulse: 1.0,
  },
  {
    id: 'clicky', priority: 50, emoji: '👆', name: '被戳了', sfx: 'squeak',
    when: (s) => s.clicksRecent >= 3,
    reason: '你连着点鼠标',
    expressions: ['调皮'],
    bubbles: ['点什么呢～', '戳戳戳', '（盯着你的鼠标）'],
    motions: [],
    pulse: 1.2,
  },
  {
    id: 'scrolling', priority: 45, emoji: '🌀', name: '跟着滚', sfx: null,
    when: (s) => s.wheelRecent > 0,
    reason: '你在滚轮',
    expressions: ['问号'],
    bubbles: ['（跟着滚上去）', '看什么呢？'],
    motions: [],
    pulse: 0.9,
  },
  {
    id: 'idle', priority: 0, emoji: '🐋', name: '陪着你', sfx: null,
    when: () => true,
    reason: '没什么特别的输入',
    expressions: [],
    bubbles: ['……', '（安静待着）'],
    motions: [],
    pulse: 0.7,
  },
]

/* ================================================================== *
 * 工具
 * ================================================================== */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

function prune (arr, now, keepMs) {
  const cut = now - keepMs
  let i = 0
  while (i < arr.length && arr[i] < cut) i++
  if (i > 0) arr.splice(0, i)
  return arr
}

function countSince (arr, now, ms) {
  const cut = now - ms
  let n = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] >= cut) n++
    else break
  }
  return n
}

/* ================================================================== *
 * 追踪器
 * ================================================================== */

class InputTracker {
  constructor (now = Date.now()) {
    this.keys = []          // 按键时间戳
    this.clicks = []
    this.wheels = []
    this.lastInput = now
    this.wokeAt = 0         // 最近一次「从长空闲回来」的时刻，0 = 没有
    this.reaction = REACTIONS[REACTIONS.length - 1]
    this._lastId = null
    this._changedAt = 0
  }

  /* ---------- 喂事件 ---------- */
  _touch (now) {
    const idle = now - this.lastInput
    if (idle > WAKE_IDLE_MS) this.wokeAt = now
    this.lastInput = now
  }

  key (now = Date.now()) {
    this._touch(now)
    this.keys.push(now)
    prune(this.keys, now, WINDOW_MS)
  }

  click (now = Date.now()) {
    this._touch(now)
    this.clicks.push(now)
    prune(this.clicks, now, WINDOW_MS)
  }

  wheel (now = Date.now()) {
    this._touch(now)
    this.wheels.push(now)
    prune(this.wheels, now, WINDOW_MS)
  }

  /** 鼠标移动：只算「还活着」，不计入速度，避免指针一动就当你在忙 */
  move (now = Date.now()) {
    if (now - this.lastInput > WAKE_IDLE_MS) this.wokeAt = now
    this.lastInput = now
  }

  /* ---------- 统计 ---------- */
  snapshot (now = Date.now()) {
    prune(this.keys, now, WINDOW_MS)
    prune(this.clicks, now, WINDOW_MS)
    prune(this.wheels, now, WINDOW_MS)

    const keyCount = countSince(this.keys, now, RATE_MS)
    const d = new Date(now)
    const hour = d.getHours()

    return {
      keysPerSec: Math.round((keyCount / (RATE_MS / 1000)) * 10) / 10,
      burst: countSince(this.keys, now, BURST_MS),
      clicksRecent: countSince(this.clicks, now, CLICK_MS),
      wheelRecent: countSince(this.wheels, now, WHEEL_MS),
      idleSeconds: Math.round((now - this.lastInput) / 1000),
      wokeSecondsAgo: this.wokeAt ? Math.round((now - this.wokeAt) / 1000) : null,
      hour,
      lateNight: hour >= 1 && hour < 6,
    }
  }

  /* ---------- 推导反应 ---------- */
  evaluate (now = Date.now()) {
    const stats = this.snapshot(now)
    const ctx = { now, hour: stats.hour, lateNight: stats.lateNight }

    let hit = null
    for (const rule of REACTIONS) {
      let ok = false
      try { ok = !!rule.when(stats, ctx) } catch { ok = false }
      if (ok) { hit = rule; break }
    }
    if (!hit) hit = REACTIONS[REACTIONS.length - 1]

    if (hit.id === this._lastId) {
      return { rule: this.reaction, stats, changed: false }
    }

    // 迟滞：**升级**（切到更高优先级的反应）立刻生效，
    // **降级**才需要等满最小驻留时间。
    //
    // 一开始我让驻留对所有切换生效，结果是「你刚开始打字，她 1.2 秒后才理你」。
    // 只对降级迟滞就同时解决了两个问题：反应及时 + 阈值抖动不闪。
    const escalating = !this.reaction || hit.priority > this.reaction.priority
    if (!escalating && this._lastId !== null && now - this._changedAt < MIN_DWELL_MS) {
      return { rule: this.reaction, stats, changed: false }
    }

    this.reaction = hit
    this._lastId = hit.id
    this._changedAt = now
    return { rule: hit, stats, changed: true }
  }

  /** 该不该出声（bubble / 音效）—— 克制：只在状态切换时给一次 */
  greeting (now = Date.now()) {
    const r = this.reaction
    return { text: pick(r.bubbles), sfx: r.sfx || null }
  }

  /** 跟手节拍：当前反应下每次按键应该抖多少 */
  pulseGain () {
    return this.reaction ? this.reaction.pulse : 1
  }
}

module.exports = {
  InputTracker,
  REACTIONS,
  RATE_EXCITED,
  RATE_TYPING,
  SLEEP_IDLE_MS,
  DOZE_IDLE_MS,
  WAKE_IDLE_MS,
  MIN_DWELL_MS,
  clamp,
  pick,
  countSince,
  prune,
}
