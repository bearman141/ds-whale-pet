'use strict'
/**
 * 生成 c_0120.model3.json
 *
 * 原始模型目录里 motions / exp3 文件是齐的，但 model3.json 只声明了
 * Moc / Textures / Physics / DisplayInfo —— 没有任何 Motions 与
 * Expressions。Cubism 运行时只认 model3.json 里的声明，所以这里把它
 * 补齐（动作组名与 catalog.js 的 MOTION_GROUPS 保持一致）。
 *
 * 用法：  node tools/make-model3.js
 */

const fs = require('fs')
const path = require('path')
const { MOTION_GROUPS, EXPRESSION_LABELS } = require('../catalog')

const MODEL_NAME = 'c_0120'

/**
 * 把动作文件的 Meta.Loop 改成 false（只有 idle 保持 true）。
 *
 * 为什么必须改：这套动作原本是给 VTube Studio 用的，那边靠
 * DeactivateAfterKeyUp / StopsOnLastFrame 在**外部**控制时长，所以文件里
 * 8 个动作的 Loop 全是 true。而 pixi-live2d-display 的 MotionManager 是这样的：
 *
 *   reserve(): IDLE 优先级在有动作在播时直接拒绝；NORMAL 也盖不过 NORMAL
 *   complete(): 只有动作**播完**才把 currentPriority 归零
 *
 * 于是循环动作永远不 complete，currentPriority 卡在 2 —— 之后所有动作和待机
 * 全部被拒，她会永远卡在第一个播出去的动作上（实测就是「一直在吹泡泡」）。
 */
function normalizeMotionLoops (modelDir) {
  const files = []
  const sub = path.join(modelDir, 'motions')
  if (fs.existsSync(sub)) {
    for (const f of fs.readdirSync(sub)) if (f.endsWith('.motion3.json')) files.push(path.join(sub, f))
  }
  for (const f of fs.readdirSync(modelDir)) {
    if (f.endsWith('.motion3.json')) files.push(path.join(modelDir, f))
  }

  const touched = []
  for (const file of files) {
    const base = path.basename(file, '.motion3.json')
    const wantLoop = base.toLowerCase() === 'idle'
    let json
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (!json.Meta || json.Meta.Loop === wantLoop) continue
    json.Meta.Loop = wantLoop
    fs.writeFileSync(file, JSON.stringify(json, null, '\t'), 'utf8')
    touched.push(`${base} → Loop:${wantLoop}`)
  }
  return touched
}

function build (modelDir) {
  const moc = `${MODEL_NAME}.moc3`
  if (!fs.existsSync(path.join(modelDir, moc))) {
    throw new Error(`找不到 ${moc}`)
  }

  // 贴图：按目录里实际存在的文件排序
  const textureDir = path.join(modelDir, `${MODEL_NAME}.2048`)
  const textures = fs
    .readdirSync(textureDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => `${MODEL_NAME}.2048/${f}`)

  // 动作组
  const motions = {}
  for (const g of MOTION_GROUPS) {
    if (!fs.existsSync(path.join(modelDir, g.file))) continue
    motions[g.name] = [
      { File: g.file, FadeInTime: g.loop ? 1.0 : 0.3, FadeOutTime: g.loop ? 1.0 : 0.5 },
    ]
  }

  // 表情
  const expressions = fs
    .readdirSync(modelDir)
    .filter((f) => f.endsWith('.exp3.json'))
    .sort()
    .map((f) => ({
      Name: f.slice(0, -'.exp3.json'.length),
      File: f,
    }))

  const settings = {
    Version: 3,
    FileReferences: {
      Moc: moc,
      Textures: textures,
      Physics: `${MODEL_NAME}.physics3.json`,
      DisplayInfo: `${MODEL_NAME}.cdi3.json`,
      Motions: motions,
      Expressions: expressions,
    },
    Groups: [
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ],
    HitAreas: [],
  }

  const out = path.join(modelDir, `${MODEL_NAME}.model3.json`)
  fs.writeFileSync(out, JSON.stringify(settings, null, '\t'), 'utf8')

  const loopFixed = normalizeMotionLoops(modelDir)

  const missingLabels = expressions
    .map((e) => e.Name)
    .filter((n) => !EXPRESSION_LABELS[n])

  return {
    out,
    motions: Object.keys(motions),
    expressions: expressions.length,
    missingLabels,
    loopFixed,
  }
}

module.exports = { build }

if (require.main === module) {
  const modelDir = path.join(__dirname, '..', 'model')
  const r = build(modelDir)
  console.log('已生成:', r.out)
  console.log(`动作组 ${r.motions.length} 个:`, r.motions.join(' / '))
  console.log(`表情 ${r.expressions} 个`)
  if (r.loopFixed && r.loopFixed.length) {
    console.log(`修正 Loop 标记 ${r.loopFixed.length} 个:`, r.loopFixed.join(', '))
  } else {
    console.log('Loop 标记已经是对的，无需修正')
  }
  if (r.missingLabels.length) {
    console.log('以下表情没有中文标签（菜单里会显示原名）:', r.missingLabels.join(', '))
  }
}
