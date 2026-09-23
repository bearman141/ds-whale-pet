'use strict'
/**
 * 列出某个参数在所有动作 / 表情里的取值，用来搞清楚它到底怎么用。
 *
 *   node app/tools/param-range.js point pointZ bi pi chehui
 *
 * 为什么需要它：模型自带的道具参数（点菜板 / 画笔 / 橡皮）在 model3.json 和
 * cdi3.json 里都没有取值范围，只有 Name。真正能看出「0 是关、1 是开」还是
 * 「0..1 连续变化」的地方，是动作文件的曲线。
 */

const fs = require('fs')
const path = require('path')

const MODEL_DIR = path.join(__dirname, '..', 'model')
const want = process.argv.slice(2)
if (!want.length) {
  console.error('用法: node app/tools/param-range.js <参数Id> [更多参数...]')
  process.exit(1)
}

/** 收集所有 motion3.json 和 exp3.json */
function files () {
  const out = []
  for (const f of fs.readdirSync(MODEL_DIR)) {
    if (f.endsWith('.motion3.json') || f.endsWith('.exp3.json')) out.push(path.join(MODEL_DIR, f))
  }
  const mdir = path.join(MODEL_DIR, 'motions')
  if (fs.existsSync(mdir)) {
    for (const f of fs.readdirSync(mdir)) {
      if (f.endsWith('.motion3.json') || f.endsWith('.exp3.json')) out.push(path.join(mdir, f))
    }
  }
  return out
}

const stat = new Map(want.map((w) => [w, { values: [], where: [] }]))

for (const file of files()) {
  let j
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
  const rel = path.relative(MODEL_DIR, file)

  // 动作：Curves[] = { Target, Id, Segments }，Segments 是 [type, ...] 的扁平数组，
  // 其中 value 都是成对出现的 (time, value)，type 2/3 还带额外控制点。
  const curves = []
  if (Array.isArray(j.Curves)) {
    for (const c of j.Curves) curves.push({ where: rel + ' / ' + c.Target, id: c.Id, seg: c.Segments })
  }
  // 表情：Parameters[] = { Id, Value, Blend }
  if (Array.isArray(j.Parameters)) {
    for (const p of j.Parameters) curves.push({ where: rel, id: p.Id, seg: null, value: p.Value })
  }

  for (const c of curves) {
    const s = stat.get(c.id)
    if (!s) continue
    if (c.seg) {
      // 段格式是 [type, ...] 重复。Cubism 的定义：
      //   0 Linear        -> [0, time, value]
      //   1 Bezier        -> [1, t0, v0, c0, c1, t1, v1]   (7 个)
      //   2 Stepped       -> [2, time, value]
      //   3 InverseStepped-> [3, time, value]
      const seg = c.seg
      let i = 0
      while (i < seg.length) {
        const t = seg[i]
        if (t === 1) {
          s.values.push(seg[i + 2], seg[i + 6])
          i += 7
        } else if (t === 0 || t === 2 || t === 3) {
          s.values.push(seg[i + 2])
          i += 3
        } else { break }
      }
      s.where.push(`${c.where} [${c.id}]`)
    } else {
      s.values.push(c.value)
      s.where.push(`${c.where} [${c.id}]`)
    }
  }
}

for (const id of want) {
  const s = stat.get(id)
  const uniq = [...new Set(s.where)]
  if (!s.values.length) {
    console.log(`${id.padEnd(9)} 没有任何动作/表情驱动它`)
    continue
  }
  const min = Math.min(...s.values)
  const max = Math.max(...s.values)
  const vals = [...new Set(s.values)].sort((a, b) => a - b)
  console.log(`${id.padEnd(9)} min=${min}  max=${max}  取值 {${vals.slice(0, 12).join(', ')}${vals.length > 12 ? ', …' : ''}}`)
  console.log(`          出现在: ${uniq.join(' | ')}`)
}
