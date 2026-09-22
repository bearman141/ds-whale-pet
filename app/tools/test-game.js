'use strict'
/**
 * 养成引擎纯逻辑冒烟测试
 *   node tools/test-game.js
 *
 * 用一个假的时钟驱动，所以 Game 要用 createState(clock) 构造，
 * 让 lastTick / lastInteract 落在同一个时间轴上。
 */

const { Game, createState, MOOD_RULES, titleFor, levelFromExp, expBounds, MAX_LEVEL } = require('../game')

let pass = 0
let fail = 0

function ok (cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) } else {
    fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}
function section (t) { console.log('\n=== ' + t + ' ===') }

let clock = new Date('2026-03-01T14:00:00').getTime()
const advance = (ms) => { clock += ms; return clock }
const newGame = () => new Game(createState(clock))

/* ------------------------------------------------------------------ */
section('初始状态')
let g = newGame()
ok(g.s.level === 1, 'Lv.1')
ok(g.s.stats.satiety === 80, '初始饱食 80')
ok(g.evaluateMood(clock).rule.id === 'happy', '初始心情 75 → happy', g.mood.id)

/* ------------------------------------------------------------------ */
section('交互与冷却')
const r1 = g.act('feed', clock)
ok(r1.ok, '喂食成功')
ok(Math.abs(g.s.stats.satiety - 100) < 0.001, '饱食 80+22 被夹到 100', g.s.stats.satiety)
ok(r1.events.some((e) => e.type === 'log'), '产生日志事件')
ok(r1.events.some((e) => e.type === 'bubble'), '产生台词事件')
ok(r1.events.some((e) => e.type === 'expression'), '产生表情事件')

const r2 = g.act('feed', clock)
ok(!r2.ok, '冷却中再次喂食被拒', r2.reason)

const r3 = g.act('feed', advance(46e3))
ok(!r3.ok && /饱/.test(r3.reason || ''), '冷却过后仍被「吃太饱」拦住', r3.reason)

const r4 = g.act('play', clock)
ok(r4.ok, '玩耍成功')
ok(g.s.stats.energy < 90, '玩耍消耗精力', g.s.stats.energy)

/* ------------------------------------------------------------------ */
section('时间衰减 / 离线结算')
const before = { ...g.s.stats }
g.tick(advance(3 * 3600e3))
ok(g.s.stats.satiety < before.satiety, '饱食随时间下降', `${before.satiety} -> ${g.s.stats.satiety.toFixed(2)}`)
ok(g.s.stats.clean < before.clean, '清洁随时间下降')
ok(g.s.stats.satiety >= 0, '属性不会变成负数')

const g2 = newGame()
const s0 = g2.s.stats.satiety
g2.tick(clock + 40 * 3600e3)
const cappedHours = (s0 - g2.s.stats.satiety) / 4.2
ok(Math.abs(cappedHours - 8) < 0.2, '离线最多补 8 小时衰减', cappedHours.toFixed(2))

/* ------------------------------------------------------------------ */
section('条件驱动的情绪切换')
g = newGame()
g.s.stats.satiety = 50; g.s.stats.energy = 80; g.s.stats.clean = 80; g.s.stats.mood = 75
ok(g.evaluateMood(clock).rule.id === 'happy', '正常 → happy')

g.s.stats.satiety = 20
ok(g.evaluateMood(clock).rule.id === 'hungry', '饱食 20 → hungry')

g.s.stats.satiety = 5
ok(g.evaluateMood(clock).rule.id === 'starving', '饱食 5 → starving')

g.s.stats.satiety = 60; g.s.stats.energy = 10
ok(g.evaluateMood(clock).rule.id === 'exhausted', '精力 10 → exhausted')

g.s.stats.energy = 80; g.s.stats.mood = 10
ok(g.evaluateMood(clock).rule.id === 'angry', '心情 10 → angry')

g.s.stats.mood = 30
ok(g.evaluateMood(clock).rule.id === 'sad', '心情 30 → sad')

g.s.stats.mood = 60
g.s.lastInteract = clock - 60 * 60e3
ok(g.evaluateMood(clock).rule.id === 'lonely', '1 小时没互动 → lonely')

g.s.lastInteract = clock
g.s.sleeping = true
ok(g.evaluateMood(clock).rule.id === 'sleeping', '睡觉优先于其它一切')
ok(g.mood.expressions.length > 0, 'sleeping 情绪带表情', g.mood.expressions)

const midnight = new Date('2026-03-01T01:30:00').getTime()
g.s.sleeping = false
g.evaluateMood(midnight)
ok(g.mood.id === 'night', '凌晨 1:30 → night', g.mood.id)

ok(MOOD_RULES.every((r) => typeof r.when === 'function'), '所有规则都有 when()')
ok(MOOD_RULES.every((r) => r.reason), '所有规则都有可解释的 reason')
const prio = MOOD_RULES.map((r) => r.priority)
ok(prio.every((p, i) => i === 0 || prio[i - 1] >= p), '规则按优先级降序排列（不会互相遮蔽）')

/* 每条规则都能被触发（否则就是死规则） */
const triggers = {
  sleeping: (x) => { x.sleeping = true },
  starving: (x) => { x.stats.satiety = 5 },
  exhausted: (x) => { x.stats.energy = 5 },
  angry: (x) => { x.stats.mood = 5 },
  hungry: (x) => { x.stats.satiety = 20 },
  dirty: (x) => { x.stats.clean = 10 },
  lonely: (x) => { x.lastInteract = clock - 3600e3; x.stats.mood = 60 },
  sad: (x) => { x.stats.mood = 30 },
  night: null,
  excited: (x) => { x.stats.mood = 95; x.lastPlay = clock },
  happy: (x) => { x.stats.mood = 75 },
  content: (x) => { x.stats.mood = 60 },
  normal: (x) => { x.stats.mood = 40 },
}
let unreachable = []
for (const rule of MOOD_RULES) {
  const t = newGame()
  t.s.stats = { satiety: 90, mood: 75, energy: 95, clean: 90 }
  t.s.lastInteract = clock
  const at = rule.id === 'night' ? new Date('2026-03-01T02:00:00').getTime() : clock
  const setup = triggers[rule.id]
  if (setup) setup(t.s)
  const hit = t.evaluateMood(at)
  if (hit.rule.id !== rule.id) unreachable.push(`${rule.id}=>${hit.rule.id}`)
}
ok(unreachable.length === 0, '每条情绪规则都可达', unreachable)

/* ------------------------------------------------------------------ */
section('睡觉 / 精力')
g = newGame()
g.s.stats.energy = 3
g.act('sleep', clock)
ok(g.s.sleeping, '进入睡眠')
g.tick(advance(4 * 3600e3))
ok(g.s.stats.energy > 3, '睡觉回精力', g.s.stats.energy.toFixed(1))
g.act('sleep', advance(5e3))
ok(!g.s.sleeping, '可以叫醒')

g = newGame()
g.s.stats.energy = 1
g.tick(advance(1000))
ok(g.s.sleeping, '精力耗尽自动睡着')

g = newGame()
g.s.stats.energy = 99
g.s.sleeping = true
g.tick(advance(30 * 60e3))
ok(!g.s.sleeping, '睡饱了自动醒')

/* ------------------------------------------------------------------ */
section('等级 / 好感 / 成就')
ok(titleFor(1) === '陌生的鲸', 'Lv.1 称号')
ok(titleFor(MAX_LEVEL) === '命中注定', `Lv.${MAX_LEVEL} 称号`)
ok(levelFromExp(0) === 1, '0 经验 → Lv.1')
ok(levelFromExp(1015) === 10, '1015 经验 → Lv.10')
ok(levelFromExp(99999) === MAX_LEVEL, '经验溢出不会超过满级', MAX_LEVEL)
ok(expBounds(MAX_LEVEL).max === true && expBounds(MAX_LEVEL).next === expBounds(MAX_LEVEL).cur, '满级时经验区间不会除零')
ok(expBounds(1).next > expBounds(1).cur, '非满级经验区间正常')

g = newGame()
let lvEvents = 0
for (let i = 0; i < 60; i++) {
  const t = clock + i * 400e3
  const r = g.act(i % 2 ? 'play' : 'feed', t)
  if (r.events.some((e) => e.type === 'log' && /升级/.test(e.text))) lvEvents++
}
ok(lvEvents >= 2, `连续互动触发多次升级（${lvEvents} 次）`)
ok(g.s.level > 1, '等级提升', g.s.level)
ok(g.s.affection > 5, '好感度提升', g.s.affection)
ok(g.awarded.size > 0, '交互后立刻解锁成就', [...g.awarded])
ok(g.s.counters.feed > 0 && g.s.counters.play > 0, '交互计数正常')

/* ------------------------------------------------------------------ */
section('自主行为')
g = newGame()
g.s.stats.mood = 75
g.evaluateMood(clock)
let autonomous = 0
let t2 = clock
for (let i = 0; i < 400; i++) {
  t2 += 5000
  const { events } = g.tick(t2)
  if (events.some((e) => e.type === 'bubble' || e.type === 'expression' || e.type === 'motion')) autonomous++
}
ok(autonomous > 3, `会自己找事做（${autonomous} 次）`)

/* ------------------------------------------------------------------ */
section('连点保护')
g = newGame()
const p1 = g.act('pet', clock)
ok(p1.ok, '摸摸头成功')
const p2 = g.act('pet', clock + 200)
ok(!p2.ok, '冷却中再次摸摸头被拒')
ok(p2.events.length === 0, '摸摸头冷却被拒时静默（不刷气泡）', p2.events.length)

g.s.cooldowns.feed = 0
g.s.stats.satiety = 100
const f1 = g.act('feed', clock + 300)
ok(!f1.ok && f1.events.length > 0, '普通的「吃太饱」被拒时仍然有反馈气泡', f1.events.length)

/* ------------------------------------------------------------------ */
section('存档往返')
g = newGame()
g.act('feed', clock)
g.act('gift', clock)
g.s.name = '小鲸鱼'
const json = JSON.parse(JSON.stringify(g.serialize()))
const g3 = Game.load(json)
ok(g3.s.name === '小鲸鱼', '名字保留')
ok(Math.abs(g3.s.stats.satiety - g.s.stats.satiety) < 0.001, '属性保留')
ok(g3.s.exp === g.s.exp, '经验保留')
ok(g3.awarded.size === g.awarded.size, '成就保留')
ok(Game.load(null).s.level === 1, '损坏存档回退到新档')
ok(Game.load({ stats: { satiety: 999 } }).s.stats.satiety === 100, '越界数值被夹住')
ok(Game.load({ exp: -50 }).s.exp === 0, '负经验被夹住')

/* ------------------------------------------------------------------ */
section('快照可序列化')
g = newGame()
g.act('feed', clock)
g.tick(clock + 1000)
const snap = g.snapshot(clock)
ok(JSON.stringify(snap).length > 100, '快照是纯 JSON')
ok(typeof snap.mood.reason === 'string' && snap.mood.reason.length > 0, '快照带「为什么是这个表情」', snap.mood.reason)
ok(snap.actions && snap.actions.feed && typeof snap.actions.feed.can === 'boolean', '快照带互动可用性')
ok(snap.title && snap.expNext >= snap.expCur, '快照带等级/经验信息')

/* ------------------------------------------------------------------ */
console.log(`\n================  ${pass} passed, ${fail} failed  ================`)
process.exit(fail ? 1 : 0)
