'use strict'
/**
 * DS鲸鱼娘 —— 养成引擎
 *
 * 纯逻辑模块，不依赖 Electron / DOM，可以直接 node 起来跑测试。
 *
 * 设计要点：
 *  1. 属性随真实时间衰减，关掉程序也算（离线最多补 8 小时）
 *  2. 「情绪」不是随机的，而是由一组**条件规则**（MOOD_RULES）实时推导出来的。
 *     条件一变，表情/台词/动作立刻跟着变 —— 这就是条件驱动的表情切换
 *  3. 每个交互都有冷却和前置条件（吃饱了喂不进去、没力气玩不动），
 *     逼着你看状态做决策，而不是无脑连点
 *  4. tick() 里做自主行为：没人管的时候会自己发呆、玩、说话、犯困
 */

/* ================================================================== *
 * 常量
 * ================================================================== */

const STAT_KEYS = ['satiety', 'mood', 'energy', 'clean']

const STAT_META = {
  satiety: { label: '饱食度', color: '#ffb648', icon: '🍚' },
  mood: { label: '心情', color: '#ff7ba8', icon: '💗' },
  energy: { label: '精力', color: '#5ec8f5', icon: '⚡' },
  clean: { label: '清洁', color: '#8ad9a8', icon: '🫧' },
}

/** 每小时自然衰减（睡觉时 energy 反涨） */
const DECAY_PER_HOUR = {
  satiety: 4.2,
  energy: 3.0,
  clean: 2.1,
}

/** 离线最多补多少小时，避免上班一天回来直接饿死 */
const OFFLINE_CAP_HOURS = 8

const MAX_STAT = 100

/** 升到第 N 级所需的累计经验（LEVELS[0] 即 Lv.1 的门槛） */
const LEVELS = [0, 20, 55, 105, 175, 270, 395, 555, 760, 1015]
const MAX_LEVEL = LEVELS.length

const TITLES = [
  [1, '陌生的鲸'],
  [2, '点头之交'],
  [3, '有点眼熟'],
  [4, '朋友'],
  [5, '好朋友'],
  [6, '贴心崽'],
  [7, '黏人鲸'],
  [8, '小棉袄'],
  [9, '灵魂伴侣'],
  [10, '命中注定'],
]

/* ================================================================== *
 * 交互定义
 * ================================================================== */

const ACTIONS = {
  feed: {
    label: '喂食', icon: '🍚', cooldown: 45e3,
    effect: { satiety: 22, mood: 6, clean: -3 },
    exp: 6, affection: 1,
    block: (s) => (s.satiety > 94 ? '已经吃得很饱啦，再吃要撑到' : null),
    lines: ['呜哇！是蛋包饭！', '谢谢你～', '好吃！', '这个我喜欢！'],
    expressions: ['开心兴奋'], motion: '开盖',
  },
  play: {
    label: '玩耍', icon: '🎾', cooldown: 60e3,
    effect: { mood: 15, energy: -11, satiety: -4, clean: -4 },
    exp: 9, affection: 2,
    block: (s, ctx) => (s.energy < 15 ? '太累了……玩不动……' : ctx.sleeping ? '人家在睡觉呢' : null),
    lines: ['一起来玩！', '接住啦！', '嘿嘿嘿～', '再来一次！'],
    expressions: ['星星眼'], motion: '吹泡泡',
  },
  pet: {
    label: '摸摸头', icon: '🤚', cooldown: 3000,
    quietCooldown: true,          // 连点时不刷屏，静默吞掉
    effect: { mood: 4, affection: 1 },
    exp: 2, affection: 0,
    lines: ['呼噜呼噜～', '嗯……舒服', '嘿嘿', '再摸摸嘛'],
    expressions: ['脸红'],
  },
  clean: {
    label: '洗澡', icon: '🛁', cooldown: 120e3,
    effect: { clean: 42, mood: 3, energy: -4 },
    exp: 7, affection: 2,
    block: (s) => (s.clean > 92 ? '我现在很干净呀' : null),
    lines: ['泡泡！', '水温刚刚好～', '洗白白～', '别弄湿我的发箍！'],
    expressions: ['调皮'], motion: '喷水',
  },
  gift: {
    label: '送礼物', icon: '🎁', cooldown: 300e3,
    effect: { mood: 20, affection: 4, clean: 2 },
    exp: 16, affection: 0,
    lines: ['这个是送给我的吗！', '哇——好开心！', '我会好好收着的', '谢谢你一直陪着我'],
    expressions: ['心跳', '爱心眼'],
  },
  sleep: {
    label: '睡觉', icon: '💤', cooldown: 4e3,
    toggle: true,
    lines: ['那我睡啦……', '晚安～'],
    wakeLines: ['唔……天亮了吗', '我醒了！'],
  },
}

/* ================================================================== *
 * 情绪规则 —— 条件驱动表情的核心
 *
 * 每个 tick 从高优先级往下找第一条 when() 为真的规则，就是当前情绪。
 * 条件一变（饿了、困了、被冷落、深夜、玩嗨了），表情/台词/动作立刻跟着变。
 * ================================================================== */

const MOOD_RULES = [
  {
    id: 'sleeping', priority: 100, emoji: '💤', name: '睡觉中',
    when: (s, c) => c.sleeping,
    reason: '正在睡觉',
    expressions: ['闭眼口水'],
    bubbles: ['Zzz……', '（翻了个身）', '唔……别吵……'],
    idle: ['Idle'],
    autonomy: [],
  },
  {
    id: 'starving', priority: 95, emoji: '😵', name: '饿扁了',
    when: (s) => s.satiety < 12,
    reason: '饱食度低于 12',
    expressions: ['哭', '流汗'],
    bubbles: ['肚子……好空……', '我要饿死了……', '（虚弱地趴下）', '饭……饭……'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'bubble', text: '好饿……' },
      { kind: 'expression', target: '吐魂', ttl: 9000 },
    ],
  },
  {
    id: 'exhausted', priority: 88, emoji: '😪', name: '累瘫了',
    when: (s) => s.energy < 14,
    reason: '精力低于 14',
    expressions: ['晕晕', '闭眼口水'],
    bubbles: ['眼睛睁不开了……', '让我歇一会儿……', '（打哈欠）'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'bubble', text: '好困……' },
      { kind: 'expression', target: '流汗', ttl: 8000 },
    ],
  },
  {
    id: 'angry', priority: 80, emoji: '😠', name: '生气了',
    when: (s) => s.mood < 18,
    reason: '心情低于 18',
    expressions: ['生气'],
    bubbles: ['哼！不理你了！', '你都不管我！', '（背过身去）', '哄我！'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'motion', target: '重锤出击' },
      { kind: 'bubble', text: '哼！' },
    ],
  },
  {
    id: 'hungry', priority: 70, emoji: '🍚', name: '肚子饿了',
    when: (s) => s.satiety < 28,
    reason: '饱食度低于 28',
    expressions: ['流汗'],
    bubbles: ['肚子咕咕叫了……', '有吃的吗？', '想吃蛋包饭……', '（盯着你看）'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'bubble', text: '有点饿……' },
      { kind: 'expression', target: '问号', ttl: 7000 },
    ],
  },
  {
    id: 'dirty', priority: 62, emoji: '🫧', name: '有点脏',
    when: (s) => s.clean < 26,
    reason: '清洁低于 26',
    expressions: ['流汗'],
    bubbles: ['身上黏黏的……', '想洗澡……', '（抖了抖）'],
    idle: ['Idle'],
    autonomy: [{ kind: 'bubble', text: '想洗澡澡' }],
  },
  {
    id: 'lonely', priority: 56, emoji: '🥺', name: '被冷落了',
    when: (s, c) => c.idleMinutes > 45 && s.mood < 75,
    reason: '超过 45 分钟没人理',
    expressions: ['悲伤'],
    bubbles: ['你去哪了……', '好久没看到你了', '（望着屏幕角落）', '陪陪我嘛'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'bubble', text: '在吗……' },
      { kind: 'expression', target: '问号', ttl: 8000 },
      { kind: 'expression', target: '阴暗', ttl: 10000 },
    ],
  },
  {
    id: 'sad', priority: 50, emoji: '😢', name: '有点难过',
    when: (s) => s.mood < 36,
    reason: '心情低于 36',
    expressions: ['悲伤'],
    bubbles: ['呜……', '陪我一下好不好', '（小声）'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'bubble', text: '唔……' },
      { kind: 'expression', target: '哭', ttl: 7000 },
    ],
  },
  {
    id: 'night', priority: 42, emoji: '🌙', name: '深夜犯困',
    when: (s, c) => c.hour >= 23 || c.hour < 6,
    reason: '现在是深夜（23:00–06:00）',
    expressions: ['晕晕'],
    bubbles: ['这么晚了还不睡吗……', '（揉眼睛）', '陪你到天亮也可以哦'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'bubble', text: '好晚了……' },
      { kind: 'expression', target: '闭眼口水', ttl: 9000 },
    ],
  },
  {
    id: 'excited', priority: 34, emoji: '🤩', name: '超开心',
    when: (s, c) => s.mood > 85 && c.recentPlay,
    reason: '刚玩过而且心情很高',
    expressions: ['星星眼'],
    bubbles: ['今天超开心！', '嘿嘿嘿嘿～', '再来一次嘛！'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'motion', target: '自拍简单' },
      { kind: 'expression', target: '双手比耶', ttl: 8000 },
      { kind: 'motion', target: '吹泡泡' },
    ],
  },
  {
    id: 'happy', priority: 24, emoji: '😊', name: '心情不错',
    when: (s) => s.mood > 74,
    reason: '心情高于 74',
    expressions: [],
    bubbles: ['今天也在一起～', '心情很好！', '要不要摸摸我'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'expression', target: '心跳', ttl: 6000 },
      { kind: 'motion', target: '自拍简单' },
      { kind: 'expression', target: '猫猫贴纸', ttl: 12000 },
      { kind: 'bubble', text: '嘿嘿～' },
    ],
  },
  {
    id: 'content', priority: 12, emoji: '🙂', name: '平静',
    when: (s) => s.mood > 55,
    reason: '心情高于 55',
    expressions: [],
    bubbles: ['嗯～', '在的在的', '（看着你）'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'expression', target: '墨镜', ttl: 15000 },
      { kind: 'motion', target: '吹泡泡' },
      { kind: 'expression', target: '蝴蝶结贴纸', ttl: 12000 },
      { kind: 'bubble', text: '今天天气不错' },
    ],
  },
  {
    id: 'normal', priority: 0, emoji: '🐋', name: '发呆',
    when: () => true,
    reason: '没有触发任何特殊条件',
    expressions: [],
    bubbles: ['……', '（发呆）', '你在忙吗'],
    idle: ['Idle'],
    autonomy: [
      { kind: 'motion', target: '喷水' },
      { kind: 'expression', target: '呆呆眼', ttl: 8000 },
      { kind: 'motion', target: '自拍' },
      { kind: 'bubble', text: '唔……' },
      { kind: 'expression', target: '兔兔贴纸', ttl: 10000 },
    ],
  },
]

/* ================================================================== *
 * 工具
 * ================================================================== */

const clamp = (v, lo = 0, hi = 100) => (v < lo ? lo : v > hi ? hi : v)
const round1 = (v) => Math.round(v * 10) / 10
const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

function titleFor (level) {
  let t = TITLES[0][1]
  for (const [lv, name] of TITLES) if (level >= lv) t = name
  return t
}

function levelFromExp (exp) {
  let lv = 1
  for (let i = 0; i < LEVELS.length; i++) if (exp >= LEVELS[i]) lv = i + 1
  return Math.min(lv, MAX_LEVEL)
}

function expBounds (level) {
  const i = Math.min(Math.max(level, 1), MAX_LEVEL) - 1
  const cur = LEVELS[i]
  const isMax = i + 1 >= LEVELS.length
  const next = isMax ? cur : LEVELS[i + 1]
  return { cur, next, max: isMax }
}

/* ================================================================== *
 * 状态
 * ================================================================== */

function createState (now = Date.now()) {
  return {
    version: 1,
    name: '鲸鱼娘',
    birth: now,
    lastTick: now,
    lastInteract: now,
    lastPlay: 0,
    stats: { satiety: 80, mood: 75, energy: 90, clean: 85 },
    affection: 5,
    exp: 0,
    level: 1,
    sleeping: false,
    cooldowns: {},
    counters: { feed: 0, play: 0, pet: 0, clean: 0, gift: 0, chat: 0, levelUps: 0 },
    log: [],
  }
}

/* ================================================================== *
 * Game
 * ================================================================== */

class Game {
  constructor (state) {
    this.s = state || createState()
    this.mood = MOOD_RULES[MOOD_RULES.length - 1]
    // 用存档时间轴而不是墙钟，读档后也会很快「主动做点什么」
    this._lastAutonomy = this.s.lastTick || Date.now()
    this._nextAutonomy = this._rollAutonomyDelay()
    this._lastReason = null
    this.awarded = new Set()      // 已解锁的成就
  }

  /* ---------------- 上下文 ---------------- */
  context (now = Date.now()) {
    const d = new Date(now)
    return {
      now,
      hour: d.getHours(),
      sleeping: this.s.sleeping,
      idleMinutes: (now - this.s.lastInteract) / 60000,
      recentPlay: now - this.s.lastPlay < 120e3,
      night: d.getHours() >= 23 || d.getHours() < 6,
    }
  }

  /* ---------------- 情绪推导 ---------------- */
  evaluateMood (now = Date.now()) {
    const ctx = this.context(now)
    for (const rule of MOOD_RULES) {
      let ok = false
      try { ok = !!rule.when(this.s.stats, ctx, this.s) } catch { ok = false }
      if (ok) {
        const changed = !this.mood || this.mood.id !== rule.id
        this.mood = rule
        if (changed) this._lastReason = rule.reason
        return { rule, changed }
      }
    }
    return { rule: this.mood, changed: false }
  }

  /* ---------------- 主循环 ---------------- */
  /**
   * @param {number} now
   * @returns {{events:Array, changed:boolean}}
   */
  tick (now = Date.now()) {
    const events = []
    const s = this.s
    const elapsedMs = Math.max(0, now - s.lastTick)
    let hours = elapsedMs / 3600000

    if (hours > 0) {
      const offline = hours > 0.05      // 超过 3 分钟算一次「离线回归」
      hours = Math.min(hours, OFFLINE_CAP_HOURS)

      // 属性衰减
      s.stats.satiety -= DECAY_PER_HOUR.satiety * hours
      s.stats.clean -= DECAY_PER_HOUR.clean * hours
      if (s.sleeping) {
        s.stats.energy += 14 * hours            // 睡觉回精力
      } else {
        s.stats.energy -= DECAY_PER_HOUR.energy * hours
      }

      // 心情向「基线」回归：基线由其它属性 + 好感度决定
      const baseline = this.baselineMood()
      const k = Math.min(1, hours * 0.5)
      s.stats.mood += (baseline - s.stats.mood) * k

      // 被长期冷落 -> 好感度缓慢下降
      if (this.context(now).idleMinutes > 360 && s.stats.mood < 45) {
        s.affection -= 0.7 * hours
      }

      for (const k2 of STAT_KEYS) s.stats[k2] = clamp(s.stats[k2])
      s.affection = clamp(s.affection, 0, 100)

      s.lastTick = now

      if (offline && hours > 0.5) {
        events.push({
          type: 'log', icon: '🌙',
          text: `你离开了约 ${hours < 1 ? Math.round(hours * 60) + ' 分钟' : round1(hours) + ' 小时'}`,
        })
      }
    }

    // 精力耗尽自动睡着
    if (!s.sleeping && s.stats.energy <= 2) {
      s.sleeping = true
      events.push({ type: 'log', icon: '💤', text: '太累了，自己睡着了' })
      events.push({ type: 'bubble', text: '撑不住了……先睡了……' })
    }
    // 睡饱了自己醒
    if (s.sleeping && s.stats.energy >= 98) {
      s.sleeping = false
      events.push({ type: 'log', icon: '☀️', text: '睡饱了，自己醒了' })
      events.push({ type: 'bubble', text: '睡饱啦！精神超好！' })
      events.push({ type: 'expression', target: '开心兴奋', ttl: 5000 })
    }

    // 情绪重算
    const { rule, changed } = this.evaluateMood(now)
    if (changed) {
      events.push({ type: 'mood', mood: rule.id, name: rule.name, emoji: rule.emoji, reason: rule.reason })
    }

    // 自主行为
    const auto = this.maybeAutonomy(now)
    if (auto) events.push(auto)

    // 成就
    for (const a of this.checkAchievements()) {
      events.push({ type: 'log', icon: '🏆', text: `解锁成就：${a}` })
      events.push({ type: 'bubble', text: '诶？我好像变厉害了！' })
      events.push({ type: 'expression', target: '星星眼', ttl: 6000 })
    }

    return { events, changed: elapsedMs > 0 }
  }

  /** 心情基线：其它属性差、好感低，心情自然也好不起来 */
  baselineMood () {
    const s = this.s.stats
    let base = 55
    if (s.satiety < 30) base -= (30 - s.satiety) * 0.7
    if (s.energy < 30) base -= (30 - s.energy) * 0.5
    if (s.clean < 30) base -= (30 - s.clean) * 0.4
    base += (this.s.affection - 50) * 0.25
    return clamp(base, 0, 100)
  }

  /* ---------------- 自主行为 ---------------- */
  _rollAutonomyDelay () {
    return 25000 + Math.random() * 55000     // 25 ~ 80 秒
  }

  maybeAutonomy (now) {
    if (this.s.sleeping) return null
    if (now - this._lastAutonomy < this._nextAutonomy) return null
    this._lastAutonomy = now
    this._nextAutonomy = this._rollAutonomyDelay()

    const pool = this.mood.autonomy
    if (!pool || !pool.length) return null
    const pickOne = pick(pool)
    if (!pickOne) return null

    if (pickOne.kind === 'bubble') return { type: 'bubble', text: pickOne.text }
    if (pickOne.kind === 'motion') return { type: 'motion', target: pickOne.target, label: pickOne.target }
    if (pickOne.kind === 'expression') {
      return { type: 'expression', target: pickOne.target, ttl: pickOne.ttl || 8000, layer: 'mood' }
    }
    return null
  }

  /** 主动找你说句话（mood 变化时 / 手动戳的时候用） */
  speak (now = Date.now()) {
    this.evaluateMood(now)
    const text = pick(this.mood.bubbles)
    return text ? { type: 'bubble', text } : null
  }

  /* ---------------- 交互 ---------------- */
  canDo (name, now = Date.now()) {
    const a = ACTIONS[name]
    if (!a) return { ok: false, reason: '没有这个互动' }
    const cd = (this.s.cooldowns[name] || 0) - now
    if (cd > 0) return { ok: false, reason: `再等等（${Math.ceil(cd / 1000)} 秒）` }
    if (a.block) {
      const r = a.block(this.s.stats, this.context(now), this.s)
      if (r) return { ok: false, reason: r }
    }
    return { ok: true }
  }

  /**
   * 执行一次互动
   * @returns {{ok:boolean, reason?:string, events:Array}}
   */
  act (name, now = Date.now()) {
    const a = ACTIONS[name]
    if (!a) return { ok: false, reason: '没有这个互动', events: [] }

    const can = this.canDo(name, now)
    if (!can.ok) {
      // 连点类互动的冷却被拒时保持安静，不然气泡会刷屏
      const quiet = a.quietCooldown && /再等等/.test(can.reason || '')
      return {
        ok: false,
        reason: can.reason,
        events: quiet
          ? []
          : [
              { type: 'bubble', text: can.reason },
              { type: 'expression', target: '流汗', ttl: 3000, layer: 'event' },
            ],
      }
    }

    const events = []
    const s = this.s
    s.cooldowns[name] = now + (a.cooldown || 0)

    /* 睡觉是开关 */
    if (a.toggle) {
      s.sleeping = !s.sleeping
      const line = s.sleeping ? pick(a.lines) : pick(a.wakeLines)
      events.push({ type: 'log', icon: a.icon, text: s.sleeping ? '哄她睡觉了' : '把她叫醒了' })
      if (line) events.push({ type: 'bubble', text: line })
      if (!s.sleeping) events.push({ type: 'expression', target: '开心兴奋', ttl: 4000, layer: 'event' })
      s.lastInteract = now
      this.evaluateMood(now)
      return { ok: true, events }
    }

    /* 数值结算 */
    for (const [k, v] of Object.entries(a.effect || {})) {
      s.stats[k] = clamp(s.stats[k] + v)
    }
    if (a.affection) s.affection = clamp(s.affection + a.affection, 0, 100)
    s.counters[name] = (s.counters[name] || 0) + 1
    s.lastInteract = now
    if (name === 'play') s.lastPlay = now

    /* 经验 & 升级 */
    this._award(a.exp, now, events)

    /* 表现层 */
    events.push({ type: 'log', icon: a.icon, text: `${a.label}了` })
    const line = pick(a.lines)
    if (line) events.push({ type: 'bubble', text: line })
    if (a.expressions) {
      for (const e of a.expressions) {
        events.push({ type: 'expression', target: e, ttl: 5200, layer: 'event' })
      }
    }
    if (a.motion) events.push({ type: 'motion', target: a.motion, label: a.motion })

    // 交互后立刻结算成就，不用等到下一次 tick
    for (const ach of this.checkAchievements()) {
      events.push({ type: 'log', icon: '🏆', text: `解锁成就：${ach}` })
      events.push({ type: 'bubble', text: '诶？我好像变厉害了！' })
      events.push({ type: 'expression', target: '星星眼', ttl: 6000, layer: 'event' })
    }

    this.evaluateMood(now)
    return { ok: true, events }
  }

  /* ---------------- 经验 / 升级 ---------------- */
  /** 加经验并在升级时补上事件与奖励 */
  _award (exp, now, events) {
    const s = this.s
    if (!exp) return
    s.exp += exp
    const lv = levelFromExp(s.exp)
    if (lv <= s.level) return
    s.level = lv
    s.counters.levelUps = (s.counters.levelUps || 0) + 1
    events.push({ type: 'log', icon: '🎉', text: `升级到 Lv.${lv} ——「${titleFor(lv)}」` })
    events.push({ type: 'bubble', text: `升级了！Lv.${lv}「${titleFor(lv)}」` })
    events.push({ type: 'expression', target: '双手比耶', ttl: 6000, layer: 'event' })
    events.push({ type: 'motion', target: '自拍简单' })
    s.stats.mood = clamp(s.stats.mood + 10)
    s.affection = clamp(s.affection + 3, 0, 100)
    this._lastAutonomy = now
    this._nextAutonomy = 8000
  }

  /* ---------------- 聊天 ---------------- */
  /**
   * 用户跟她说了一句话。
   * 不管有没有奖励，都会刷新 lastInteract（所以聊天能治「被冷落」）。
   * 奖励本身有 15 秒冷却，防止刷好感。
   */
  noteChat (now = Date.now()) {
    const s = this.s
    s.lastInteract = now
    const events = []

    if (now < (s.cooldowns.chat || 0)) {
      this.evaluateMood(now)
      return { rewarded: false, events }
    }

    s.cooldowns.chat = now + 15e3
    s.counters.chat = (s.counters.chat || 0) + 1
    s.stats.mood = clamp(s.stats.mood + 2)
    s.affection = clamp(s.affection + 0.5, 0, 100)
    this._award(2, now, events)

    for (const ach of this.checkAchievements()) {
      events.push({ type: 'log', icon: '🏆', text: `解锁成就：${ach}` })
      events.push({ type: 'expression', target: '星星眼', ttl: 6000, layer: 'event' })
    }

    this.evaluateMood(now)
    return { rewarded: true, events }
  }

  /* ---------------- 成就 ---------------- */
  checkAchievements () {
    const s = this.s
    const list = []
    const add = (id, cond, text) => {
      if (this.awarded.has(id)) return
      if (!cond) return
      this.awarded.add(id)
      list.push(text)
    }
    add('firstFeed', s.counters.feed >= 1, '第一次投喂')
    add('feed20', s.counters.feed >= 20, '投喂 20 次')
    add('play10', s.counters.play >= 10, '一起玩 10 次')
    add('pet50', s.counters.pet >= 50, '被摸头 50 次')
    add('clean10', s.counters.clean >= 10, '洗了 10 次澡')
    add('gift5', s.counters.gift >= 5, '收到 5 份礼物')
    add('chat20', (s.counters.chat || 0) >= 20, '和她聊天 20 次')
    add('lv5', s.level >= 5, '到达 Lv.5')
    add('aff60', s.affection >= 60, '好感度 60')
    add('aff90', s.affection >= 90, '好感度 90')
    return list
  }

  /* ---------------- 快照 ---------------- */
  snapshot (now = Date.now()) {
    const s = this.s
    const { cur, next } = expBounds(s.level)
    const mood = this.mood || MOOD_RULES[MOOD_RULES.length - 1]
    return {
      name: s.name,
      level: s.level,
      title: titleFor(s.level),
      exp: s.exp,
      expCur: cur,
      expNext: next,
      affection: round1(s.affection),
      stats: Object.fromEntries(STAT_KEYS.map((k) => [k, round1(s.stats[k])])),
      sleeping: s.sleeping,
      mood: {
        id: mood.id,
        name: mood.name,
        emoji: mood.emoji,
        reason: this._lastReason || mood.reason,
        expressions: mood.expressions || [],
        bubbles: mood.bubbles || [],
      },
      cooldowns: Object.fromEntries(
        Object.entries(s.cooldowns).map(([k, v]) => [k, Math.max(0, Math.round(v - now))]),
      ),
      uptimeHours: round1((now - s.birth) / 3600000),
      idleMinutes: Math.round((now - s.lastInteract) / 60000),
      counters: { ...s.counters },
      log: s.log.slice(-40),
      actions: Object.fromEntries(
        Object.entries(ACTIONS).map(([k, a]) => [
          k,
          { label: a.label, icon: a.icon, cooldown: a.cooldown || 0, can: this.canDo(k, now).ok },
        ]),
      ),
      achievements: [...this.awarded],
    }
  }

  /** 面板/气泡里显示「为什么现在是这个表情」 */
  reasonText () {
    const m = this.mood
    return m ? `${m.emoji} ${m.name} · ${this._lastReason || m.reason}` : ''
  }

  pushLog (icon, text) {
    this.s.log.push({ t: Date.now(), icon, text })
    if (this.s.log.length > 80) this.s.log.splice(0, this.s.log.length - 80)
  }

  /* ---------------- 存读档 ---------------- */
  serialize () {
    return { ...this.s, awarded: [...this.awarded] }
  }

  static load (raw) {
    if (!raw || typeof raw !== 'object') return new Game()
    const base = createState()
    const s = {
      ...base,
      ...raw,
      stats: { ...base.stats, ...(raw.stats || {}) },
      counters: { ...base.counters, ...(raw.counters || {}) },
      cooldowns: { ...(raw.cooldowns || {}) },
      log: Array.isArray(raw.log) ? raw.log.slice(-80) : [],
    }
    for (const k of STAT_KEYS) s.stats[k] = clamp(Number(s.stats[k]) || 0)
    s.affection = clamp(Number(s.affection) || 0, 0, 100)
    s.exp = Math.max(0, Number(s.exp) || 0)
    s.level = levelFromExp(s.exp)
    const g = new Game(s)
    if (Array.isArray(raw.awarded)) g.awarded = new Set(raw.awarded)
    return g
  }
}

module.exports = {
  Game,
  createState,
  MOOD_RULES,
  ACTIONS,
  STAT_KEYS,
  STAT_META,
  LEVELS,
  MAX_LEVEL,
  TITLES,
  titleFor,
  levelFromExp,
  expBounds,
  clamp,
}
