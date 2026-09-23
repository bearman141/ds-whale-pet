'use strict'
/**
 * 输入联动引擎测试
 *   node tools/test-input.js
 *
 * 全用假时钟驱动，不碰真实键鼠。
 */

const {
  InputTracker, REACTIONS, countSince, prune,
  RATE_EXCITED, RATE_TYPING, SLEEP_IDLE_MS, DOZE_IDLE_MS, WAKE_IDLE_MS, MIN_DWELL_MS,
} = require('../input')

let pass = 0
let fail = 0
function ok (cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) } else {
    fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}
function eq (a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`) }
function section (t) { console.log('\n=== ' + t + ' ===') }

// 基准时钟固定成**本地时间下午 3 点**，否则跑在凌晨会让 lateNight 恒真、
// 把一堆测试都带偏（这个坑第一次跑就踩了）
const base = new Date(2026, 4, 28, 15, 0, 0)
let clock = base.getTime()
const at = (ms) => clock + ms

/* ------------------------------------------------------------------ */
section('工具函数')
{
  const a = [100, 200, 300, 400, 500]
  eq(countSince(a, 500, 250), 3, 'countSince 只数窗口内的')
  eq(countSince(a, 900, 250), 0, 'countSince 窗口外为 0')
  const b = [100, 200, 300]
  prune(b, 500, 250)   // 保留 >= 250
  eq(b.length, 1, 'prune 掉过期样本')
  eq(b[0], 300, 'prune 保留的是最后一个')
}

/* ------------------------------------------------------------------ */
section('静止状态')
{
  const t = new InputTracker(at(0))
  const r = t.evaluate(at(1000))
  eq(r.rule.id, 'idle', '一秒钟没输入 → 陪着你')
  eq(r.stats.keysPerSec, 0, '打字速度为 0')
  eq(r.stats.idleSeconds, 1, '空闲 1 秒')
}

/* ------------------------------------------------------------------ */
section('打字')
{
  const t = new InputTracker(at(0))
  // 1 键/秒，持续 3 秒 → working
  for (let i = 0; i < 3; i++) t.key(at(1000 + i * 1000))
  const slow = t.evaluate(at(3100))
  eq(slow.rule.id, 'working', '慢慢打字 → 在陪你打字')
  ok(slow.stats.keysPerSec >= RATE_TYPING, '速度过线', slow.stats.keysPerSec)

  // 猛敲：2 秒内 12 下 → excited
  const t2 = new InputTracker(at(0))
  for (let i = 0; i < 12; i++) t2.key(at(1000 + i * 160))
  const fast = t2.evaluate(at(2900))
  eq(fast.rule.id, 'excited', '猛敲 → 被你带嗨了')
  ok(fast.stats.keysPerSec >= RATE_EXCITED, '速度够高', fast.stats.keysPerSec)
  ok(fast.stats.burst >= 3, '爆发窗口内有按键', fast.stats.burst)

  // 打字本身不该主动冒台词（克制）
  const t3 = new InputTracker(at(0))
  for (let i = 0; i < 3; i++) t3.key(at(1000 + i * 1000))
  t3.evaluate(at(3100))
  eq(t3.reaction.bubbles.length, 0, 'working 状态没有台词（不打扰）')
  eq(t3.reaction.expressions.length, 0, 'working 状态不换表情')
  ok(t3.pulseGain() > 0, 'working 仍然有跟手节拍', t3.pulseGain())
}

/* ------------------------------------------------------------------ */
section('鼠标')
{
  const t = new InputTracker(at(0))
  t.click(at(1000)); t.click(at(1300)); t.click(at(1600))
  eq(t.evaluate(at(1700)).rule.id, 'clicky', '连点三下 → 被戳了')

  const t2 = new InputTracker(at(0))
  t2.click(at(1000))
  eq(t2.evaluate(at(1100)).rule.id !== 'clicky', true, '只点一下不算连点')

  const t3 = new InputTracker(at(0))
  t3.wheel(at(1000))
  eq(t3.evaluate(at(1100)).rule.id, 'scrolling', '滚轮 → 跟着滚')

  // 鼠标移动只算「还活着」，不该被当成在忙
  const t4 = new InputTracker(at(0))
  for (let i = 0; i < 20; i++) t4.move(at(1000 + i * 100))
  const r4 = t4.evaluate(at(3000))
  eq(r4.rule.id, 'idle', '光晃鼠标不算在忙')
  eq(r4.stats.idleSeconds, 0, '但确实刷新了活跃时间')
}

/* ------------------------------------------------------------------ */
section('空闲与睡觉')
{
  const t = new InputTracker(at(0))
  eq(t.evaluate(at(DOZE_IDLE_MS + 1000)).rule.id, 'dozing', '空闲 2.5 分钟 → 犯困')
  eq(t.evaluate(at(SLEEP_IDLE_MS + 1000)).rule.id, 'sleeping', '空闲 10 分钟 → 睡着了')

  // 深夜也犯困，但**必须相对安静**才算
  const night = new Date(at(0))
  night.setHours(3, 0, 0, 0)
  const tn = new InputTracker(night.getTime())
  eq(tn.evaluate(night.getTime() + 1000).rule.id === 'dozing', false, '凌晨 3 点但刚动过 → 不犯困')

  const tn2 = new InputTracker(night.getTime())
  tn2.key(night.getTime() - 60000)      // 一分钟前动过
  eq(tn2.evaluate(night.getTime()).rule.id, 'dozing', '凌晨 3 点且安静一分钟 → 犯困')

  // 凌晨也不该盖过猛敲键盘
  const tn3 = new InputTracker(night.getTime())
  for (let i = 0; i < 12; i++) tn3.key(night.getTime() + i * 160)
  eq(tn3.evaluate(night.getTime() + 1900).rule.id, 'excited', '凌晨猛敲键盘 → 照样被你带嗨')
}

/* ------------------------------------------------------------------ */
section('离开又回来')
{
  const t = new InputTracker(at(0))
  // 单独敲一下不算「在打字」（2 秒窗口内 0.5 键/秒，低于阈值）—— 这是刻意的
  t.key(at(1000))
  eq(t.evaluate(at(2000)).rule.id, 'idle', '只敲一下不算在打字')
  for (let i = 0; i < 3; i++) t.key(at(2100 + i * 400))
  eq(t.evaluate(at(3200)).rule.id, 'working', '连敲几下才算在打字')
  // 离开 2 分钟
  t.key(at(1000 + WAKE_IDLE_MS + 30000))
  const r = t.evaluate(at(1000 + WAKE_IDLE_MS + 31000))
  eq(r.rule.id, 'back', '离开一阵再动键鼠 → 你回来啦')
  ok(r.stats.wokeSecondsAgo !== null && r.stats.wokeSecondsAgo < 6, '刚醒来的秒数很小', r.stats.wokeSecondsAgo)
  eq(r.rule.sfx, 'wake', '回来时有起床音效')

  // 6 秒之后就恢复正常
  const later = t.evaluate(at(1000 + WAKE_IDLE_MS + 31000 + 7000))
  ok(later.rule.id === 'idle' || later.rule.id === 'dozing', '新鲜劲过了就回到普通状态', later.rule.id)
}

/* ------------------------------------------------------------------ */
section('规则表自身')
{
  const prios = REACTIONS.map((r) => r.priority)
  ok(prios.every((p, i) => i === 0 || prios[i - 1] >= p), '按优先级降序排列')
  ok(REACTIONS.every((r) => typeof r.when === 'function'), '每条都有 when()')
  ok(REACTIONS.every((r) => r.reason), '每条都有可解释的 reason')
  ok(REACTIONS.every((r) => typeof r.pulse === 'number'), '每条都有跟手脉冲系数')
  eq(REACTIONS[REACTIONS.length - 1].id, 'idle', '兜底规则是 idle')

  // 每条规则都要可达（否则就是死规则）
  const unreachable = []
  const setups = {
    sleeping: (t) => { /* 靠空闲时间 */ },
    dozing: (t) => { },
    excited: (t) => { for (let i = 0; i < 14; i++) t.key(at(1000 + i * 140)) },
    working: (t) => { for (let i = 0; i < 3; i++) t.key(at(1000 + i * 1000)) },
    clicky: (t) => { t.click(at(1000)); t.click(at(1300)); t.click(at(1600)) },
    scrolling: (t) => { t.wheel(at(1000)) },
    back: (t) => { t.key(at(1000)); t.key(at(1000 + WAKE_IDLE_MS + 30000)) },
    idle: () => { },
  }
  const whenAt = {
    sleeping: SLEEP_IDLE_MS + 2000,
    dozing: DOZE_IDLE_MS + 2000,
    excited: 2900, working: 3100, clicky: 1700, scrolling: 1100,
    back: 1000 + WAKE_IDLE_MS + 31000, idle: 500,
  }
  for (const rule of REACTIONS) {
    const t = new InputTracker(at(0))
    const setup = setups[rule.id]
    if (!setup) { unreachable.push(`${rule.id}(没写 setup)`); continue }
    setup(t)
    const hit = t.evaluate(at(whenAt[rule.id] || 1000))
    if (hit.rule.id !== rule.id) unreachable.push(`${rule.id}=>${hit.rule.id}`)
  }
  ok(unreachable.length === 0, '每条反应规则都可达', unreachable)
}

/* ------------------------------------------------------------------ */
section('状态切换只报一次')
{
  const t = new InputTracker(at(0))
  const a = t.evaluate(at(1000))
  const b = t.evaluate(at(1500))
  eq(a.changed, true, '第一次进入 idle 算变化')
  eq(b.changed, false, '同一状态不重复报')

  for (let i = 0; i < 4; i++) t.key(at(1600 + i * 800))
  const c = t.evaluate(at(5000))
  eq(c.changed, true, '切到 typing 算变化')
  eq(t.evaluate(at(5200)).changed, false, '再评估不算变化')
}

/* ------------------------------------------------------------------ */
section('最小驻留（防表情闪烁）')
{
  const t = new InputTracker(at(0))
  eq(t.evaluate(at(1000)).rule.id, 'idle', '先进入 idle')

  // 三下点击刚好卡在阈值上
  t.click(at(1100)); t.click(at(1200)); t.click(at(1300))
  eq(t.evaluate(at(1400)).rule.id, 'clicky', '连点 → 被戳了（升级立刻生效）')

  // 计数掉到阈值以下，但还在驻留期内 → 不该立刻切走
  eq(t.evaluate(at(1500)).rule.id, 'clicky', '降级要等驻留期')
  eq(t.evaluate(at(2200)).rule.id, 'clicky', '驻留期内一直保持')

  // 过了驻留期、而且连点统计窗口也过期之后，才该放行
  // （CLICK_MS=2500，最后一次点击在 1300，所以 3800 之后才算真的不连点了）
  const late = t.evaluate(at(3900))
  ok(late.rule.id !== 'clicky', '驻留期 + 统计窗口都过期后恢复正常判定', late.rule.id)

  // 「升级立刻生效」这条要单独验：从 idle 直接开始打字，不该被拖 1.2 秒
  const t3 = new InputTracker(at(0))
  t3.evaluate(at(1000))
  for (let i = 0; i < 3; i++) t3.key(at(1100 + i * 300))
  eq(t3.evaluate(at(2000)).rule.id, 'working', '刚开始打字立刻就有反应（不被驻留拖住）')

  // 抖动场景：在阈值附近来回，切换次数应该很少
  const t2 = new InputTracker(at(0))
  t2.key(at(500))
  let switches = 0
  for (let i = 0; i < 40; i++) {
    const now = at(1000 + i * 200)
    if (i % 2 === 0) t2.click(now)
    if (t2.evaluate(now).changed) switches++
  }
  ok(switches <= 4, `抖动场景下切换次数很少（${switches} 次）`, switches)
}

/* ------------------------------------------------------------------ */
console.log(`\n================  ${pass} passed, ${fail} failed  ================`)
process.exit(fail ? 1 : 0)
