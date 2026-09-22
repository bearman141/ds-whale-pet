'use strict'
/**
 * DS鲸鱼娘 桌宠 —— 渲染进程
 *
 * 要点：
 *  1. 用 PIXI + pixi-live2d-display(Cubism 4) 绘制 moc3 模型
 *  2. 自行实现「表情叠加栈」：原始 exp3 的 Blend 多为 Add，
 *     所以多个表情可以同时生效（和 VTube Studio 里一致），
 *     而 pixi-live2d-display 自带的 ExpressionManager 一次只支持一个
 *  3. 用 WebGL 读回像素做命中判定，实现真正的「按像素穿透」：
 *     只有指针落在模型不透明的地方，窗口才变成可交互
 */
;(function () {
  const api = window.petAPI

  /* ============================================================ *
   * 常量
   * ============================================================ */
  const PRIORITY = {
    IDLE: (PIXI.live2d.MotionPriority && PIXI.live2d.MotionPriority.IDLE) || 1,
    NORMAL: (PIXI.live2d.MotionPriority && PIXI.live2d.MotionPriority.NORMAL) || 2,
    FORCE: (PIXI.live2d.MotionPriority && PIXI.live2d.MotionPriority.FORCE) || 3,
  }

  /** 「随机换表情」菜单项抽的池子（只抽情绪，不抽道具） */
  const RANDOM_POOL = [
    '悲伤', '生气', '脸红', '哭', '流汗', '问号', '感叹号', '阴暗', '晕晕',
    '调皮', '闭眼口水', '开心兴奋', '心跳', '星星眼', '爱心眼', '情绪花花', '呆呆眼',
  ]
  const EXPR_FADE = 0.16           // 秒
  const CLICK_MOVE_TOLERANCE = 5   // px，超过算拖动
  const ALPHA_HIT_THRESHOLD = 12

  /** 这些情绪说明「她有需求」，值得冒个气泡提醒你 */
  const NEED_MOODS = new Set(['starving', 'hungry', 'exhausted', 'dirty', 'lonely', 'angry', 'sad'])

  /* ============================================================ *
   * 状态
   * ============================================================ */
  let app = null
  let model = null

  let catalog = { expressions: [], motions: [], hotkeys: [] }
  let settings = {}

  let petX = 0
  let petY = 0
  let petHeight = 380
  let workArea = { x: 0, y: 0, width: 1920, height: 1080 }
  let naturalW = 1
  let naturalH = 1

  const exprDefs = new Map()      // 表情名 -> 解析后的 exp3 内容
  const exprState = new Map()     // 表情名 -> { weight, removing, params, layer, expireAt }
  const motionMeta = new Map()    // 动作名 -> { duration, loop }

  let dragging = false
  let dragMoved = 0
  let dragOffset = { x: 0, y: 0 }
  let pointer = { x: -9999, y: -9999 }
  let needHitTest = false
  let interactiveNow = false
  let motionToken = 0
  let lastFrame = performance.now()
  let currentMood = null

  const pixel = new Uint8Array(4)

  /* ============================================================ *
   * DOM
   * ============================================================ */
  const canvas = document.getElementById('stage')
  const bubble = document.getElementById('bubble')
  const bubbleText = document.getElementById('bubble-text')
  const hint = document.getElementById('hint')
  const panelEl = document.getElementById('panel')
  const panelsEl = document.getElementById('panels')
  let bubbleTimer = null

  /** 指针是否落在某个可见面板上（面板是 DOM，读像素那套测不到它们） */
  function panelCovers (x, y) {
    for (const card of document.querySelectorAll('#panels .card')) {
      if (card.classList.contains('hidden')) continue
      const r = card.getBoundingClientRect()
      if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
    }
    return false
  }

  /* ============================================================ *
   * 工具
   * ============================================================ */
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

  function modelUrl (relPath) {
    return 'pet://local/model/' + relPath.split('/').map(encodeURIComponent).join('/')
  }

  /* ============================================================ *
   * 启动
   * ============================================================ */
  async function boot () {
    const init = await api.init()
    catalog = init.catalog
    settings = init.settings
    petHeight = init.petHeight
    petX = init.position.x
    petY = init.position.y
    workArea = init.workArea

    api.log(`init 完成：${catalog.expressions.length} 表情 / ${catalog.motions.length} 动作 / ${catalog.hotkeys.length} 热键`)

    createPixiApp()
    await loadModel(init.modelUrl)
    await Promise.all([loadExpressionDefs(), loadMotionMeta()])

    layout()
    startTicker()
    bindPointer()
    bindIpc()
    playIdle()

    // 养成系统：开局先把当前情绪的条件结果套上
    if (init.game && init.game.snapshot) applyGameSnapshot(init.game.snapshot)

    if (settings.showHint) {
      showHint()
      api.log('显示首次运行提示')
    }
    api.log('启动完成')
    diagnose()
    diagnoseMotion()
  }

  /** 启动自检：确认模型真的画到了画布上（隔着透明窗口很难肉眼确认） */
  function diagnose () {
    setTimeout(() => {
      try {
        const b = model.getBounds()
        const cx = petX
        const cy = Math.round(petY - petHeight * 0.5)
        const alpha = {
          head: alphaAt(cx, Math.round(petY - petHeight * 0.8)),
          chest: alphaAt(cx, cy),
          bottom: alphaAt(cx, Math.round(petY - 20)),
          left: alphaAt(Math.round(petX - 80), cy),
          right: alphaAt(Math.round(petX + 80), cy),
        }
        api.log(`自检：scale=${model.scale.x.toFixed(4)} pos=${Math.round(model.x)},${Math.round(model.y)} ` +
          `bounds=${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)} ` +
          `alpha=${JSON.stringify(alpha)} canvas=${app.renderer.width}x${app.renderer.height}@${app.renderer.resolution} ` +
          `gl=${!!app.renderer.gl} active=[${activeLabels().join(',')}]`)
      } catch (e) {
        api.log('自检失败: ' + e.message)
      }
    }, 2500)
  }

  /** 二次自检：确认动作系统在跑（待机循环是否真的在推进） */
  function diagnoseMotion () {
    setTimeout(() => {
      try {
        const mm = model.internalModel.motionManager
        api.log(`动作自检：currentGroup=${mm.currentGroup} currentIndex=${mm.currentIndex} ` +
          `playing=${mm.isFinished ? !mm.isFinished() : 'n/a'} ` +
          `groups=[${Object.keys(mm.motionGroups || {}).join(',')}]`)
      } catch (e) {
        api.log('动作自检失败: ' + e.message)
      }
    }, 4200)
  }

  /* ------------------------------------------------------------ */
  function createPixiApp () {
    app = new PIXI.Application({
      view: canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      // 命中判定要读回像素，必须保留绘制缓冲
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
  }

  async function loadModel (url) {
    model = await PIXI.live2d.Live2DModel.from(url, {
      autoInteract: false,
      autoUpdate: true,
    })
    model.interactive = false
    app.stage.addChild(model)

    const im = model.internalModel
    naturalW = im.originalWidth || model.width || 1
    naturalH = im.originalHeight || model.height || 1
    api.log(`模型已加载：original=${naturalW}x${naturalH} ` +
      `canvas=${im.coreModel && im.coreModel.getModel ? safeCanvasSize(im) : 'n/a'} ` +
      `anchor=${!!model.anchor}`)

    if (model.anchor) model.anchor.set(0.5, 1)
    else model.pivot.set(naturalW / 2, naturalH)

    model.internalModel.on('beforeModelUpdate', applyExpressionStack)
  }

  function safeCanvasSize (im) {
    try {
      const info = im.coreModel.getModel().canvasinfo
      return `${info.CanvasWidth}x${info.CanvasHeight}`
    } catch {
      return 'n/a'
    }
  }

  /* ------------------------------------------------------------ *
   * 预读 exp3 / motion3 元数据
   * ------------------------------------------------------------ */
  async function loadExpressionDefs () {
    await Promise.all(catalog.expressions.map(async (e) => {
      try {
        const res = await fetch(modelUrl(e.file))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        exprDefs.set(e.name, await res.json())
      } catch (err) {
        api.log(`表情定义加载失败 ${e.name}: ${err.message}`)
      }
    }))
    api.log(`已载入 ${exprDefs.size} 个表情定义`)
  }

  async function loadMotionMeta () {
    await Promise.all(catalog.motions.map(async (m) => {
      try {
        const res = await fetch(modelUrl(m.file))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        motionMeta.set(m.name, {
          duration: Number(json?.Meta?.Duration) || 3,
          loop: !!(json?.Meta?.Loop || m.loop),
        })
      } catch (err) {
        motionMeta.set(m.name, { duration: 3, loop: !!m.loop })
        api.log(`动作元数据加载失败 ${m.name}（按 3 秒处理）: ${err.message}`)
      }
    }))
  }

  /* ============================================================ *
   * 布局
   * ============================================================ */
  function layout () {
    if (!model) return
    petX = clamp(petX, workArea.x + 24, workArea.x + workArea.width - 24)
    petY = clamp(petY, workArea.y + petHeight * 0.35, workArea.y + workArea.height - 4)

    const s = petHeight / naturalH
    model.scale.set(s)
    model.position.set(petX, petY)
    positionOverlays()
    layoutPanels()
    needHitTest = true
  }

  /**
   * 把整个面板区贴到宠物左边；左边放不下就翻到右边，最后夹进工作区。
   * 两个面板都塞在 #panels 这个 flex 容器里，所以这里只需要算一次坐标。
   */
  function layoutPanels () {
    if (!panelsEl) return
    if (!panelsEl.querySelector('.card:not(.hidden)')) return
    const r = panelsEl.getBoundingClientRect()
    if (!r.width || !r.height) return

    const maxLeft = Math.max(workArea.x + 8, workArea.x + workArea.width - r.width - 8)
    let left = petX - 30 - r.width
    if (left < workArea.x + 8) left = petX + 30
    left = clamp(left, workArea.x + 8, maxLeft)

    const maxTop = Math.max(workArea.y + 8, workArea.y + workArea.height - r.height - 8)
    const top = clamp(petY - r.height, workArea.y + 8, maxTop)

    panelsEl.style.left = Math.round(left) + 'px'
    panelsEl.style.top = Math.round(top) + 'px'
  }

  function positionOverlays () {
    const top = Math.max(workArea.y + 8, petY - petHeight - 12)
    bubble.style.left = petX + 'px'
    bubble.style.top = top + 'px'
    hint.style.left = petX + 'px'
    hint.style.top = top + 'px'
  }

  /* ============================================================ *
   * 主循环
   * ============================================================ */
  function startTicker () {
    app.ticker.add(() => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - lastFrame) / 1000)
      lastFrame = now

      // 视线跟随
      if (!dragging && model) {
        model.focus(pointer.x, pointer.y)
      }

      tickExpressionStack(dt)

      if (needHitTest) {
        needHitTest = false
        updateInteractive()
      }
    })
  }

  /* ============================================================ *
   * 命中判定（按不透明像素）
   * ============================================================ */
  function roughBox () {
    const halfW = petHeight * 0.62
    return {
      left: petX - halfW,
      right: petX + halfW,
      top: petY - petHeight * 1.18,
      bottom: petY + 10,
    }
  }

  function alphaAt (x, y) {
    const gl = app.renderer.gl
    if (!gl || !gl.readPixels) return 255
    const res = app.renderer.resolution
    const px = Math.floor(x * res)
    const py = Math.floor(gl.drawingBufferHeight - y * res)
    if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) return 0
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return pixel[3]
  }

  function updateInteractive () {
    const p = pointer
    const overPanel = panelCovers(p.x, p.y)
    setPanelHover(overPanel)

    if (!settings.clickThrough) return setInteractive(true, '关闭了像素穿透')
    if (dragging) return setInteractive(true, '拖拽中')
    if (overPanel) return setInteractive(true, '面板')

    const b = roughBox()
    if (p.x < b.left || p.x > b.right || p.y < b.top || p.y > b.bottom) {
      return setInteractive(false, '离开宠物与面板')
    }
    const hit = alphaAt(p.x, p.y) > ALPHA_HIT_THRESHOLD
    setInteractive(hit, hit ? '模型像素' : '模型透明处')
  }

  /**
   * 通知主进程「光标在不在面板上」。
   * 在面板上时窗口必须允许被激活，否则输入框拿不到键盘焦点。
   */
  let panelHoverNow = false
  function setPanelHover (on) {
    if (on === panelHoverNow) return
    panelHoverNow = on
    api.setPanelHover(on)
  }

  /** 记录每次穿透状态翻转的原因 —— 排查「面板点不动」全靠它 */
  function setInteractive (on, why) {
    if (on === interactiveNow) return
    interactiveNow = on
    api.log(`窗口可交互 ${on ? '开' : '关'}${why ? '（' + why + '）' : ''}`)
    api.setInteractive(on)
  }

  /* ============================================================ *
   * 表情叠加栈（分层）
   *
   * 三个来源往同一个池子里放表情，用层级决定优先级：
   *   mood  情绪层 —— 养成引擎按条件实时推导，条件一变自动换
   *   prop  道具层 —— 热键手动开关（墨镜、桌布…），一直保留
   *   event 事件层 —— 交互 / 点击的即时反应，带 TTL 自动淡出
   * 同名表情只保留层级最高的那个，高层不会被低层打断。
   *
   * 混合模式按原始 exp3 里的 Blend 走（基本都是 Add），所以多个表情能叠加。
   * ============================================================ */
  const LAYER_RANK = { mood: 10, prop: 20, event: 30 }

  function normalizeParams (def) {
    const core = model.internalModel.coreModel
    const out = []
    for (const p of def.Parameters || []) {
      let idx = -1
      try { idx = core.getParameterIndex(p.Id) } catch { idx = -1 }
      if (idx < 0) continue
      out.push({
        Id: p.Id,
        Value: Number(p.Value) || 0,
        blend: String(p.Blend || 'Add').toLowerCase(),
      })
    }
    return out
  }

  function applyExpressionStack () {
    if (!exprState.size || !model) return
    const core = model.internalModel.coreModel
    for (const st of exprState.values()) {
      const w = st.weight
      if (w <= 0.001) continue
      for (const p of st.params) {
        const v = p.Value * w
        if (p.blend === 'multiply') {
          let cur = 1
          try { cur = core.getParameterValueById(p.Id) } catch { cur = 1 }
          try { core.setParameterValueById(p.Id, cur * ((1 - w) + v * w)) } catch { /* ignore */ }
        } else if (p.blend === 'overwrite') {
          try { core.setParameterValueById(p.Id, v) } catch { /* ignore */ }
        } else {
          try { core.addParameterValueById(p.Id, v) } catch { /* ignore */ }
        }
      }
    }
  }

  function tickExpressionStack (dt) {
    if (!exprState.size) return
    const now = performance.now()
    for (const [name, st] of [...exprState]) {
      if (st.expireAt && now >= st.expireAt && !st.removing) st.removing = true
      const goal = st.removing ? 0 : 1
      if (st.weight < goal) st.weight = Math.min(goal, st.weight + dt / EXPR_FADE)
      else if (st.weight > goal) st.weight = Math.max(goal, st.weight - dt / EXPR_FADE)
      if (st.removing && st.weight <= 0.001) exprState.delete(name)
    }
  }

  /**
   * @param {string} name  表情名
   * @param {'mood'|'prop'|'event'} layer
   * @param {number} ttl   毫秒，0 表示常驻
   */
  function addExpression (name, layer = 'prop', ttl = 0) {
    const def = exprDefs.get(name)
    if (!def) {
      api.log(`未知表情：${name}`)
      return false
    }
    let st = exprState.get(name)
    if (st) {
      const cur = LAYER_RANK[st.layer] || 0
      const want = LAYER_RANK[layer] || 0
      // 已经被更高层级占着，低层级不许覆盖
      if (want < cur && !st.removing) return false
      if (want >= cur) st.layer = layer
      st.removing = false
    } else {
      st = { weight: 0, removing: false, params: normalizeParams(def), layer, expireAt: 0 }
      exprState.set(name, st)
    }
    st.expireAt = ttl > 0 ? performance.now() + ttl : 0
    api.log(`表情开：${name} [${layer}${ttl ? ' ' + ttl + 'ms' : ''}]`)
    return true
  }

  /** 移除表情；给了 layer 时只有层级不低于它的调用方才能移除 */
  function removeExpression (name, layer = null, { silent = false } = {}) {
    const st = exprState.get(name)
    if (!st || st.removing) return false
    if (layer && (LAYER_RANK[layer] || 0) < (LAYER_RANK[st.layer] || 0)) return false
    st.removing = true
    st.expireAt = 0
    if (!silent) api.log(`表情关：${name}`)
    return true
  }

  /** 热键是「道具开关」：开过就常驻，再按一次关掉 */
  function toggleExpression (name) {
    const st = exprState.get(name)
    if (st && !st.removing && st.layer === 'prop') return removeExpression(name, 'prop')
    return addExpression(name, 'prop')
  }

  /**
   * 情绪层同步 —— 条件驱动表情的落地点。
   * 养成引擎每次 tick 都会给出「当前情绪该配哪些表情」，
   * 这里把情绪层替换成新集合，于是表情随条件自动变化。
   */
  let lastMoodKey = ''
  function syncMoodLayer (list) {
    const want = new Set((list || []).filter((n) => exprDefs.has(n)))
    const key = [...want].sort().join('|')
    if (key === lastMoodKey) return
    lastMoodKey = key

    for (const [name, st] of [...exprState]) {
      if (st.layer === 'mood' && !want.has(name)) removeExpression(name, 'mood')
    }
    for (const n of want) {
      const st = exprState.get(n)
      if (!st || st.layer === 'mood') addExpression(n, 'mood')
    }
    api.log(`情绪表情 -> [${[...want].join(', ')}]`)
  }

  /** 清掉手动加的东西，保留当前情绪（情绪是状态，不该被「归位」清掉） */
  function clearAllExpressions ({ silent = false } = {}) {
    for (const name of [...exprState.keys()]) {
      const st = exprState.get(name)
      if (st.layer === 'mood') continue
      removeExpression(name, null, { silent: true })
    }
    if (!silent) api.log('清空表情（保留当前情绪）')
  }

  function activeLabels () {
    const map = new Map(catalog.expressions.map((e) => [e.name, e.label]))
    return [...exprState.entries()]
      .filter(([, st]) => !st.removing)
      .map(([n]) => map.get(n) || n)
  }

  /* ============================================================ *
   * 动作
   * ============================================================ */
  function playIdle () {
    if (!model) return
    try {
      const r = model.motion('Idle', 0, PRIORITY.IDLE)
      if (r && r.catch) r.catch(() => {})
    } catch (e) {
      api.log('待机动作播放失败: ' + e.message)
    }
  }

  function playMotion (name) {
    if (!model) return
    const meta = motionMeta.get(name)
    const token = ++motionToken
    api.log(`播放动作：${name}（时长 ${meta ? meta.duration : '?'}s）`)

    let result
    try {
      result = model.motion(name, 0, PRIORITY.NORMAL)
    } catch (e) {
      api.log(`动作播放异常 ${name}: ${e.message}`)
      return
    }

    if (result && result.then) {
      result.then((ok) => {
        if (!ok) return
        if (token !== motionToken) return
        playIdle()
      }).catch(() => {})
    }

    // 兜底：即使 Promise 没有按预期结束，也按时回到待机
    if (!meta || !meta.loop) {
      const wait = ((meta ? meta.duration : 3) + 0.6) * 1000
      setTimeout(() => { if (token === motionToken) playIdle() }, wait)
    }
  }

  function randomMomentExpression () {
    const pool = RANDOM_POOL.filter((n) => exprDefs.has(n))
    if (!pool.length) return null
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /** 养成快照 -> 情绪层表情（条件驱动表情的入口） */
  function applyGameSnapshot (snap) {
    currentMood = snap.mood || null
    syncMoodLayer(snap.mood ? snap.mood.expressions : [])
  }

  /* ============================================================ *
   * 气泡 / 提示
   * ============================================================ */
  function showBubble (text, ms = 1700) {
    if (!settings.bubble || !text) return
    bubbleText.textContent = text
    positionOverlays()
    bubble.classList.remove('hidden')
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), ms)
  }

  function showHint () {
    positionOverlays()
    hint.classList.remove('hidden')
    setTimeout(() => hint.classList.add('hidden'), 9000)
  }

  /* ============================================================ *
   * 指针交互
   * ============================================================ */
  function bindPointer () {
    window.addEventListener('mousemove', (e) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      if (dragging) {
        const nx = e.clientX - dragOffset.x
        const ny = e.clientY - dragOffset.y
        dragMoved += Math.abs(nx - petX) + Math.abs(ny - petY)
        petX = nx
        petY = ny
        layout()
      } else {
        needHitTest = true
      }
    }, { passive: true })

    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      if (isPanelTarget(e.target)) return
      // 能收到 mousedown 说明窗口此刻可交互，即指针位于模型上
      dragging = true
      dragMoved = 0
      dragOffset.x = e.clientX - petX
      dragOffset.y = e.clientY - petY
      setInteractive(true, '按下')
    })

    const endDrag = () => {
      if (!dragging) return
      dragging = false
      api.savePosition(petX, petY)
      if (dragMoved < CLICK_MOVE_TOLERANCE) {
        reactToClick()
      }
      needHitTest = true
    }
    window.addEventListener('mouseup', endDrag)
    window.addEventListener('blur', endDrag)

    window.addEventListener('dblclick', (e) => {
      if (e.button !== 0) return
      if (isPanelTarget(e.target)) return
      clearAllExpressions()
      showBubble('手动加的表情都收起来啦～')
    })

    window.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (isPanelTarget(e.target)) return
      api.openMenu()
    })

    window.addEventListener('wheel', (e) => {
      if (isPanelTarget(e.target)) return       // 面板里滚动不要缩放宠物
      e.preventDefault()
      const step = e.deltaY < 0 ? 40 : -40
      petHeight = clamp(petHeight + step, 160, 1000)
      layout()
      positionOverlays()
      api.setHeight(petHeight)
      showBubble(`${Math.round(petHeight)} px`, 900)
    }, { passive: false })

    window.addEventListener('resize', () => {
      if (!app) return
      app.renderer.resize(window.innerWidth, window.innerHeight)
      needHitTest = true
    })
  }

  function isPanelTarget (t) {
    return !!(t && t.closest && t.closest('#panel'))
  }

  /** 单击 = 摸摸头，交给养成引擎结算（心情/好感/经验 + 反应） */
  function reactToClick () {
    api.gameAction('pet')
  }

  /* ============================================================ *
   * 来自主进程的指令
   * ============================================================ */
  function bindIpc () {
    api.onAction((a) => {
      switch (a.kind) {
        case 'expression':
          toggleExpression(a.target)
          break
        case 'motion':
          playMotion(a.target)
          showBubble(`🎬 ${a.label || a.target}`)
          break
        case 'reset':
          clearAllExpressions()
          showBubble('↩️ 按键归位')
          break
        case 'random-expression': {
          const n = randomMomentExpression()
          if (n) addExpression(n, 'event', 5200)
          break
        }
        default:
          api.log('未知指令: ' + JSON.stringify(a))
      }
    })

    /* 养成引擎事件：条件变化、交互反应、自主行为都从这里来 */
    api.onEvents((events) => {
      for (const ev of events || []) {
        switch (ev.type) {
          case 'bubble':
            showBubble(ev.text, ev.ms || 2600)
            break
          case 'expression':
            addExpression(ev.target, ev.layer || 'event', ev.ttl || 6000)
            break
          case 'motion':
            playMotion(ev.target)
            break
          case 'mood':
            api.log(`情绪变化 -> ${ev.emoji} ${ev.name}（${ev.reason}）`)
            // 只有「有需求」的情绪才值得打断你
            if (NEED_MOODS.has(ev.mood)) showBubble(`${ev.emoji} ${ev.name}`)
            break
          default:
            break
        }
      }
    })

    /* 养成引擎快照：情绪层表情由它驱动 */
    api.onGame((g) => {
      if (g && g.snapshot) applyGameSnapshot(g.snapshot)
    })

    api.onSize((h) => {
      petHeight = h
      layout()
    })

    api.onPosition((p) => {
      petX = p.x
      petY = p.y
      layout()
    })

    api.onWorkArea((wa) => {
      workArea = wa
      if (app) app.renderer.resize(window.innerWidth, window.innerHeight)
      layout()
    })

    /* 可交互期间 mousemove 不再转发，靠主进程轮询喂光标位置 */
    api.onCursor((p) => {
      if (!p || typeof p.x !== 'number') return
      pointer.x = p.x
      pointer.y = p.y
      needHitTest = true
    })

    api.onBubbleSetting((on) => {
      settings.bubble = on
      if (!on) bubble.classList.add('hidden')
    })
  }

  /* ============================================================ *
   * 兜底错误
   * ============================================================ */
  window.addEventListener('error', (e) => {
    api.log(`渲染错误: ${e.message} @ ${e.filename}:${e.lineno}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    api.log(`未处理的 Promise 拒绝: ${e.reason && (e.reason.message || e.reason)}`)
  })

  /* 给面板（panel.js / chat.js）用的只读视图 + 布局回调 */
  window.PetView = {
    anchor: () => ({ x: petX, y: petY, height: petHeight }),
    workArea: () => ({ ...workArea }),
    relayout: () => layoutPanels(),
  }

  boot().catch((err) => {
    api.log('启动失败: ' + (err && err.stack ? err.stack : err))
    bubbleText.textContent = '启动失败，详情见日志'
    bubble.classList.remove('hidden')
  })
})()
