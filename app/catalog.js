'use strict'
/**
 * 模型能力目录 + 热键表
 *
 * 热键完全依据模型自带的《按键表.txt》整理，
 * 动作 / 表情文件名与 model 目录中的实际文件一一对应。
 */

const fs = require('fs')
const path = require('path')

/* ------------------------------------------------------------------ *
 * 菜单显示名（模型文件名 -> 中文名）
 * ------------------------------------------------------------------ */
const EXPRESSION_LABELS = {
  love: '冒爱心',
  兔兔贴纸: '兔兔贴纸',
  单边马尾: '发型切换（单边马尾）',
  双手比耶: '双手比耶',
  吐舌: '吐舌',
  吐魂: '吐魂',
  呆呆眼: '呆呆眼',
  哭: '大哭',
  喵喵手动画: '喵喵手~喵~',
  '喵喵手~喵~动画': '喵喵手~喵~',
  圆眼镜: '圆眼镜',
  墨镜: '墨镜',
  头箍: '摘掉发箍',
  巴菲: '桌面芭菲',
  开心兴奋: '兴奋',
  心跳: '心跳',
  悲伤: '悲伤',
  情绪花花: '情绪花花',
  感叹号: '感叹号',
  手机换色: '手机换色',
  挤: '挤番茄酱 MoeMoeQ~',
  撤回: '撤回',
  方眼镜: '方眼镜',
  星星眼: '星星眼',
  晕晕: '晕晕眼',
  椭圆眼镜: '椭圆眼镜',
  橡皮: '橡皮',
  流汗: '汗',
  深色桌布: '深色桌布',
  点菜按下: '点菜按下',
  爱心眼: '爱心眼',
  猫猫贴纸: '猫猫贴纸',
  生气: '生气',
  画笔: '画笔',
  脸红: '脸红',
  蛋包饭: '【蛋包饭】模式',
  蝴蝶结贴纸: '蝴蝶结贴纸',
  调皮: '调皮',
  闭眼口水: '闭眼口水',
  问号: '问号',
  阴暗: '阴暗',
  魔爪: '桌面粉魔爪',
  魔爪换色: '粉魔爪变白',
  鲸鱼: '头顶鲸',
  鲸鱼放桌上: '鲸鱼放桌上',
}

/**
 * 动作组定义 —— 唯一事实来源。
 * tools/make-model3.js 用它生成 model3.json 的 Motions 段，
 * 运行时菜单与热键也用同一份数据，保证组名一致。
 */
const MOTION_GROUPS = [
  { name: 'Idle', file: 'motions/idle.motion3.json', loop: true, label: '待机（循环）' },
  { name: '喷水', file: 'motions/喷水.motion3.json', loop: false, label: '鲸鱼喷水' },
  { name: '开盖', file: 'motions/开盖.motion3.json', loop: false, label: '自拍手机 / 放下' },
  { name: '番茄酱', file: 'motions/番茄酱.motion3.json', loop: false, label: '挤番茄酱' },
  { name: '自拍', file: 'motions/自拍.motion3.json', loop: false, label: '快速自拍' },
  { name: '自拍简单', file: 'motions/自拍简单.motion3.json', loop: false, label: '自拍动画' },
  { name: '吹泡泡', file: 'motions/chuipaopao.motion3.json', loop: false, label: '吹泡泡糖' },
  { name: '重锤出击', file: 'aidale.motion3.json', loop: false, label: '重锤出击' },
]

/* ------------------------------------------------------------------ *
 * 按键表
 *
 * combo 使用规范化写法：修饰键 + 主键，'+' 连接。
 *   Alt / Ctrl / Shift / Meta   —— 左右不区分（保留默认）
 *   LAlt LCtrl RAlt RCtrl RShift —— 指定左右
 *   Num0..Num9 NumDec NumMul NumDiv NumAdd NumSub —— 小键盘
 *   Up Down Left Right PageUp PageDown Home End Ins Del Enter Space Tab Esc
 *   A..Z  0..9  F1..F12
 * ------------------------------------------------------------------ */
const HOTKEY_TABLE = [
  /* ---- 左 Alt + 上排数字 ---- */
  { combo: 'Alt+1', kind: 'expression', target: '鲸鱼', label: '头顶鲸' },
  { combo: 'Alt+2', kind: 'expression', target: '单边马尾', label: '发型切换' },
  { combo: 'Alt+3', kind: 'expression', target: '头箍', label: '摘掉发箍' },
  { combo: 'Alt+4', kind: 'expression', target: '深色桌布', label: '深色桌布' },

  /* ---- 左 Alt + 字母：表情 ---- */
  { combo: 'Alt+Q', kind: 'expression', target: '悲伤', label: '悲伤' },
  { combo: 'Alt+W', kind: 'expression', target: '星星眼', label: '星星眼' },
  { combo: 'Alt+E', kind: 'expression', target: '爱心眼', label: '爱心眼' },
  { combo: 'Alt+R', kind: 'expression', target: '呆呆眼', label: '呆呆眼' },
  { combo: 'Alt+T', kind: 'expression', target: '闭眼口水', label: '闭眼口水' },
  { combo: 'Alt+Y', kind: 'expression', target: '哭', label: '大哭' },
  { combo: 'Alt+U', kind: 'expression', target: '开心兴奋', label: '兴奋' },
  { combo: 'Alt+I', kind: 'expression', target: '晕晕', label: '晕晕眼' },
  { combo: 'Alt+O', kind: 'expression', target: '生气', label: '生气' },
  { combo: 'Alt+P', kind: 'expression', target: '调皮', label: '调皮' },
  { combo: 'Alt+S', kind: 'expression', target: '阴暗', label: '阴暗' },
  { combo: 'Alt+D', kind: 'expression', target: '脸红', label: '脸红' },
  { combo: 'Alt+F', kind: 'expression', target: '问号', label: '问号' },
  { combo: 'Alt+G', kind: 'expression', target: '流汗', label: '汗' },
  { combo: 'Alt+H', kind: 'expression', target: '感叹号', label: '感叹号' },
  { combo: 'Alt+J', kind: 'expression', target: '圆眼镜', label: '圆眼镜' },
  { combo: 'Alt+K', kind: 'expression', target: '方眼镜', label: '方眼镜' },
  { combo: 'Alt+L', kind: 'expression', target: '椭圆眼镜', label: '椭圆眼镜' },
  { combo: 'Alt+Z', kind: 'expression', target: '墨镜', label: '墨镜' },
  { combo: 'Alt+X', kind: 'expression', target: '情绪花花', label: '情绪花花' },
  { combo: 'Alt+C', kind: 'expression', target: '心跳', label: '心跳' },
  { combo: 'Alt+V', kind: 'expression', target: '猫猫贴纸', label: '猫猫贴纸' },
  { combo: 'Alt+B', kind: 'expression', target: '兔兔贴纸', label: '兔兔贴纸' },
  { combo: 'Alt+N', kind: 'expression', target: '蝴蝶结贴纸', label: '蝴蝶结贴纸' },
  { combo: 'Alt+M', kind: 'expression', target: '吐魂', label: '吐魂' },

  /* ---- Del(小键盘 .) + 小键盘数字 ---- */
  { combo: 'NumDec+Num1', kind: 'expression', target: '鲸鱼放桌上', label: '鲸鱼放桌上' },
  { combo: 'NumDec+Num2', kind: 'expression', target: '蛋包饭', label: '【蛋包饭】模式' },
  { combo: 'NumDec+Num3', kind: 'expression', target: '挤', label: '挤番茄酱 MoeMoeQ~' },
  { combo: 'NumDec+Num4', kind: 'motion', target: '开盖', label: '自拍手机＆放下' },
  { combo: 'NumDec+Num5', kind: 'motion', target: '自拍简单', label: '自拍动画' },
  { combo: 'NumDec+Num6', kind: 'motion', target: '自拍', label: '快速自拍' },
  { combo: 'NumDec+Num7', kind: 'expression', target: '喵喵手~喵~动画', label: '喵喵手~喵~' },
  { combo: 'NumDec+Num8', kind: 'expression', target: 'love', label: '冒爱心' },
  { combo: 'NumDec+Num9', kind: 'expression', target: '双手比耶', label: '双手比耶' },

  /* ---- 右 Ctrl ---- */
  { combo: 'RCtrl+M', kind: 'expression', target: '吐舌', label: '吐舌' },
  { combo: 'RCtrl+PageUp', kind: 'motion', target: '吹泡泡', label: '吹泡泡糖' },
  { combo: 'RCtrl+Del', kind: 'motion', target: '重锤出击', label: '重锤出击' },

  /* ---- 小键盘 * ---- */
  { combo: 'NumMul+3', kind: 'expression', target: '巴菲', label: '收起桌面芭菲' },
  { combo: 'NumMul+4', kind: 'expression', target: '魔爪', label: '桌面粉魔爪' },
  { combo: 'NumMul+5', kind: 'expression', target: '魔爪换色', label: '粉魔爪变白' },

  /* ---- 归位 ---- */
  { combo: 'PageUp+PageDown', kind: 'reset', target: '', label: '按键归位（表情 + 动作一起复位）' },

  /* ---- 聊天面板（Ctrl+Alt + 字母，避开原按键表） ---- */
  { combo: 'Ctrl+Alt+L', kind: 'action', target: 'chat', label: '💬 和她聊天' },
]

/* ------------------------------------------------------------------ *
 * 目录构建
 * ------------------------------------------------------------------ */
function scanExpressions (modelDir) {
  return fs
    .readdirSync(modelDir)
    .filter((f) => f.endsWith('.exp3.json'))
    .map((f) => f.slice(0, -'.exp3.json'.length))
    .sort()
}

function scanMotions (modelDir) {
  const out = []
  const used = new Set()
  for (const g of MOTION_GROUPS) {
    if (fs.existsSync(path.join(modelDir, g.file))) {
      out.push({ ...g })
      used.add(g.file)
    }
  }
  // 兜底：模型里出现但未登记的动作文件，自动追加
  const roots = [
    { dir: modelDir, prefix: '' },
    { dir: path.join(modelDir, 'motions'), prefix: 'motions/' },
  ]
  for (const { dir, prefix } of roots) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.motion3.json')) continue
      const rel = prefix + f
      if (used.has(rel)) continue
      used.add(rel)
      const name = f.slice(0, -'.motion3.json'.length)
      out.push({ name, file: rel, loop: /^idle$/i.test(name), label: name })
    }
  }
  return out
}

function buildCatalog (modelDir) {
  const expressions = scanExpressions(modelDir).map((name) => ({
    name,
    file: `${name}.exp3.json`,
    label: EXPRESSION_LABELS[name] || name,
  }))

  const motions = scanMotions(modelDir)

  // 只保留模型中真实存在的热键
  const exprNames = new Set(expressions.map((e) => e.name))
  const motionNames = new Set(motions.map((m) => m.name))
  const hotkeys = HOTKEY_TABLE.filter((h) => {
    if (h.kind === 'expression') return exprNames.has(h.target)
    if (h.kind === 'motion') return motionNames.has(h.target)
    return true
  })

  return { expressions, motions, hotkeys }
}

module.exports = { buildCatalog, HOTKEY_TABLE, EXPRESSION_LABELS, MOTION_GROUPS }
