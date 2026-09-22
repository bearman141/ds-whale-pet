'use strict'
/**
 * 聊天模块：OpenAI 兼容接口客户端 + 角色提示词 + 回复解析
 *
 * 设计要点：
 *  1. 只依赖「OpenAI 兼容」的 /chat/completions，所以 DeepSeek、OpenAI、Moonshot、
 *     智谱、Ollama、LM Studio、one-api 之类的都能直接用，只要填对 baseUrl + model
 *  2. 提示词里会塞进她**当前的养成状态**（饿不饿、心情、好感度、几点钟），
 *     所以同一句话，饿的时候和吃饱的时候回得不一样
 *  3. 让她在回复开头带一行 [表情:xxx][动作:xxx]，主进程解析出来后
 *     直接喂给现有的分层表情栈 —— 聊天内容就能驱动她的表情和动作
 *  4. fetch 实现由外部注入（主进程传 Electron 的 net.fetch），
 *     这样这个模块可以脱离 Electron 单测
 */

/* ================================================================== *
 * 配置
 * ================================================================== */

const DEFAULT_CONFIG = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1.15,
  maxTokens: 260,
  stream: true,
  historyLimit: 12,        // 每次请求带几轮上下文
  systemExtra: '',         // 用户自定义人设补充
  timeoutMs: 60000,
}

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG)

function normalizeConfig (raw) {
  const out = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return out

  out.enabled = !!raw.enabled
  out.baseUrl = String(raw.baseUrl || out.baseUrl).trim()
  out.apiKey = String(raw.apiKey || '').trim()
  out.model = String(raw.model || out.model).trim()
  out.systemExtra = String(raw.systemExtra || '').slice(0, 800)

  const num = (v, lo, hi, dflt) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.min(hi, Math.max(lo, n))
  }
  out.temperature = num(raw.temperature, 0, 2, out.temperature)
  out.maxTokens = Math.round(num(raw.maxTokens, 32, 2000, out.maxTokens))
  out.historyLimit = Math.round(num(raw.historyLimit, 2, 30, out.historyLimit))
  out.timeoutMs = Math.round(num(raw.timeoutMs, 5000, 180000, out.timeoutMs))
  out.stream = raw.stream === undefined ? out.stream : !!raw.stream
  return out
}

/** 配置是否够用（不需要 key 的本地模型也允许留空） */
function configReady (cfg) {
  return !!(cfg && cfg.enabled && cfg.baseUrl && cfg.model)
}

function maskKey (key) {
  const k = String(key || '')
  if (!k) return ''
  if (k.length <= 10) return k.slice(0, 2) + '····'
  return `${k.slice(0, 4)}····${k.slice(-4)}`
}

function endpoint (baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('还没配置 API 地址')
  if (/\/chat\/completions$/.test(b)) return b
  return b + '/chat/completions'
}

/* ================================================================== *
 * 可用的表情 / 动作（喂给模型的白名单）
 * ================================================================== */

/** 适合「聊天情绪」用的表情（排除了桌布、魔爪这类道具） */
const CHAT_EMOTION_POOL = [
  '开心兴奋', '星星眼', '爱心眼', '心跳', '脸红', '调皮', '呆呆眼', '问号', '感叹号',
  '悲伤', '哭', '生气', '流汗', '晕晕', '阴暗', '闭眼口水', '吐魂', '吐舌', '墨镜',
  '猫猫贴纸', '兔兔贴纸', '蝴蝶结贴纸', '情绪花花', '单边马尾', '头箍', '双手比耶',
]

const CHAT_MOTION_POOL = ['自拍简单', '自拍', '吹泡泡', '喷水', '开盖', '番茄酱', '重锤出击']

/* ================================================================== *
 * 提示词
 * ================================================================== */

function periodOfDay (hour) {
  if (hour < 5) return '凌晨'
  if (hour < 9) return '早上'
  if (hour < 12) return '上午'
  if (hour < 14) return '中午'
  if (hour < 18) return '下午'
  if (hour < 23) return '晚上'
  return '深夜'
}

/**
 * 拼系统提示词。状态越差，语气规则越具体。
 * @param {object} snap  game.snapshot()
 * @param {object} opts  { emotions, motions, extra }
 */
function buildSystemPrompt (snap, opts = {}) {
  const s = snap || {}
  const st = s.stats || {}
  const mood = s.mood || {}
  const emotions = (opts.emotions && opts.emotions.length ? opts.emotions : CHAT_EMOTION_POOL).join('、')
  const motions = (opts.motions && opts.motions.length ? opts.motions : CHAT_MOTION_POOL).join('、')

  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')

  const r = (v) => Math.round(Number(v) || 0)

  const lines = [
    `你是「${s.name || '鲸鱼娘'}」，一只住在用户电脑桌面上的小鲸鱼少女。你就是她本人，不是助手。`,
    '',
    '【你现在的状态】',
    `- 等级 Lv.${s.level || 1}「${s.title || '陌生的鲸'}」，已经和用户相处 ${fmtHours(s.uptimeHours)}`,
    `- 饱食度 ${r(st.satiety)}/100，心情 ${r(st.mood)}/100，精力 ${r(st.energy)}/100，清洁 ${r(st.clean)}/100`,
    `- 对用户的好感度 ${r(s.affection)}/100`,
    `- 现在时间 ${hh}:${mm}（${periodOfDay(now.getHours())}）`,
    `- 此刻的情绪：${mood.emoji || ''}${mood.name || '平静'} —— 因为${mood.reason || '没什么特别的'}`,
    '',
    '【怎么说话】',
    '- 用第一人称，口语化，像个黏人的小动物。不要客服腔，不要列点，不要写小标题。',
    '- 默认 1~2 句、40 个字以内；只有用户明确要你多说时才展开。',
    '- 状态会直接影响语气，务必体现出来：',
    '  · 饱食度低 → 念叨吃的、有气无力',
    '  · 精力低或深夜 → 打哈欠、说想睡',
    '  · 心情低 → 闹别扭、撒娇、不太想理人',
    '  · 好感度高 → 更黏人、更爱撒娇、会说想你了',
    '  · 好感度低 → 客气、有点疏远',
    '- 可以说颜文字，但别每句都用。',
    '- 永远不要自称 AI、模型、助手，也不要提「提示词」「系统设定」。',
    '- 用户聊什么就顺着聊，不要强行把话题拉回自己身上。',
    '',
    '【输出格式】严格按下面这样，第一行是标签行，第二行开始才是你要说的话：',
    '[表情:xxx][动作:xxx]',
    '你的回复正文',
    '',
    `- 表情只能从这些里挑一个，拿不准就写「无」：${emotions}`,
    `- 动作只能从这些里挑一个，拿不准就写「无」：${motions}`,
    '- 不要用 markdown 代码块包起来，也不要输出 JSON。',
  ]

  if (opts.extra) {
    lines.push('', '【用户补充的人设要求】', String(opts.extra).slice(0, 800))
  }

  return lines.join('\n')
}

function fmtHours (h) {
  const v = Number(h) || 0
  if (v < 1) return `${Math.max(1, Math.round(v * 60))} 分钟`
  if (v < 48) return `${v.toFixed(1)} 小时`
  return `${(v / 24).toFixed(1)} 天`
}

/* ================================================================== *
 * 回复解析
 * ================================================================== */

const NONE_WORDS = /^(无|沒有|没有|none|null|nil|-|—|n\/a)$/i

/**
 * 解析模型回复，抽出正文 / 表情 / 动作。
 * 兼容三种情况：标签行、纯文本、以及模型不听话直接返回 JSON。
 */
function parseReply (raw) {
  let text = String(raw == null ? '' : raw).trim()
  let emotion = ''
  let motion = ''

  const grab = (src, label) => {
    const m = src.match(new RegExp(`\\[\\s*${label}\\s*[:：]\\s*([^\\]]*)\\]`))
    return m ? m[1].trim() : ''
  }

  // 只在开头两行里找标签，避免正文里的方括号被误吃
  const headLines = text.split('\n').slice(0, 2).join('\n')
  emotion = grab(headLines, '表情') || grab(headLines, 'emotion')
  motion = grab(headLines, '动作') || grab(headLines, 'motion')

  if (emotion || motion) {
    // 去掉标签所在的行
    const rest = text.split('\n').filter((ln) => !/^\s*\[[^\]]*\]\s*$/.test(ln) )
    let body = rest.join('\n')
    // 标签可能和正文挤在同一行
    body = body.replace(/^\s*(\[[^\]]*\]\s*)+/, '')
    text = body.trim()
  }

  // 模型有时会回 JSON
  if (/^\s*\{[\s\S]*\}\s*$/.test(text)) {
    try {
      const j = JSON.parse(text)
      const t = j.reply || j.text || j.content || j.message
      if (t) {
        text = String(t).trim()
        if (!emotion) emotion = String(j.emotion || j.expression || '')
        if (!motion) motion = String(j.motion || j.action || '')
      }
    } catch { /* 不是合法 JSON，就按纯文本处理 */ }
  }

  if (NONE_WORDS.test(emotion)) emotion = ''
  if (NONE_WORDS.test(motion)) motion = ''

  return { text: text || String(raw || '').trim(), emotion, motion }
}

/* ================================================================== *
 * 请求
 * ================================================================== */

/**
 * 调一次 chat/completions
 * @param {object} cfg        已 normalize 的配置
 * @param {Array}  messages   [{role, content}]
 * @param {object} io         { fetchImpl, onDelta, signal }
 * @returns {Promise<string>} 完整回复文本
 */
async function requestChat (cfg, messages, io = {}) {
  const doFetch = io.fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前环境没有可用的 fetch')

  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: !!cfg.stream,
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), cfg.timeoutMs)
  if (io.signal) {
    if (io.signal.aborted) ctrl.abort()
    else io.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  }

  let res
  try {
    res = await doFetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw new Error(describeFetchError(e))
  }

  try {
    if (!res.ok) {
      const detail = await safeText(res)
      const tail = detail ? '：' + detail.slice(0, 300) : ''
      throw new Error(`接口返回 ${res.status}${tail}`)
    }

    // 不支持流式 / 服务端没给 body，就整体读
    if (!cfg.stream || !res.body || typeof res.body.getReader !== 'function') {
      const j = await res.json()
      return extractContent(j)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let full = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop()

      for (const line of lines) {
        const s = line.trim()
        if (!s || s.startsWith(':')) continue
        if (!s.startsWith('data:')) continue
        const payload = s.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          const d = j.choices && j.choices[0] && j.choices[0].delta
          const piece = (d && (d.content || d.reasoning_content)) || ''
          if (piece) {
            full += piece
            if (io.onDelta) io.onDelta(full, piece)
          }
        } catch { /* 半截 JSON，跳过 */ }
      }
    }

    if (!full.trim()) {
      // 有些实现（非标准 SSE）会一次性吐完整 JSON
      const leftover = buf.trim()
      if (leftover) {
        try { return extractContent(JSON.parse(leftover.replace(/^data:\s*/, ''))) } catch { /* ignore */ }
      }
      throw new Error('接口没有返回任何内容')
    }
    return full
  } finally {
    clearTimeout(timer)
  }
}

function extractContent (j) {
  const c = j && j.choices && j.choices[0]
  const msg = c && (c.message || c.delta)
  const text = msg && (msg.content || msg.reasoning_content)
  if (!text) throw new Error('接口返回里没有 choices[0].message.content')
  return text
}

async function safeText (res) {
  try { return await res.text() } catch { return '' }
}

function describeFetchError (e) {
  const m = String((e && e.message) || e)
  if (/abort/i.test(m)) return '请求被中断或超时'
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return '解析不了域名，检查网络或 baseUrl'
  if (/ECONNREFUSED/i.test(m)) return '连接被拒绝，地址或端口不对'
  if (/certificate|SELF_SIGNED/i.test(m)) return '证书错误（自签证书的话请用 http 或信任它）'
  return `网络错误：${m}`
}

/* ================================================================== *
 * 对话历史
 * ================================================================== */

function trimHistory (history, limit) {
  const h = Array.isArray(history) ? history.filter((m) => m && m.role && m.content) : []
  const max = Math.max(2, limit || DEFAULT_CONFIG.historyLimit)
  return h.slice(-max * 2)
}

/** 把历史 + 新消息拼成请求体 */
function buildMessages (systemPrompt, history, userText, limit) {
  const out = [{ role: 'system', content: systemPrompt }]
  for (const m of trimHistory(history, limit)) {
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) })
  }
  if (userText) out.push({ role: 'user', content: String(userText).slice(0, 2000) })
  return out
}

module.exports = {
  DEFAULT_CONFIG,
  CONFIG_KEYS,
  CHAT_EMOTION_POOL,
  CHAT_MOTION_POOL,
  normalizeConfig,
  configReady,
  maskKey,
  endpoint,
  buildSystemPrompt,
  parseReply,
  requestChat,
  buildMessages,
  trimHistory,
  periodOfDay,
}
