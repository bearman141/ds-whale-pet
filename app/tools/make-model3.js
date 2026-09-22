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

  const missingLabels = expressions
    .map((e) => e.Name)
    .filter((n) => !EXPRESSION_LABELS[n])

  return {
    out,
    motions: Object.keys(motions),
    expressions: expressions.length,
    missingLabels,
  }
}

module.exports = { build }

if (require.main === module) {
  const modelDir = path.join(__dirname, '..', 'model')
  const r = build(modelDir)
  console.log('已生成:', r.out)
  console.log(`动作组 ${r.motions.length} 个:`, r.motions.join(' / '))
  console.log(`表情 ${r.expressions} 个`)
  if (r.missingLabels.length) {
    console.log('以下表情没有中文标签（菜单里会显示原名）:', r.missingLabels.join(', '))
  }
}
