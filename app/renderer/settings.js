'use strict'
/**
 * 「其他设置」面板（三级窗口）
 *
 * 结构上分三级：
 *   一级 —— 右键 / 托盘菜单：只留常用动作（聊天、表情、动作、大小）+ 实时状态
 *   二级 —— 原生子菜单：表情 / 动作 / 大小这些**选择类**的东西
 *   三级 —— 这个面板：所有**设置类**的开关
 *
 * 为什么设置类要单独开一个面板而不是继续堆在菜单里：
 *  - 原生菜单放不下音量滑条，也没法写一行说明
 *  - 菜单每次点开都要重建，一堆复选框混在动作项里，想找的东西很难扫到
 *  - 面板能自动贴着宠物排布（跟聊天面板共用 #panels 那套定位）
 *
 * 开关的真相在 settings.json，这里只负责显示和回写，不做任何本地状态 ——
 * 每次都从主进程拉最新值（api.settingsGet），避免两边各存一份对不上。
 */
;(function () {
  const api = window.petAPI
  const $ = (id) => document.getElementById(id)

  const box = $('settings')
  if (!box) return

  // 和主进程 settingsView() 的键一一对应
  const TOGGLES = ['alwaysOnTop', 'clickThrough', 'inputReact', 'hotkeys', 'bubble', 'sfx', 'autoLaunch']

  let visible = false
  let posTimer = null
  let applying = false      // 回写设置时不要把 paint() 的变化又当成用户操作发回去

  /* ------------------------------------------------------------ *
   * 显隐 / 定位（和聊天面板同样的做法）
   * ------------------------------------------------------------ */
  function toggle (force) {
    const show = force === undefined ? !visible : !!force
    if (show === visible) return
    visible = show
    box.classList.toggle('hidden', !visible)

    if (visible) {
      refresh()
      window.PetView && window.PetView.relayout()
      if (!posTimer) posTimer = setInterval(() => window.PetView && window.PetView.relayout(), 400)
    } else {
      clearInterval(posTimer)
      posTimer = null
      window.PetView && window.PetView.relayout()
    }
    api.log(`其他设置面板 ${visible ? '打开' : '关闭'}`)
  }

  /* ------------------------------------------------------------ *
   * 显示 / 回写
   * ------------------------------------------------------------ */
  function paint (s) {
    if (!s) return
    applying = true
    for (const k of TOGGLES) {
      const el = $('s-' + k)
      if (el) el.checked = !!s[k]
    }
    const vol = Math.round((s.sfxVolume == null ? 0.6 : s.sfxVolume) * 100)
    const slider = $('s-volume')
    if (slider) slider.value = String(vol)
    $('s-volume-val').textContent = String(vol)
    applying = false
  }

  async function refresh () {
    try {
      paint(await api.settingsGet())
    } catch (e) {
      api.log('读设置失败: ' + (e && e.message ? e.message : e))
    }
  }

  /* ------------------------------------------------------------ *
   * 绑定
   * ------------------------------------------------------------ */
  for (const k of TOGGLES) {
    const el = $('s-' + k)
    if (!el) continue
    el.addEventListener('change', () => {
      if (applying) return
      api.settingsSet(k, el.checked)
    })
  }

  // 拖动时只更新数字，松手才真正写回去 —— 免得一路拖一路存盘
  const slider = $('s-volume')
  slider.addEventListener('input', () => { $('s-volume-val').textContent = slider.value })
  slider.addEventListener('change', () => {
    if (!applying) api.settingsSet('sfxVolume', Number(slider.value) / 100)
  })

  $('s-sfx-test').addEventListener('click', () => api.settingsDo('sfx-test'))
  $('s-reset-pos').addEventListener('click', () => api.settingsDo('reset-position'))
  $('s-reset').addEventListener('click', () => api.settingsDo('reset'))
  $('s-readme').addEventListener('click', () => api.settingsDo('open-readme'))
  $('s-open-dir').addEventListener('click', () => api.settingsDo('open-model-dir'))
  $('s-close').addEventListener('click', () => toggle(false))

  api.onSettingsPanel((p) => { if (p && p.toggle) toggle() })
  // 别处（比如托盘菜单）改了设置时同步过来
  api.onSettingsChanged((s) => { if (visible) paint(s) })

  api.log('其他设置面板已就绪')
})()
