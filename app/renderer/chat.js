'use strict'
/**
 * 聊天面板（渲染进程）
 *
 * 和 panel.js 一样是独立 IIFE —— preload 的 ipcRenderer.on 支持多监听者。
 * 流式回复期间主进程不断推 pet:chat-delta（推的是「到目前为止的全文」），
 * 这里把开头的 [表情:xxx][动作:xxx] 标签摘掉再显示，用户就只看到正文。
 */
;(function () {
  const api = window.petAPI
  const $ = (id) => document.getElementById(id)

  const box = $('chat')
  const sub = $('c-sub')
  const setup = $('c-setup')
  const main = $('c-main')
  const msgsEl = $('c-msgs')
  const thinkingEl = $('c-thinking')
  const inputEl = $('c-text')
  const sendBtn = $('c-send')
  const msgEl = $('c-msg')
  const setupMsg = $('c-setup-msg')

  let cfg = null
  let visible = false
  let busy = false
  let streamEl = null
  let posTimer = null
  let setupLogged = false
  let lastFocusLogged = ''

  /* ------------------------------------------------------------ *
   * 显隐 / 定位
   * ------------------------------------------------------------ */
  function toggle (force) {
    const show = force === undefined ? !visible : !!force
    if (show === visible) return
    visible = show
    box.classList.toggle('hidden', !visible)

    if (visible) {
      window.PetView && window.PetView.relayout()
      if (!posTimer) posTimer = setInterval(() => window.PetView && window.PetView.relayout(), 400)
      requestAnimationFrame(logGeometry)
      if (cfg && cfg.ready) inputEl.focus()
    } else {
      clearInterval(posTimer); posTimer = null
      api.needFocus(false)
      window.PetView && window.PetView.relayout()
    }
    api.log(`聊天面板 ${visible ? '打开' : '关闭'}`)
  }

  /* ------------------------------------------------------------ *
   * 配置表单
   * ------------------------------------------------------------ */
  function fillForm () {
    if (!cfg) return
    $('c-base').value = cfg.baseUrl || ''
    $('c-model').value = cfg.model || ''
    $('c-extra').value = cfg.systemExtra || ''
    $('c-key').value = ''
    $('c-key').placeholder = cfg.hasKey ? `已保存（${cfg.keyMask}），留空则不修改` : 'sk-...'
    $('c-key-hint').textContent = cfg.hasKey ? `　当前：${cfg.keyMask}` : ''
  }

  function applyConfig (next) {
    cfg = next
    fillForm()
    setup.classList.toggle('hidden', !!cfg.ready)
    main.classList.toggle('hidden', !cfg.ready)
    sub.textContent = cfg.ready
      ? `${cfg.model}${cfg.hasKey ? '' : '（无密钥）'}`
      : '未配置接口'
    window.PetView && window.PetView.relayout()

    // 面板是 DOM，出问题时（点不到 / 打不了字）先得有坐标才能查
    if (!cfg.ready && !setupLogged) setupLogged = true
  }

  /** 把当前可见的可点控件坐标写进日志，排查「点不到 / 打不了字」用 */
  function logGeometry () {
    const ids = ['c-text', 'c-send', 'c-base', 'c-model', 'c-key', 'c-extra', 'c-save', 'c-test']
    const parts = []
    for (const id of ids) {
      const el = $(id)
      if (!el || el.offsetParent === null) continue
      const r = el.getBoundingClientRect()
      parts.push(`#${id}@${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`)
    }
    if (parts.length) api.log('可点控件: ' + parts.join('  '))
  }

  function readForm () {
    return {
      enabled: true,
      baseUrl: $('c-base').value.trim(),
      model: $('c-model').value.trim(),
      systemExtra: $('c-extra').value.trim(),
      apiKey: $('c-key').value.trim(),
    }
  }

  function say (el, text, kind) {
    el.textContent = text || ''
    el.className = el === msgEl ? 'c-msg' : 'c-msg'
    if (kind) el.classList.add(kind)
  }

  async function doSave () {
    const patch = readForm()
    if (!patch.baseUrl) { say(setupMsg, '接口地址不能为空', 'err'); return }
    if (!patch.model) { say(setupMsg, '模型名不能为空', 'err'); return }

    $('c-save').disabled = true
    say(setupMsg, '保存中…')
    try {
      const next = await api.chatSaveConfig(patch)
      applyConfig(next)
      say(setupMsg, next.ready ? '已保存' : '还没配置好', next.ready ? 'ok' : 'err')
      api.log('聊天配置已保存')
    } catch (e) {
      say(setupMsg, '保存失败：' + (e && e.message ? e.message : e), 'err')
    } finally {
      $('c-save').disabled = false
    }
  }

  async function doTest () {
    $('c-test').disabled = true
    say(setupMsg, '正在测试连通性…')
    try {
      // 先把表单里的值存进去，再拿保存后的配置去测
      const next = await api.chatSaveConfig(readForm())
      applyConfig(next)
      const r = await api.chatTest()
      if (r && r.ok) say(setupMsg, `连接成功！她说：${(r.sample || '').replace(/\s+/g, ' ').slice(0, 60)}`, 'ok')
      else say(setupMsg, '连接失败：' + ((r && r.error) || '未知错误'), 'err')
    } catch (e) {
      say(setupMsg, '测试失败：' + (e && e.message ? e.message : e), 'err')
    } finally {
      $('c-test').disabled = false
    }
  }

  /* ------------------------------------------------------------ *
   * 消息渲染
   * ------------------------------------------------------------ */
  /** 把开头的 [表情:xxx][动作:xxx] 标签摘掉，标签还没写完就先不显示 */
  function stripTag (text) {
    const t = String(text || '')
    const m = t.match(/^\s*(?:\[[^\]]*\]\s*)+/)
    if (m) return t.slice(m[0].length)
    if (/^\s*\[[^\]]*$/.test(t)) return ''
    return t
  }

  function addMsg (role, text, extra = '') {
    const li = document.createElement('li')
    li.className = role === 'user' ? 'me' : (role === 'system' ? 'sys' : 'her')
    li.textContent = text
    if (extra) {
      const s = document.createElement('span')
      s.className = 'emo'
      s.textContent = extra
      li.append(s)
    }
    msgsEl.append(li)
    scrollDown()
    return li
  }

  function scrollDown () {
    msgsEl.scrollTop = msgsEl.scrollHeight
  }

  function renderHistory (list) {
    msgsEl.innerHTML = ''
    for (const m of list || []) {
      addMsg(m.role === 'assistant' ? 'her' : 'user', m.content)
    }
    scrollDown()
  }

  function setBusy (on) {
    busy = on
    sendBtn.disabled = on
    inputEl.disabled = on
    thinkingEl.classList.toggle('hidden', !on)
    if (on) scrollDown()
    if (!on && visible) inputEl.focus()
  }

  /* ------------------------------------------------------------ *
   * 发送
   * ------------------------------------------------------------ */
  async function send () {
    const text = inputEl.value.trim()
    if (!text || busy) return

    inputEl.value = ''
    autosize()
    say(msgEl, '')
    setBusy(true)

    try {
      const r = await api.chatSend(text)
      if (r && !r.ok && r.error && !r.needSetup) say(msgEl, r.error, 'err')
    } catch (e) {
      say(msgEl, '发送失败：' + (e && e.message ? e.message : e), 'err')
      setBusy(false)
    }
  }

  function autosize () {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(76, Math.max(30, inputEl.scrollHeight)) + 'px'
  }

  /* ------------------------------------------------------------ *
   * 事件订阅
   * ------------------------------------------------------------ */
  api.onChatPanel((p) => { if (p && p.toggle) toggle() })

  // 主进程回显用户消息：以它为准，避免本地重复插入
  api.onChatMessage((m) => {
    if (!m) return
    addMsg(m.role === 'assistant' ? 'her' : 'user', m.content)
  })

  api.onChatThinking((p) => {
    if (p && p.on) { setBusy(true); say(msgEl, '') }
    else setBusy(false)
  })

  // 流式增量：推的是累计全文，直接覆盖显示
  api.onChatDelta((p) => {
    if (!p) return
    const shown = stripTag(p.text)
    if (!streamEl) {
      streamEl = document.createElement('li')
      streamEl.className = 'her streaming'
      msgsEl.append(streamEl)
    }
    streamEl.textContent = shown
    thinkingEl.classList.add('hidden')
    scrollDown()
  })

  api.onChatReply((p) => {
    if (streamEl) { streamEl.remove(); streamEl = null }
    if (!p) return

    if (p.ok) {
      const extra = p.emotion ? `（${p.emotion}）` : ''
      addMsg('her', p.text, extra)
      say(msgEl, '')
    } else if (p.needSetup) {
      say(msgEl, '还没配置接口，先在上面填一下', 'err')
      applyConfig({ ...(cfg || {}), ready: false })
    } else {
      say(msgEl, p.error || '出错了', 'err')
    }
    setBusy(false)
  })

  api.onChatCleared(() => {
    msgsEl.innerHTML = ''
    addMsg('system', '对话已清空')
  })

  /* ------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------ */
  $('c-close').addEventListener('click', () => toggle(false))
  $('c-save').addEventListener('click', doSave)
  $('c-test').addEventListener('click', doTest)
  $('c-clear').addEventListener('click', () => api.chatClear())
  $('c-settings').addEventListener('click', () => {
    applyConfig({ ...(cfg || {}), ready: false })
  })
  sendBtn.addEventListener('click', send)

  inputEl.addEventListener('input', autosize)
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  /**
   * 打字前必须让窗口真的拿到系统键盘焦点 —— 窗口平时是 focusable:false
   * （为了不抢你前台程序的焦点），Windows 会把按键送给前台窗口，
   * 于是输入框看着有光标却打不进字。
   *
   * 用 pointerdown 而不是 focus：要在浏览器默认聚焦行为之前就把窗口变成
   * 可激活的，不然这一次点击拿不到前台权限。
   */
  function wireInput (el) {
    if (!el) return
    el.addEventListener('pointerdown', () => api.needFocus(true))
    el.addEventListener('focus', () => {
      api.needFocus(true)
      // 只在真正换了控件时记一行，避免 focus/blur 抖动刷屏
      if (lastFocusLogged !== el.id) {
        lastFocusLogged = el.id
        api.log('输入框获得焦点: #' + el.id)
      }
    })
    el.addEventListener('blur', () => {
      if (lastFocusLogged === el.id) lastFocusLogged = ''
      api.needFocus(false)
    })
  }

  wireInput(inputEl)
  for (const id of ['c-base', 'c-model', 'c-key', 'c-extra']) wireInput($(id))

  /* ------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------ */
  ;(async () => {
    try {
      const init = await api.chatInit()
      applyConfig(init.config)
      renderHistory(init.history)
      if (init.config && !init.config.ready) {
        api.log('聊天未配置，打开面板时会显示设置表单')
      } else {
        api.log(`聊天就绪：${init.config.model} | 历史 ${(init.history || []).length} 条`)
      }
    } catch (e) {
      api.log('聊天初始化失败: ' + (e && e.message ? e.message : e))
    }
  })()
})()
