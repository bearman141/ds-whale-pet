'use strict'
/**
 * 状态面板
 *
 * 独立于 pet.js 的一个 IIFE —— preload 的 ipcRenderer.on 支持多个监听者，
 * 所以两个脚本各自订阅同一批事件，互不干扰。
 *
 * 面板是 DOM，不是画布，所以 pet.js 的「读像素命中」测不到它；
 * pet.js 那边额外用 getBoundingClientRect 判了一次，见 panelCovers()。
 */
;(function () {
  const api = window.petAPI
  const $ = (id) => document.getElementById(id)

  const panel = $('panel')
  const nameInput = $('p-name')
  const barsEl = $('p-bars')
  const actionsEl = $('p-actions')
  const logEl = $('p-log')

  const ACTION_ORDER = ['feed', 'play', 'pet', 'clean', 'gift', 'sleep']

  let statMeta = {}
  let statKeys = []
  let snap = null
  let snapAt = 0
  let barsBuilt = false
  let actionsBuilt = false
  let loggedOnce = false
  let visible = false
  let tickTimer = null
  let posTimer = null

  /* ------------------------------------------------------------ *
   * 显隐 / 定位
   * ------------------------------------------------------------ */
  function toggle (force) {
    const show = force === undefined ? !visible : !!force
    if (show === visible) return
    visible = show
    panel.classList.toggle('hidden', !visible)

    if (visible) {
      render()
      position()
      if (!tickTimer) tickTimer = setInterval(renderCooldowns, 1000)
      if (!posTimer) posTimer = setInterval(position, 400)
    } else {
      clearInterval(tickTimer); tickTimer = null
      clearInterval(posTimer); posTimer = null
    }
    api.log(`状态面板 ${visible ? '打开' : '关闭'}`)
  }

  function position () {
    if (!visible) return
    const view = window.PetView
    const wa = view ? view.workArea() : { x: 0, y: 0, width: innerWidth, height: innerHeight }
    const a = view ? view.anchor() : { x: innerWidth - 200, y: innerHeight - 40 }
    const r = panel.getBoundingClientRect()
    if (!r.width) return

    // 默认放宠物左边，放不下就换到右边
    let left = a.x - r.width - 30
    if (left < wa.x + 8) left = a.x + 30
    left = Math.max(wa.x + 8, Math.min(left, wa.x + wa.width - r.width - 8))

    let top = a.y - r.height
    const maxTop = wa.y + wa.height - r.height - 8
    top = Math.max(wa.y + 8, Math.min(top, maxTop))

    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'
  }

  /* ------------------------------------------------------------ *
   * 构建
   * ------------------------------------------------------------ */
  function buildBars () {
    barsEl.innerHTML = ''
    for (const k of statKeys) {
      const meta = statMeta[k] || { label: k, icon: '', color: '#5ec8f5' }
      const row = document.createElement('div')

      const line = document.createElement('div')
      line.className = 'p-line'
      const l = document.createElement('span')
      l.textContent = `${meta.icon} ${meta.label}`
      const v = document.createElement('span')
      v.id = `p-${k}-val`
      line.append(l, v)

      const bar = document.createElement('div')
      bar.className = 'p-bar'
      const fill = document.createElement('i')
      fill.id = `p-${k}-fill`
      bar.append(fill)

      row.append(line, bar)
      barsEl.append(row)
    }
    barsBuilt = true
  }

  function buildActions (actions) {
    actionsEl.innerHTML = ''
    for (const key of ACTION_ORDER) {
      const a = actions[key]
      if (!a) continue
      const b = document.createElement('button')
      b.dataset.key = key
      const ico = document.createElement('span')
      ico.className = 'ico'
      ico.textContent = a.icon
      const txt = document.createElement('span')
      txt.className = 'txt'
      txt.textContent = a.label
      b.append(ico, txt)
      b.addEventListener('click', () => {
        b.blur()
        api.gameAction(key)
      })
      actionsEl.append(b)
    }
    actionsBuilt = true
  }

  /* ------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------ */
  function render () {
    if (!snap) return

    if (!barsBuilt) buildBars()
    if (!actionsBuilt) buildActions(snap.actions || {})

    $('p-emoji').textContent = snap.mood ? snap.mood.emoji : '🐋'
    if (document.activeElement !== nameInput) nameInput.value = snap.name || '鲸鱼娘'
    $('p-level').textContent = `Lv.${snap.level}`
    $('p-title-text').textContent = snap.title || ''

    $('p-mood-name').textContent = snap.mood ? `${snap.mood.emoji} ${snap.mood.name}` : '——'
    $('p-reason').textContent = snap.mood ? snap.mood.reason : ''

    /* 属性条 */
    for (const k of statKeys) {
      const v = snap.stats[k] ?? 0
      const meta = statMeta[k] || {}
      const fill = $(`p-${k}-fill`)
      const val = $(`p-${k}-val`)
      if (fill) {
        fill.style.width = Math.max(0, Math.min(100, v)) + '%'
        fill.style.background = v < 25 ? '#ef6b6b' : (meta.color || '#5ec8f5')
      }
      if (val) val.textContent = Math.round(v) + (v < 25 ? ' ⚠' : '')
    }

    /* 好感 / 经验 */
    const aff = snap.affection ?? 0
    $('p-aff-val').textContent = `${aff.toFixed(1)} / 100`
    $('p-aff-fill').style.width = Math.max(0, Math.min(100, aff)) + '%'

    const span = Math.max(1, (snap.expNext ?? 0) - (snap.expCur ?? 0))
    const got = Math.max(0, (snap.exp ?? 0) - (snap.expCur ?? 0))
    const pct = (snap.expNext === snap.expCur) ? 100 : Math.round((got / span) * 100)
    $('p-exp-label').textContent = (snap.expNext === snap.expCur)
      ? `EXP ${snap.exp} · 已满级`
      : `EXP ${snap.exp} / ${snap.expNext}`
    $('p-exp-fill').style.width = pct + '%'

    $('p-ach').textContent = `🏆 ${(snap.achievements || []).length}`
    $('p-uptime').textContent = `相处 ${fmtHours(snap.uptimeHours)}`

    renderCooldowns()
    renderLog()

    if (!loggedOnce) {
      loggedOnce = true
      api.log('面板首帧：' +
        `${snap.name} Lv.${snap.level}「${snap.title}」` +
        ` ${snap.mood ? snap.mood.emoji + snap.mood.name : '-'}` +
        ` | ${statKeys.map((k) => `${k}=${Math.round(snap.stats[k])}`).join(' ')}` +
        ` | 好感=${snap.affection} EXP=${snap.exp} 成就=${(snap.achievements || []).length}` +
        ` 日志=${(snap.log || []).length}条` +
        ` 按钮=${actionsEl.children.length} 条=${barsEl.children.length}`)
    }
  }

  function renderCooldowns () {
    if (!snap) return
    const now = Date.now()
    const elapsed = now - snapAt
    for (const b of actionsEl.querySelectorAll('button')) {
      const key = b.dataset.key
      const base = snap.actions && snap.actions[key]
      if (!base) continue
      const left = Math.max(0, (snap.cooldowns[key] || 0) - elapsed)
      const blocked = !base.can && left <= 0
      b.disabled = left > 0 || blocked
      const txt = b.querySelector('.txt')
      if (left > 0) txt.textContent = `${Math.ceil(left / 1000)}s`
      else if (blocked) txt.textContent = '不行'
      else txt.textContent = base.label
      b.title = left > 0
        ? `${base.label}：冷却中`
        : (blocked ? `${base.label}：现在做不了` : base.label)
    }
  }

  function renderLog () {
    const list = (snap.log || []).slice(-9).reverse()
    logEl.innerHTML = ''
    for (const e of list) {
      const li = document.createElement('li')
      const t = document.createElement('span')
      t.className = 't'
      t.textContent = fmtTime(e.t)
      const s = document.createElement('span')
      s.textContent = `${e.icon || ''} ${e.text}`
      li.append(t, s)
      logEl.append(li)
    }
  }

  function fmtTime (t) {
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  function fmtHours (h) {
    const v = Number(h) || 0
    if (v < 1) return `${Math.round(v * 60)} 分钟`
    if (v < 48) return `${v.toFixed(1)} 小时`
    return `${(v / 24).toFixed(1)} 天`
  }

  /* ------------------------------------------------------------ *
   * 事件订阅
   * ------------------------------------------------------------ */
  api.onGame((g) => {
    if (!g || !g.snapshot) return
    if (g.statMeta) statMeta = g.statMeta
    if (g.statKeys) statKeys = g.statKeys
    snap = g.snapshot
    snapAt = Date.now()
    if (barsBuilt && statKeys.length !== barsEl.children.length) barsBuilt = false
    render()
  })

  api.onPanel((p) => { if (p && p.toggle) toggle() })

  /* ------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------ */
  $('p-close').addEventListener('click', () => toggle(false))
  $('p-reset').addEventListener('click', () => api.gameReset())

  nameInput.addEventListener('focus', () => {
    api.needFocus(true)
    nameInput.select()
  })
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur()
  })
  nameInput.addEventListener('blur', () => {
    api.needFocus(false)
    const v = nameInput.value.trim()
    if (v && snap && v !== snap.name) {
      api.setName(v)
      snap.name = v
    } else if (snap) {
      nameInput.value = snap.name
    }
  })

  api.log('状态面板已就绪')
})()
