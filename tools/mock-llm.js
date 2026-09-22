'use strict'
/**
 * 假的 OpenAI 兼容服务，用来端到端测聊天链路（不需要真 API key）
 *   node tools/mock-llm.js [port]
 *
 * 会打印收到的 system prompt，方便确认「她的状态真的被写进提示词了」。
 * 会按提示词里的饱食度选不同表情，用来验证状态影响回复。
 */

const http = require('http')

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8787)

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url.split('?')[0])) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'not found' } }))
  }

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let j = {}
    try { j = JSON.parse(body) } catch { /* ignore */ }

    const messages = j.messages || []
    const sys = messages.find((m) => m.role === 'system')
    const user = [...messages].reverse().find((m) => m.role === 'user')
    const sysText = String((sys && sys.content) || '')

    console.log('\n========== 收到请求 ==========')
    console.log('model       :', j.model)
    console.log('stream      :', j.stream)
    console.log('temperature :', j.temperature, '| max_tokens:', j.max_tokens)
    console.log('messages    :', messages.length)
    console.log('Authorization:', req.headers.authorization ? '有' : '无')
    console.log('--- SYSTEM（前 1400 字）---')
    console.log(sysText.slice(0, 1400))
    console.log('--- USER ---')
    console.log(user && user.content)

    // 用提示词里的状态决定回复，验证「状态真的影响说话」
    const m = /饱食度\s+(\d+)\/100/.exec(sysText)
    const satiety = m ? Number(m[1]) : 100
    const moodM = /心情\s+(\d+)\/100/.exec(sysText)
    const mood = moodM ? Number(moodM[1]) : 100

    let reply
    if (satiety < 30) {
      reply = '[表情:流汗][动作:无]\n肚子好饿……你有吃的吗？'
    } else if (mood < 30) {
      reply = '[表情:悲伤][动作:无]\n唔……我现在不太想说话。'
    } else {
      reply = '[表情:星星眼][动作:自拍简单]\n嘿嘿，你终于来找我啦，我一直在这儿呢～'
    }

    if (!j.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: j.model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      }))
    }

    // 流式：把回复切成小块推出去，故意在标签中间切一刀
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const pieces = []
    const step = 6
    for (let i = 0; i < reply.length; i += step) pieces.push(reply.slice(i, i + step))

    let i = 0
    const timer = setInterval(() => {
      if (i >= pieces.length) {
        clearInterval(timer)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      const chunk = { choices: [{ index: 0, delta: { content: pieces[i++] } }] }
      res.write('data: ' + JSON.stringify(chunk) + '\n\n')
    }, 25)

    // 注意：这里必须监听 res 而不是 req —— req 的 'close' 在请求体读完时就会触发，
    // 会把还没发一个字节的定时器直接清掉，客户端就永远卡在等流结束。
    res.on('close', () => clearInterval(timer))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock LLM listening on http://127.0.0.1:${PORT}/v1/chat/completions`)
})
