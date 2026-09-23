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
  const KEYPULSE_TAU = 0.15        // 跟手脉冲的衰减时间常数（秒）

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
  const motionParams = new Map()  // 动作名 -> 它驱动的参数 id 列表

  /**
   * 动作留下的「道具参数」要手动收，否则会永远挂在脸上。
   *
   * 实测：Idle 动作驱动的 89 个参数和所有动作**完全不重叠**（Idle 用
   * Param73/maoshou* 那套，动作动的是 chuipaopao* / phone* / pengshui 这些）。
   * 所以吹泡泡「播完」回待机之后，chuipaopao* 会停在最后一帧的值上 ——
   * 泡泡就一直留在她脸上，换个角度看就是「动作没有归位」。
   *
   * clearedParams 里的参数每帧被强制写回模型初始值。
   */
  const clearedParams = new Set()
  let defaultParams = null        // 参数 id -> 模型初始值
  let idleParams = new Set()      // Idle 驱动的参数：这些不能强清，否则待机被冻住
  let pendingProbe = null         // 归位后下一帧在帧内抽查一次参数值

  /**
   * 这些参数由库自己每帧驱动，**绝对不能进 clearedParams**。
   *
   * 踩过的坑：视线跟随（updateFocus）是把结果 addParameterValueById 到
   * ParamAngleX/Y/Z、ParamEyeBallX/Y、ParamBodyAngleX 上的；眨眼写
   * ParamEyeLOpen/ROpen；呼吸写 ParamBreath。而 自拍 / 番茄酱 / 重锤出击
   * 这些动作**也驱动 ParamAngleX/Y/Z** —— 于是一按归位，它们就被塞进
   * clearedParams 每帧强制写 0，正好把视线跟随和眨眼的输出覆盖掉：
   * 眼睛不跟鼠标了、也不眨眼了。
   */
  const PROTECTED_PARAMS = new Set([
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY',
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamBreath',
    'ParamMouthOpenY', 'ParamMouthForm',
  ])

  let dragging = false
  let dragMoved = 0
  let dragOffset = { x: 0, y: 0 }
  let pointer = { x: -9999, y: -9999 }
  let needHitTest = false
  let interactiveNow = false
  let motionToken = 0
  let motionBusyUntil = 0
  let lastFrame = performance.now()
  let currentReact = null
  let keyPulse = 0          // 每次按键叠加的跟手脉冲，会自然衰减
  let pulseSeen = false

  const pixel = new Uint8Array(4)

  /* ============================================================ *
   * DOM
   * ============================================================ */
  const canvas = document.getElementById('stage')
  const bubble = document.getElementById('bubble')
  const bubbleText = document.getElementById('bubble-text')
  const hint = document.getElementById('hint')
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
    // 放到这里：要等表情和动作的元数据都到位，才知道有哪些参数需要记初始值
    captureDefaults()

    layout()
    startTicker()
    bindPointer()
    bindIpc()
    initSfx()
    playIdle()

    // 养成系统：开局先把当前情绪的条件结果套上
    // 输入联动：开局先把主进程算出来的当前反应套上
    if (init.react) applyReact(init.react)

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
        const vals = {}
        for (const k of Object.keys(mm)) {
          const v = mm[k]
          if (v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v)) vals[k] = v
          else if (Array.isArray(v)) vals[k] = `[${v.length}]`
          else if (v instanceof Map) vals[k] = `Map(${v.size})`
          else vals[k] = typeof v
        }
        api.log(`动作自检：playing=${mm.playing} ` +
          `stateGroup=${mm.state && mm.state.currentGroup} ` +
          `statePriority=${mm.state && mm.state.currentPriority} ` +
          `groups=[${Object.keys(mm.motionGroups || {}).join(',')}]`)
        const st = mm.state || {}
        const sv = {}
        for (const k of Object.keys(st)) {
          const v = st[k]
          sv[k] = (v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v)) ? v : typeof v
        }
        api.log('state 字段: ' + JSON.stringify(sv))
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

  /**
   * 记录「归位」要回到的目标值。
   *
   * 这里不去枚举模型全部参数（Cubism4 包装上没有 getParameterId），
   * 而是只取表情和动作里出现过的那些 —— 需要复位的本来也就只有这些。
   * 必须在 loadExpressionDefs / loadMotionMeta 之后、playIdle 之前调用。
   */
  function captureDefaults () {
    try {
      const core = model.internalModel.coreModel
      const ids = new Set()
      for (const list of motionParams.values()) for (const id of list) ids.add(id)
      for (const def of exprDefs.values()) {
        for (const p of def.Parameters || []) ids.add(p.Id)
      }

      const map = new Map()
      for (const id of ids) {
        try {
          if (typeof core.getParameterIndex === 'function' && core.getParameterIndex(id) < 0) continue
          map.set(id, core.getParameterValueById(id))
        } catch { /* 参数不存在就跳过 */ }
      }
      defaultParams = map
      api.log(`已记录 ${map.size} 个参数的初始值（归位基准）`)
    } catch (e) {
      api.log('记录参数初始值失败: ' + e.message)
    }
  }

  /** 动作开始：先把它的参数从「强制归位」名单里放出来，让它能动 */
  function releaseMotionParams (name) {
    const ids = motionParams.get(name)
    if (!ids || !ids.length) return
    for (const id of ids) clearedParams.delete(id)
  }

  /** 动作收尾：把它留下的道具参数加进强制归位名单（Idle 会驱动的不动，免得打架） */
  function clearMotionParams (name, quiet = false) {
    if (!defaultParams) return 0
    const ids = motionParams.get(name)
    if (!ids || !ids.length) return 0
    let n = 0
    for (const id of ids) {
      if (idleParams.has(id)) continue          // Idle 会驱动，别去打架
      if (PROTECTED_PARAMS.has(id)) continue    // 视线/眨眼/呼吸，清了就瞎了
      if (!defaultParams.has(id)) continue
      if (clearedParams.has(id)) continue
      clearedParams.add(id)
      n++
    }
    if (n && !quiet) api.log(`收尾归位：${name} 留下 ${n} 个参数`)
    return n
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
        // 记下这个动作会动哪些参数，收尾时要按这份名单复位
        motionParams.set(m.name, (json?.Curves || [])
          .filter((c) => c.Target === 'Parameter' && c.Id)
          .map((c) => c.Id))
      } catch (err) {
        motionMeta.set(m.name, { duration: 3, loop: !!m.loop })
        motionParams.set(m.name, [])
        api.log(`动作元数据加载失败 ${m.name}（按 3 秒处理）: ${err.message}`)
      }
    }))

    idleParams = new Set(motionParams.get('Idle') || [])
    const owned = [...motionParams.keys()].filter((n) => n !== 'Idle').length
    api.log(`动作参数表就绪：Idle 驱动 ${idleParams.size} 个参数，另有 ${owned} 个动作需要收尾`)
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
   * 视线跟随
   * ============================================================ */

  /**
   * 别用库自带的 `model.focus(x, y)`。
   *
   * 它的实现是：把光标换算到模型局部坐标 → 归一化 → `atan2` 求出**方向** →
   * 喂一个单位向量 `(cos a, -sin a)` 给 focusController。
   * 单位向量的模长恒为 1，而 updateFocus() 里是
   * `addParameterValueById(ParamAngleX, 30 * controller.x)` ——
   * 于是**永远是满偏转**：眼睛只会贴在左边或右边，看着像没在跟随。
   *
   * 这里直接驱动 focusController，按「光标相对模型中心的偏移量」做比例控制，
   * 得到 -1..1 的连续值，才是真正的「眼睛跟着鼠标转」。
   */
  function updateGaze () {
    if (!model) return
    const fc = model.internalModel && model.internalModel.focusController
    if (!fc) return

    const cx = petX
    const cy = petY - petHeight * 0.5          // 视觉中心大约在锚点上方半个身位
    const rangeX = Math.max(140, petHeight * 0.9)
    const rangeY = Math.max(110, petHeight * 0.7)

    const nx = clamp((pointer.x - cx) / rangeX, -1, 1)
    let ny = clamp((cy - pointer.y) / rangeY, -1, 1)   // 屏幕 y 轴向下，取反

    // 你在打字的时候，她的目光会往下偏一点 —— 像是也在看你的键盘
    if (currentReact && (currentReact.id === 'working' || currentReact.id === 'excited')) {
      ny = clamp(ny - 0.45, -1, 1)
    }

    // focusController 自带速度平滑，不需要我们再做插值
    fc.focus(nx, ny)
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
        updateGaze()
      }

      tickExpressionStack(dt)
      motionWatchdog(now)

      // 跟手脉冲自然衰减（指数衰减，时间常数 120ms）
      if (keyPulse > 0.002) keyPulse *= Math.exp(-dt / KEYPULSE_TAU)
      else keyPulse = 0

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
   *   react 反应层 —— 输入联动引擎按你的键鼠活动实时推导，一变自动换
   *   prop  道具层 —— 热键手动开关（墨镜、桌布…），一直保留
   *   event 事件层 —— 交互 / 点击 / 聊天回复的即时反应，带 TTL 自动淡出
   * 同名表情只保留层级最高的那个，高层不会被低层打断。
   *
   * 混合模式按原始 exp3 里的 Blend 走（基本都是 Add），所以多个表情能叠加。
   * ============================================================ */
  const LAYER_RANK = { react: 10, prop: 20, event: 30 }

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
    if (!model) return
    const core = model.internalModel.coreModel

    // 动作留下的道具参数：每帧写回模型初始值，否则会永远挂在脸上。
    // 注意这里是**帧内**、正好在 coreModel.update() 之前，所以写进去的值
    // 就是这一帧真正拿去绘制（并交给物理/pose）的值。
    // 帧末库会 loadParameters() 把「存档值」恢复回来，所以在帧外读参数
    // 看到的仍是旧值 —— 别用帧外的读数量判断复位有没有生效。
    if (clearedParams.size && defaultParams) {
      for (const id of clearedParams) {
        try { core.setParameterValueById(id, defaultParams.get(id)) } catch { /* ignore */ }
      }
      if (pendingProbe) {
        const p = pendingProbe
        pendingProbe = null
        api.log('归位抽查（帧内 = 绘制用的值）' + p
          .map((x) => `${x.id} ${x.before.toFixed(2)}→${core.getParameterValueById(x.id).toFixed(2)}`)
          .join('   '))
      }
    }

    // 跟手节拍：你每敲一下键，她点一下头。
    // 这是整套「输入联动」里最像 BongoCat 的部分 —— 用 addParameterValueById
    // 是「叠加」语义，不会覆盖视线跟随和物理算出来的值。
    // 必须放在下面那个 early return 之前，否则没表情时就不抖了。
    //
    // 幅度调过两轮：2.4°/1.5° → 5.0°/3.0° → 现在 5.5°/4.5°。
    // 前两轮用户都反馈「根本看不出来」，所以别怕做重：连打时上限 2.6 × 4.5° ≈ 12°，
    // 一眼就能看见她在跟着你的手速点头，单次轻敲也还有约 4°。
    if (keyPulse > 0.002) {
      try {
        core.addParameterValueById('ParamAngleY', -keyPulse * 5.5)
        core.addParameterValueById('ParamBodyAngleZ', keyPulse * 4.5)
      } catch { /* ignore */ }
    }

    if (!exprState.size) return
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
   * @param {'react'|'prop'|'event'} layer
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
   * 反应层同步 —— 「表情随情况自动变」的落地点。
   *
   * 原来这里的输入是养成引擎推导的情绪（饿/困/心情差），
   * 现在换成输入联动引擎推导的**反应**（在打字/被带嗨/犯困/你回来啦）。
   * 机制没变：规则一变，就把这一层整体替换掉。
   */
  let lastReactKey = ''
  function syncReactLayer (list) {
    const want = new Set((list || []).filter((n) => exprDefs.has(n)))
    const key = [...want].sort().join('|')
    if (key === lastReactKey) return
    lastReactKey = key

    for (const [name, st] of [...exprState]) {
      if (st.layer === 'react' && !want.has(name)) removeExpression(name, 'react')
    }
    for (const n of want) {
      const st = exprState.get(n)
      if (!st || st.layer === 'react') addExpression(n, 'react')
    }
    api.log(`反应表情 -> [${[...want].join(', ')}]`)
  }

  /** 清掉手动加的东西，保留当前反应层（反应是状态，不该被「归位」清掉） */
  function clearAllExpressions ({ silent = false } = {}) {
    for (const name of [...exprState.keys()]) {
      const st = exprState.get(name)
      if (st.layer === 'react') continue
      removeExpression(name, null, { silent: true })
    }
    if (!silent) api.log('清空表情（保留当前反应）')
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

  /**
   * 强行回到待机。
   *
   * 必须先 motionManager.complete() 把优先级归零 —— 库的逻辑是
   * 「IDLE 在有动作在播时直接拒绝」，而 currentPriority 只有动作**播完**
   * 才会归零。一旦有个动作卡住（比如模型里 Loop:true 的循环动作），
   * 之后连待机都起不来，她会永远定在那个动作上。
   */
  /**
   * 把 MotionManager 的优先级状态归零。
   *
   * 注意字段位置：currentPriority / currentGroup 和复位方法 complete()
   * 都挂在 **mm.state** 上，不在 mm 本身。写成 mm.complete() 会被
   * typeof 守卫静默跳过 —— 看起来没报错，实际优先级从没复位过。
   */
  function resetMotionState () {
    try {
      const mm = model && model.internalModel && model.internalModel.motionManager
      if (!mm) return
      const st = mm.state
      if (st && typeof st.complete === 'function') st.complete()
      else if (typeof mm.complete === 'function') mm.complete()
    } catch (e) {
      api.log('复位动作优先级失败: ' + e.message)
    }
  }

  function forceIdle (why) {
    if (!model) return
    resetMotionState()
    api.log(`回待机（${why}）`)
    playIdle()
  }

  function playMotion (name) {
    if (!model) return
    const meta = motionMeta.get(name)
    const token = ++motionToken
    const dur = (meta ? meta.duration : 3) + 0.45
    api.log(`播放动作：${name}（时长 ${meta ? meta.duration : '?'}s）`)

    let returned = false
    const backToIdle = (why) => {
      if (returned || token !== motionToken) return
      returned = true
      // 先把它留下的道具参数收干净，再回待机 —— 否则泡泡会一直挂着
      clearMotionParams(name)
      forceIdle(`${name} ${why}`)
    }
    // 看门狗的时间基准：超过这个点还没回待机就说明卡了
    motionBusyUntil = performance.now() + dur * 1000

    releaseMotionParams(name)

    let result
    try {
      result = model.motion(name, 0, PRIORITY.NORMAL)
    } catch (e) {
      api.log(`动作播放异常 ${name}: ${e.message}`)
      backToIdle('异常')
      return
    }

    if (result && result.then) {
      result.then((ok) => {
        // 注意：ok=true 只代表「动作已开始」（实测 4~6ms 就 resolve），
        // 绝不能据此回待机 —— 否则动作刚起步就被掐掉，看起来像没播。
        // 只有 ok=false（优先级被拒）才需要立刻收场。
        if (!ok) {
          api.log(`动作被拒（优先级不足）：${name}`)
          backToIdle('被拒')
        }
      }).catch(() => {})
    }

    // 兜底：不管文件里 Loop 写的是什么，到点一律拽回待机
    setTimeout(() => backToIdle('时长到时'), dur * 1000)
  }

  /**
   * 停掉所有正在播的动作，并把它留下的道具参数收干净。
   * 「归位」用这个 —— 光清表情是不够的，动作留下的泡泡/手机/喷水也得收。
   */
  function stopMotions ({ quiet = false } = {}) {
    if (!model) return 0
    motionToken++          // 让所有在途的收尾定时器失效
    motionBusyUntil = 0

    // 所有非 idle 动作留下的道具统统收掉（Idle 会驱动的参数会被跳过）
    let added = 0
    for (const name of motionParams.keys()) {
      if (name !== 'Idle') added += clearMotionParams(name, true)
    }

    try {
      const mm = model.internalModel.motionManager
      if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions()
    } catch (e) {
      api.log('停止动作失败: ' + e.message)
    }
    resetMotionState()

    if (!quiet && added) api.log(`停止动作：新收 ${added} 个道具参数`)
    return added
  }

  /** 归位：表情清空 + 动作停止 + 道具参数复位 + 回待机 */
  function resetAll ({ silent = false } = {}) {
    // 抽查：优先盯「正在播的那个动作」的参数 —— 那才是真正需要复位的。
    // 必须在停动作之前取值，否则读到的已经是复位后的了。
    let probe = null
    let wasPlaying = ''
    try {
      const core = model.internalModel.coreModel
      const mm = model.internalModel.motionManager
      wasPlaying = (mm && mm.state && mm.state.currentGroup) || ''
      const own = wasPlaying && motionParams.get(wasPlaying)
      const ids = (own && own.length ? own : [...clearedParams])
        .filter((id) => !idleParams.has(id) && defaultParams && defaultParams.has(id))
        .slice(0, 6)
      if (ids.length) probe = ids.map((id) => ({ id, before: core.getParameterValueById(id) }))
    } catch { /* ignore */ }

    clearAllExpressions({ silent: true })
    stopMotions({ quiet: true })
    playIdle()

    // 抽查放到下一帧的 beforeModelUpdate 里做：那里读到的才是绘制值
    if (probe && probe.length) {
      pendingProbe = probe
      api.log(`归位抽查准备（原动作 ${wasPlaying || '无'}）`)
    }

    if (!silent) {
      api.log(`按键归位：表情清空、动作停止、${clearedParams.size} 个道具参数复位`)
    }
  }

  /**
   * 动作看门狗：万一还有别的路径把动作卡住（比如被拒后 currentPriority 没归零），
   * 这里兜底把她拽回待机，而不是永远定在那一帧。
   */
  function motionWatchdog (now) {
    if (!model || dragging) return
    if (now < motionBusyUntil + 2500) return
    try {
      const mm = model.internalModel.motionManager
      const st = mm && mm.state
      if (st && st.currentPriority > 0 && st.currentGroup && st.currentGroup !== 'Idle') {
        api.log(`动作看门狗：卡在「${st.currentGroup}」（优先级 ${st.currentPriority}），强制回待机`)
        forceIdle('看门狗')
      }
    } catch { /* ignore */ }
    motionBusyUntil = now + 4000
  }

  function randomMomentExpression () {
    const pool = RANDOM_POOL.filter((n) => exprDefs.has(n))
    if (!pool.length) return null
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /**
   * 应用一次「输入反应」（条件驱动表情的入口）。
   * 引擎每次判定出的反应带哪些表情，就直接替换反应层。
   */
  function applyReact (r) {
    if (!r) return
    currentReact = r
    syncReactLayer(r.expressions)
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
   * 互动音效
   *
   * 音效全部由 app/tools/make-sfx.js 程序合成 —— 不引外部素材，
   * 所以授权可以跟着 MIT 走（下载来的「免费音效」大多禁止再分发）。
   *
   * 用 <audio> + cloneNode 是为了让同一个音效可以重叠播放（连点的时候）。
   * 自动播放限制由主进程的 autoplay-policy 开关解除。
   * ============================================================ */
  const SFX_NAMES = ['key', 'squeak', 'happy', 'nom', 'boing', 'splash', 'sparkle', 'levelup', 'sleepy', 'no', 'wake']
  const sfxPool = new Map()
  let sfxVerified = false

  function initSfx () {
    for (const n of SFX_NAMES) {
      const a = new Audio(`pet://local/sfx/${n}.mp3`)
      a.preload = 'auto'
      // 仓库里默认是下载 + ffmpeg 处理过的 mp3。
      // 如果你更想用纯合成的版本（tools/make-sfx.js 生成的是 wav），
      // 把 mp3 删掉即可 —— 这里会自动退回 wav。
      a.addEventListener('error', () => {
        if (!/\.wav$/.test(a.src)) a.src = `pet://local/sfx/${n}.wav`
      }, { once: true })
      sfxPool.set(n, a)
    }
    api.log(`音效已装载 ${SFX_NAMES.length} 个`)
  }

  function playSfx (name, gain = 1, force = false, rate = 1) {
    if ((!settings.sfx && !force) || !name) return
    const base = sfxPool.get(name)
    if (!base) { api.log('未知音效: ' + name); return }
    try {
      const a = base.cloneNode()
      const vol = settings.sfxVolume == null ? 0.6 : settings.sfxVolume
      a.volume = Math.max(0, Math.min(1, vol * gain))
      if (rate !== 1) a.playbackRate = rate
      const p = a.play()
      if (p && p.then) {
        p.then(() => {
          // play() 只有真的开始播才会 resolve，这行足以证明音频通路是通的
          if (!sfxVerified) { sfxVerified = true; api.log(`音效播放成功（首个：${name}，音量 ${a.volume.toFixed(2)}）`) }
        }).catch((e) => api.log(`音效播放失败 ${name}: ${e.message}`))
      }
    } catch (e) {
      api.log('音效异常: ' + e.message)
    }
  }

  /* ---------------------------------------------------------------- *
   * 每键的「哒」声
   *
   * 这是整套输入联动里最要紧的一环。表情可以一直不变，但**每敲一下都得有回应**，
   * 否则用户会觉得桌宠根本没在工作 —— 这正是最初「反应在哪？声音也没了」的原因。
   *
   * 三个细节：
   *  - 最小间隔 32ms：连打时不会叠成一团噪音，也不会漏掉明显的手速
   *  - 每次随机 ±10% 变调：一个文件听起来才不像复读机
   *  - 音量压到 0.42：它是背景里的「哒」，不能盖过状态切换时的音效
   * ---------------------------------------------------------------- */
  const KEY_SFX_MIN_GAP = 32
  let lastKeySfxAt = 0

  function playKeyTick () {
    const now = performance.now()
    if (now - lastKeySfxAt < KEY_SFX_MIN_GAP) return
    lastKeySfxAt = now
    playSfx('key', 0.42, false, 0.9 + Math.random() * 0.22)
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
      resetAll()
      showBubble('表情和动作都收起来啦～')
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
    return !!(t && t.closest && t.closest('#panels'))
  }

  /**
   * 单击 = 摸摸头。
   *
   * 养成系统砍掉之后就没有主进程结算了，所以这里直接给本地反应。
   * （之前这里还在调 api.gameAction，那个 IPC 已经删了 —— 点她等于直接抛异常，
   *   表现就是「点什么都没反应」，这个 bug 是用户报出来的。）
   */
  const PET_LINES = ['呼噜呼噜～', '嗯……舒服', '嘿嘿', '再摸摸嘛', '（蹭了蹭你的手）']

  // 点在她身上时已经有一声 squeak 了，别再叠一声「哒」
  let lastPetClickAt = 0

  function reactToClick () {
    lastPetClickAt = performance.now()
    addExpression('脸红', 'event', 2000)
    playSfx('squeak', 0.9)
    if (Math.random() < 0.45) showBubble(PET_LINES[Math.floor(Math.random() * PET_LINES.length)])
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
          resetAll()
          showBubble('↩️ 已归位')
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

    /* 主进程推来的表现指令（聊天回复、归位、音效…） */
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
          case 'sound':
            playSfx(ev.name, ev.gain || 1)
            break
          default:
            break
        }
      }
    })

    /* 输入联动：当前反应 → 反应层表情 + 台词 + 音效 */
    api.onReact((r) => {
      if (!r) return
      currentReact = r
      syncReactLayer(r.expressions)
      // 这两行原来漏了 —— 载荷里明明带着 bubble / sfx，渲染层却没接，
      // 结果犯困、你回来啦、被带嗨这几个音效和台词全都不出声。
      if (r.bubble) showBubble(r.bubble, 3000)
      if (r.sfx) playSfx(r.sfx)
      if (r.bubble || r.sfx) {
        api.log(`反应表现 -> ${r.sfx ? '音效 ' + r.sfx : ''}${r.sfx && r.bubble ? ' + ' : ''}` +
          `${r.bubble ? '台词「' + r.bubble + '」' : ''}`)
      }
    })

    /* 每一次按键的跟手节拍：一声「哒」+ 累加一个脉冲，渲染时衰减成一下点头 */
    api.onKeyPulse((p) => {
      if (!p) return
      if (!pulseSeen) { pulseSeen = true; api.log(`跟手脉冲已收到（gain=${p.gain}）`) }
      keyPulse = Math.min(2.6, keyPulse + (p.gain || 1))
      playKeyTick()
    })

    /* 鼠标点一下也算一次「哒」—— 点桌面、点按钮都该有回应。
       点在她自己身上的那一下除外：那种情况上面已经响过 squeak 了。 */
    api.onClickPulse(() => {
      if (performance.now() - lastPetClickAt < 400) return
      playKeyTick()
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

    api.onSfxSetting((s) => {
      if (!s) return
      const wasOn = settings.sfx
      settings.sfx = !!s.enabled
      settings.sfxVolume = s.volume
      // 从关到开时给个即时反馈
      if (settings.sfx && !wasOn) playSfx('squeak', 0.8)
    })

    api.onSfxTest(() => playSfx('sparkle', 1, true))
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
