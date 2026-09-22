'use strict'
/**
 * 互动音效生成器 —— 全部程序合成，不依赖任何外部素材
 *
 *   node tools/make-sfx.js
 *
 * 为什么不用网上下载的音效：
 * 仓库是公开的 MIT，而绝大多数「免费音效站」的授权都只允许在作品里使用，
 * 禁止把原始音频文件再分发 / 做成素材库。程序合成的音效版权完全属于本项目，
 * 可以放心跟随 MIT 一起发布，而且每个只有几 KB。
 *
 * 生成的是 22050Hz / 16bit / 单声道 WAV，所有音色都围绕「捏橡皮小黄鸭」
 * 这个基调来设计。
 */

const fs = require('fs')
const path = require('path')

const SR = 22050
const OUT_DIR = path.join(__dirname, '..', 'sfx')

/* ================================================================== *
 * 基础工具
 * ================================================================== */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, p) => a + (b - a) * p
const sin = (ph) => Math.sin(ph * Math.PI * 2)
const tri = (ph) => { const x = ph % 1; return x < 0.5 ? x * 4 - 1 : 3 - x * 4 }
const sqr = (ph) => ((ph % 1) < 0.5 ? 1 : -1)

const buf = (dur) => new Float32Array(Math.max(1, Math.round(dur * SR)))

/** 把 src 叠加到 dst 的 atSec 处 */
function add (dst, src, atSec = 0, gain = 1) {
  const off = Math.round(atSec * SR)
  for (let i = 0; i < src.length; i++) {
    const j = off + i
    if (j >= 0 && j < dst.length) dst[j] += src[i] * gain
  }
  return dst
}

/**
 * 一个带包络的振荡器。
 * freqFn(p) 可以画任意音高曲线（0..1 -> Hz），这是做「捏鸭子」的关键。
 */
function tone ({ dur, f0 = 440, f1, freqFn, wave = 'tri', decay = 3, attack = 0.006, vib = 0, vibHz = 25, gain = 1 }) {
  const out = buf(dur)
  let ph = 0
  let vp = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const p = t / dur
    const base = freqFn ? freqFn(p) : (f1 === undefined ? f0 : lerp(f0, f1, p))
    vp += vibHz / SR
    const f = base * (1 + vib * sin(vp))
    ph += f / SR
    const w = wave === 'sin' ? sin(ph) : wave === 'sqr' ? sqr(ph) : tri(ph)
    out[i] = w * Math.min(1, t / attack) * Math.exp(-p * decay) * gain
  }
  return out
}

/** 噪声，可加一阶低通 / 高通，用来做气声、水花、摩擦 */
function noise ({ dur, decay = 6, attack = 0.002, lp = 0, hp = 0, gain = 1 }) {
  const out = buf(dur)
  let lo = 0
  let hlo = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const p = t / dur
    let x = Math.random() * 2 - 1
    if (lp) { const a = 1 - Math.exp(-2 * Math.PI * lp / SR); lo += a * (x - lo); x = lo }
    if (hp) { const a = 1 - Math.exp(-2 * Math.PI * hp / SR); hlo += a * (x - hlo); x -= hlo }
    out[i] = x * Math.min(1, t / attack) * Math.exp(-p * decay) * gain
  }
  return out
}

/** 归一化到统一峰值，并在结尾做短淡出，避免爆音 */
function finish (samples, peak = 0.85, fadeMs = 7) {
  let mx = 0
  for (let i = 0; i < samples.length; i++) mx = Math.max(mx, Math.abs(samples[i]))
  if (mx > 0) { const k = peak / mx; for (let i = 0; i < samples.length; i++) samples[i] *= k }
  const f = Math.min(samples.length, Math.round(SR * fadeMs / 1000))
  for (let i = 0; i < f; i++) samples[samples.length - 1 - i] *= i / f
  return samples
}

function toWav (samples) {
  const n = samples.length
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24)
  b.writeUInt32LE(SR * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), 44 + i * 2)
  }
  return b
}

/* ================================================================== *
 * 音效
 * ================================================================== */

/** 小黄鸭 squeak —— 先上滑再回落 + 快速颤音，这是捏橡皮鸭的招牌曲线 */
function squeak (pitch = 1) {
  const dur = 0.26
  const o = buf(dur)
  add(o, tone({
    dur,
    freqFn: (p) => (p < 0.32 ? lerp(660, 1460, p / 0.32) : lerp(1460, 780, (p - 0.32) / 0.68)) * pitch,
    wave: 'tri',
    decay: 2.1,
    attack: 0.011,
    vib: 0.05,
    vibHz: 30,
    gain: 1,
  }))
  // 三次谐波让它更「橡胶」
  add(o, tone({
    dur,
    freqFn: (p) => (p < 0.32 ? lerp(1980, 4380, p / 0.32) : lerp(4380, 2340, (p - 0.32) / 0.68)) * pitch,
    wave: 'sin',
    decay: 3.4,
    attack: 0.008,
    gain: 0.22,
  }))
  // 起手一点气声，像橡胶被挤压
  add(o, noise({ dur: 0.045, decay: 9, hp: 1400, gain: 0.22 }))
  return finish(o)
}

/** 开心两声短鸣 */
function happy () {
  const o = buf(0.38)
  add(o, tone({ dur: 0.1, f0: 900, f1: 1280, wave: 'tri', decay: 3.6, gain: 0.9 }))
  add(o, tone({ dur: 0.16, f0: 1080, f1: 1680, wave: 'tri', decay: 3.0, gain: 0.95 }), 0.13)
  add(o, tone({ dur: 0.16, f0: 2160, f1: 3360, wave: 'sin', decay: 4.5, gain: 0.2 }), 0.13)
  return finish(o)
}

/** 吃东西：几下闷闷的咀嚼 */
function nom () {
  const o = buf(0.46)
  const bite = (at, p) => {
    add(o, tone({ dur: 0.09, f0: 240 * p, f1: 150 * p, wave: 'tri', decay: 5, gain: 0.8 }), at)
    add(o, noise({ dur: 0.06, decay: 12, lp: 900, gain: 0.35 }), at)
  }
  bite(0, 1)
  bite(0.13, 1.12)
  bite(0.26, 0.92)
  return finish(o)
}

/** 弹跳 boing */
function boing () {
  const o = buf(0.36)
  const src = tone({
    dur: 0.36,
    freqFn: (p) => lerp(520, 150, Math.pow(p, 0.55)),
    wave: 'tri',
    decay: 2.6,
    gain: 1,
  })
  // 弹簧式幅度抖动
  for (let i = 0; i < src.length; i++) {
    const t = i / SR
    src[i] *= 1 + 0.35 * Math.exp(-t / 0.16) * sin(17 * t)
  }
  add(o, src)
  add(o, tone({ dur: 0.3, freqFn: (p) => lerp(1040, 300, Math.pow(p, 0.55)), wave: 'sin', decay: 3.6, gain: 0.22 }))
  return finish(o)
}

/** 水花：带通噪声下扫 + 几颗水珠 */
function splash () {
  const o = buf(0.55)
  const body = noise({ dur: 0.34, decay: 4.2, attack: 0.004, gain: 1 })
  const src = buf(0.34)
  let lp = 0
  for (let i = 0; i < src.length; i++) {
    const p = i / src.length
    const cut = lerp(5200, 900, p)
    const a = 1 - Math.exp(-2 * Math.PI * cut / SR)
    lp += a * (body[i] - lp)
    src[i] = lp
  }
  add(o, src)
  // 水珠
  for (const [at, f] of [[0.1, 1500], [0.19, 2100], [0.27, 1250], [0.35, 2600]]) {
    add(o, tone({ dur: 0.07, f0: f, f1: f * 1.7, wave: 'sin', decay: 6, gain: 0.3 }), at)
  }
  return finish(o)
}

/** 闪光 / 送礼：一串高频铃声 */
function sparkle () {
  const o = buf(0.7)
  const notes = [[0, 1568], [0.07, 2093], [0.14, 2637], [0.22, 3136], [0.31, 2093], [0.4, 2637]]
  for (const [at, f] of notes) {
    add(o, tone({ dur: 0.3, f0: f, wave: 'sin', decay: 5, attack: 0.004, gain: 0.6 }), at)
    add(o, tone({ dur: 0.3, f0: f * 2.01, wave: 'sin', decay: 7, gain: 0.18 }), at)
  }
  return finish(o, 0.8)
}

/** 升级：上行大三和弦琶音 */
function levelup () {
  const o = buf(0.95)
  const seq = [[0, 523.25], [0.11, 659.25], [0.22, 783.99], [0.33, 1046.5]]
  for (const [at, f] of seq) {
    add(o, tone({ dur: 0.55, f0: f, wave: 'tri', decay: 3.2, attack: 0.008, gain: 0.75 }), at)
    add(o, tone({ dur: 0.5, f0: f * 2, wave: 'sin', decay: 4.5, gain: 0.2 }), at)
  }
  add(o, tone({ dur: 0.5, f0: 1046.5, wave: 'sin', decay: 3, gain: 0.3 }), 0.33)
  return finish(o, 0.88)
}

/** 困了 / 睡觉：慢速下滑的哈欠 */
function sleepy () {
  const dur = 0.8
  const o = buf(dur)
  add(o, tone({
    dur,
    freqFn: (p) => lerp(600, 230, Math.pow(p, 0.75)),
    wave: 'tri',
    decay: 1.5,
    attack: 0.09,
    vib: 0.02,
    vibHz: 6,
    gain: 0.9,
  }))
  add(o, noise({ dur: 0.5, decay: 2.4, lp: 700, attack: 0.1, gain: 0.18 }), 0.1)
  return finish(o, 0.7)
}

/** 不行 / 被拒绝：两下闷响 */
function no () {
  const o = buf(0.3)
  add(o, tone({ dur: 0.1, f0: 190, f1: 150, wave: 'sqr', decay: 5, gain: 0.45 }))
  add(o, tone({ dur: 0.14, f0: 150, f1: 110, wave: 'sqr', decay: 4, gain: 0.45 }), 0.11)
  add(o, noise({ dur: 0.1, decay: 10, lp: 500, gain: 0.16 }))
  return finish(o, 0.55)
}

/** 醒来：短促上行 */
function wake () {
  const o = buf(0.24)
  add(o, tone({ dur: 0.2, f0: 520, f1: 1180, wave: 'tri', decay: 3.4, attack: 0.006, gain: 0.95 }))
  add(o, tone({ dur: 0.2, f0: 1560, f1: 3540, wave: 'sin', decay: 5, gain: 0.2 }))
  return finish(o)
}

/* ================================================================== *
 * 输出
 * ================================================================== */
const SOUNDS = {
  squeak,          // 摸摸头 / 点她
  happy,           // 喂食
  nom,             // 咀嚼
  boing,           // 玩耍
  splash,          // 洗澡
  sparkle,         // 送礼 / 成就
  levelup,         // 升级
  sleepy,          // 睡觉
  no,              // 操作被拒
  wake,            // 叫醒
}

function main () {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  let total = 0
  for (const [name, fn] of Object.entries(SOUNDS)) {
    const wav = toWav(fn())
    const file = path.join(OUT_DIR, name + '.wav')
    fs.writeFileSync(file, wav)
    total += wav.length
    console.log(`  ${name.padEnd(9)} ${(wav.length / 1024).toFixed(1).padStart(6)} KB   ${(wav.length - 44) / 2 / SR}s`)
  }
  console.log(`\n共 ${Object.keys(SOUNDS).length} 个音效，合计 ${(total / 1024).toFixed(0)} KB → ${OUT_DIR}`)
}

module.exports = { main, SOUNDS }

if (require.main === module) main()
