'use strict'
/**
 * 聊天模块纯逻辑测试（含 SSE 流式解析，用假的 fetch 驱动）
 *   node tools/test-chat.js
 */

const {
  DEFAULT_CONFIG, normalizeConfig, configReady, maskKey, endpoint,
  buildSystemPrompt, parseReply, requestChat, buildMessages, trimHistory, periodOfDay,
} = require('../chat')

let pass = 0
let fail = 0

function ok (cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) } else {
    fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}
function eq (a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`) }
function section (t) { console.log('\n=== ' + t + ' ===') }

/* ------------------------------------------------------------------ */
section('配置归一化')
const d = normalizeConfig(null)
eq(d.baseUrl, DEFAULT_CONFIG.baseUrl, '空配置回退到默认 baseUrl')
eq(d.enabled, false, '空配置默认关闭')
eq(d.stream, true, '默认开启流式')

const c1 = normalizeConfig({ enabled: 1, baseUrl: '  https://x.test/v1  ', model: ' m ', temperature: 9, maxTokens: 99999, historyLimit: 0 })
eq(c1.enabled, true, 'enabled 转成布尔')
eq(c1.baseUrl, 'https://x.test/v1', 'baseUrl 去空格')
eq(c1.model, 'm', 'model 去空格')
eq(c1.temperature, 2, 'temperature 夹到上限 2')
eq(c1.maxTokens, 2000, 'maxTokens 夹到上限')
eq(c1.historyLimit, 2, 'historyLimit 夹到下限 2')

eq(normalizeConfig({ temperature: 'abc' }).temperature, DEFAULT_CONFIG.temperature, 'NaN 回退默认')
eq(normalizeConfig({ systemExtra: 'x'.repeat(5000) }).systemExtra.length, 800, 'systemExtra 截断到 800')

ok(configReady(normalizeConfig({ enabled: true })), 'enabled + 默认地址即可用')
ok(!configReady(normalizeConfig({ enabled: false })), '未启用不可用')
ok(!configReady(normalizeConfig({ enabled: true, baseUrl: '   ' })), '地址为空不可用')

section('密钥掩码')
eq(maskKey(''), '', '空 key')
eq(maskKey('short'), 'sh····', '短 key')
eq(maskKey('sk-1234567890abcdef'), 'sk-1····cdef', '长 key 只留头尾')
ok(!maskKey('sk-1234567890abcdef').includes('567890'), '中间部分不泄露')

section('端点拼接')
eq(endpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions', '追加路径')
eq(endpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions', '去掉尾部斜杠')
eq(endpoint('https://x/v1/chat/completions'), 'https://x/v1/chat/completions', '已经是完整端点就不重复加')
let threw = false
try { endpoint('') } catch { threw = true }
ok(threw, '空地址抛错')

/* ------------------------------------------------------------------ */
section('提示词')
const snap = {
  name: '小鲸鱼', level: 4, title: '朋友', uptimeHours: 30,
  affection: 63.4,
  stats: { satiety: 18, mood: 30, energy: 77, clean: 88 },
  mood: { emoji: '🍚', name: '肚子饿了', reason: '饱食度低于 28' },
}
const sp = buildSystemPrompt(snap, { emotions: ['开心兴奋', '星星眼'], motions: ['自拍'], extra: '说话再随便一点' })

ok(sp.includes('小鲸鱼'), '提示词带上名字')
ok(sp.includes('Lv.4') && sp.includes('朋友'), '带上等级和称号')
ok(sp.includes('饱食度 18/100'), '带上饱食度', sp.match(/饱食度[^\n]*/)?.[0])
ok(sp.includes('好感度 63/100'), '带上好感度')
ok(sp.includes('肚子饿了') && sp.includes('饱食度低于 28'), '带上当前情绪和原因')
ok(sp.includes('开心兴奋') && sp.includes('星星眼'), '只列出给定的表情白名单')
ok(!sp.includes('魔爪'), '没把道具类表情写进去')
ok(sp.includes('自拍'), '带上动作白名单')
ok(sp.includes('说话再随便一点'), '带上用户补充人设')
ok(/\[表情:xxx\]\[动作:xxx\]/.test(sp), '明确给出输出格式')
ok(buildSystemPrompt(null).includes('鲸鱼娘'), '快照为空时不炸，用默认名字')

section('时段')
eq(periodOfDay(3), '凌晨', '3 点')
eq(periodOfDay(8), '早上', '8 点')
eq(periodOfDay(13), '中午', '13 点')
eq(periodOfDay(23), '深夜', '23 点')

/* ------------------------------------------------------------------ */
section('回复解析')
let r = parseReply('[表情:星星眼][动作:自拍]\n今天好开心呀！')
eq(r.text, '今天好开心呀！', '标准两行格式取正文')
eq(r.emotion, '星星眼', '取出表情')
eq(r.motion, '自拍', '取出动作')

r = parseReply('[表情:开心兴奋] 嘿嘿嘿')
eq(r.text, '嘿嘿嘿', '标签和正文同一行也能拆开')
eq(r.emotion, '开心兴奋', '同行标签取表情')

r = parseReply('[表情:无][动作:无]\n就是普通的一句话')
eq(r.emotion, '', '「无」当成没有表情')
eq(r.motion, '', '「无」当成没有动作')
eq(r.text, '就是普通的一句话', '正文不受影响')

r = parseReply('完全没有标签的回复')
eq(r.text, '完全没有标签的回复', '纯文本原样返回')
eq(r.emotion, '', '纯文本没有表情')

r = parseReply('{"reply":"哄好了","emotion":"脸红","motion":"自拍"}')
eq(r.text, '哄好了', '模型返回 JSON 也能救回来')
eq(r.emotion, '脸红', 'JSON 里的表情')
eq(r.motion, '自拍', 'JSON 里的动作')

r = parseReply('[表情:调皮]\n第一行\n第二行\n第三行')
eq(r.text, '第一行\n第二行\n第三行', '多行正文完整保留')

r = parseReply('[')
ok(typeof r.text === 'string', '残缺标签不抛异常')
eq(parseReply('').text, '', '空串安全')
eq(parseReply(null).text, '', 'null 安全')

r = parseReply('我今天买了[很贵的东西]回来\n[表情:问号]')
eq(r.emotion, '问号', '第二行的标签行也能识别')
ok(r.text.includes('[很贵的东西]'), '正文里的方括号不会被误吃', r.text)

/* ------------------------------------------------------------------ */
section('历史裁剪')
const hist = []
for (let i = 0; i < 40; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i })
eq(trimHistory(hist, 5).length, 10, '按轮数裁剪')
eq(trimHistory(hist, 5)[9].content, 'm39', '保留最近的')
eq(trimHistory([], 5).length, 0, '空历史')
eq(trimHistory([{ role: '', content: 'x' }], 5).length, 0, '丢弃结构不对的项')

const msgs = buildMessages('SYS', hist, '你好', 3)
eq(msgs[0].role, 'system', '第一条是 system')
eq(msgs[msgs.length - 1].content, '你好', '最后一条是用户新消息')
eq(msgs.length, 1 + 6 + 1, 'system + 6 条历史 + 新消息')

/* ------------------------------------------------------------------ */
section('请求：非流式')
async function testNonStream () {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization })
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '[表情:脸红]\n谢谢你陪我' } }] }),
      text: async () => '',
    }
  }
  const cfg = normalizeConfig({ enabled: true, baseUrl: 'https://x/v1', apiKey: 'sk-test', stream: false })
  const out = await requestChat(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch })
  eq(out, '[表情:脸红]\n谢谢你陪我', '拿到完整回复')
  eq(calls[0].url, 'https://x/v1/chat/completions', '打到正确端点')
  eq(calls[0].auth, 'Bearer sk-test', '带上 Authorization')
  eq(calls[0].body.stream, false, '非流式请求体正确')
  eq(calls[0].body.model, cfg.model, '带上 model')

  const r2 = parseReply(out)
  eq(r2.text, '谢谢你陪我', '回复能直接被解析消费')
  eq(r2.emotion, '脸红', '表情也能取出来')
}

/* ------------------------------------------------------------------ */
section('请求：流式 SSE')
async function testStream () {
  const enc = new TextEncoder()
  // 故意把一行 SSE 切在两块里，测缓冲区拼接
  const chunks = [
    'data: {"choices":[{"delta":{"content":"[表情:星星眼]"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"\\n好"}}]}\n\ndata: {"choi',
    'ces":[{"delta":{"content":"开心！"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  let i = 0
  const fakeFetch = async () => ({
    ok: true, status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: enc.encode(chunks[i++]) }
          : { done: true }),
      }),
    },
    json: async () => { throw new Error('流式路径不该调 json()') },
    text: async () => '',
  })

  const deltas = []
  const cfg = normalizeConfig({ enabled: true, stream: true })
  const out = await requestChat(cfg, [{ role: 'user', content: 'hi' }], {
    fetchImpl: fakeFetch,
    onDelta: (full) => deltas.push(full),
  })

  eq(out, '[表情:星星眼]\n好开心！', '跨块拼接后拿到完整文本')
  ok(deltas.length >= 3, `回调被多次触发（${deltas.length} 次）`)
  eq(deltas[deltas.length - 1], out, '最后一次回调是完整文本')
  eq(parseReply(out).text, '好开心！', '流式结果同样能解析')
}

/* ------------------------------------------------------------------ */
section('请求：错误处理')
async function testErrors () {
  const mk = (status, body) => async () => ({
    ok: false, status, text: async () => body, json: async () => ({}),
  })
  const cfg = normalizeConfig({ enabled: true, baseUrl: 'https://x/v1' })

  let e1 = null
  try { await requestChat(cfg, [], { fetchImpl: mk(401, 'invalid api key') }) } catch (e) { e1 = e }
  ok(e1 && /401/.test(e1.message), 'HTTP 错误带上状态码', e1 && e1.message)
  ok(e1 && /invalid api key/.test(e1.message), 'HTTP 错误带上响应正文')

  let e2 = null
  const netErr = async () => { throw new Error('getaddrinfo ENOTFOUND api.nope.test') }
  try { await requestChat(cfg, [], { fetchImpl: netErr }) } catch (e) { e2 = e }
  ok(e2 && /域名/.test(e2.message), 'DNS 失败给出中文提示', e2 && e2.message)

  let e3 = null
  const refused = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434') }
  try { await requestChat(cfg, [], { fetchImpl: refused }) } catch (e) { e3 = e }
  ok(e3 && /拒绝/.test(e3.message), '连接被拒给出中文提示', e3 && e3.message)

  let e4 = null
  const empty = async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    json: async () => ({}), text: async () => '',
  })
  try { await requestChat(normalizeConfig({ enabled: true, stream: true }), [], { fetchImpl: empty }) } catch (e) { e4 = e }
  ok(e4 && /没有返回任何内容/.test(e4.message), '空响应报错清晰', e4 && e4.message)

  let e5 = null
  const badJson = async () => ({
    ok: true, status: 200,
    body: null,
    json: async () => ({ error: 'nope' }), text: async () => '',
  })
  try { await requestChat(normalizeConfig({ enabled: true, stream: false }), [], { fetchImpl: badJson }) } catch (e) { e5 = e }
  ok(e5 && /choices/.test(e5.message), '缺 choices 时报错清晰', e5 && e5.message)
}

/* ------------------------------------------------------------------ */
;(async () => {
  await testNonStream()
  await testStream()
  await testErrors()

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`)
  process.exit(fail ? 1 : 0)
})()
