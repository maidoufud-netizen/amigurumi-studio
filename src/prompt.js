/**
 * 提示词 → 形状规格。
 *
 * 这是**规则解析**，不是大模型：确定性、可测、不联网、不需要密钥。
 * 对应项目原则"AI 只负责模糊的事，参数必须可校验"——
 * 这里连 AI 都省了，先把最常见的中文说法覆盖住。
 *
 * 每条推断都会记进 notes，界面必须显示出来：
 * 用户要能看到"系统把我的话理解成了什么"，否则改错了也不知道为什么。
 */
import { SHAPE_KINDS, normalizeSpec } from './shape.js';

const SHAPE_WORDS = [
  ['teardrop', ['水滴', '梨形', '泪滴', '上尖下圆', 'teardrop', 'pear']],
  ['cone', ['圆锥', '锥形', '尖头', '尖锥', '锥', 'cone', 'conical']],
  ['cylinder', ['直筒', '圆柱', '圆筒', '长条', '筒状', 'tube', 'cylinder']],
  ['egg', ['蛋形', '椭圆形', '椭圆', '鹅蛋', 'egg', 'oval']],
  ['ball', ['圆球', '球形', '球体', '圆头', '圆', '球', '脑袋', '头', 'ball', 'sphere', 'round']],
];

const UNIT_TO_MM = { mm: 1, 毫米: 1, cm: 10, 厘米: 10, 公分: 10, m: 1000, 米: 1000 };

/** 抓数字+单位；没写单位时按厘米理解（玩偶尺度下这是最可能的） */
function toMm(numText, unitText, notes, what) {
  const value = parseFloat(numText);
  if (!Number.isFinite(value)) return null;
  const unit = (unitText || '').toLowerCase();
  if (UNIT_TO_MM[unit]) return value * UNIT_TO_MM[unit];
  notes.push(`${what} "${numText}" 没写单位，按厘米算（${value}cm = ${value * 10}mm）`);
  return value * 10;
}

const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '(mm|毫米|cm|厘米|公分|m|米)?';

export function parsePrompt(text, base = {}) {
  const raw = String(text || '').trim();
  const notes = [];
  const spec = { ...base };

  if (!raw) {
    return { spec: normalizeSpec(spec), notes: ['没有输入提示词，使用当前设置'], matched: false };
  }

  const lower = raw.toLowerCase();

  // ── ① 形状关键词（先匹配更具体的词，避免"圆"吃掉"圆锥"）──
  let shapeHit = null;
  for (const [kind, words] of SHAPE_WORDS) {
    const hit = words.find((w) => lower.includes(w.toLowerCase()));
    if (hit) {
      shapeHit = { kind, word: hit };
      break;
    }
  }
  if (shapeHit) {
    spec.kind = shapeHit.kind;
    notes.push(`形状识别为「${SHAPE_KINDS[shapeHit.kind].label.split(' · ')[0]}」（命中"${shapeHit.word}"）`);
  }

  // ── ② 围度 → 直径（周长 = π·直径）──
  const girth = raw.match(new RegExp(`(?:头围|周长|围度|胸围|一圈)\\s*(?:约|大概|大约)?\\s*${NUM}\\s*${UNIT}`));
  if (girth) {
    const mm = toMm(girth[1], girth[2], notes, '围度');
    if (mm) {
      spec.diameter = Math.round(mm / Math.PI);
      notes.push(`围度 ${mm}mm ÷ π → 直径 ${spec.diameter}mm`);
    }
  }

  // ── ③ 直径（关键词在前或在后两种说法）──
  let dHit = null;
  if (spec.diameter === undefined) {
    const d1 = raw.match(new RegExp(`(?:直径|宽度|宽|粗细|粗)\\s*(?:约|大概|大约)?\\s*${NUM}\\s*${UNIT}`));
    const d2 = raw.match(new RegExp(`${NUM}\\s*${UNIT}\\s*(?:的)?\\s*(?:直径|宽|粗)`));
    dHit = d1 || d2;
    if (dHit) {
      const mm = toMm(dHit[1], dHit[2], notes, '直径');
      if (mm) {
        spec.diameter = Math.round(mm);
        notes.push(`直径 = ${spec.diameter}mm`);
      }
    }
  }

  // ── ④ 高（关键词在前或在后）──
  const h1 = raw.match(new RegExp(`(?:高度|高|长度|长)\\s*(?:约|大概|大约)?\\s*${NUM}\\s*${UNIT}`));
  const h2 = raw.match(new RegExp(`${NUM}\\s*${UNIT}\\s*(?:的)?\\s*(?:高|高度|长|长度)`));
  const hHit = h1 || h2;
  if (hHit) {
    const mm = toMm(hHit[1], hHit[2], notes, '高度');
    if (mm) {
      spec.height = Math.round(mm);
      notes.push(`高度 = ${spec.height}mm`);
    }
  }

  // ── ⑤ 兜底：有数字+单位但没被用上，按直径理解 ──
  // 按"数字本身"去重——否则「高 8cm」里的 8 会被再当成直径，凭空多出一个尺寸
  const allNums = [...raw.matchAll(new RegExp(`${NUM}\\s*${UNIT}`, 'g'))].filter((m) => m[2]);
  const consumed = new Set([girth?.[1], dHit?.[1], hHit?.[1]].filter(Boolean));
  const leftover = allNums.filter((m) => !consumed.has(m[1]));
  if (spec.diameter === undefined && leftover.length) {
    const mm = toMm(leftover[0][1], leftover[0][2], notes, '尺寸');
    if (mm) {
      spec.diameter = Math.round(mm);
      notes.push(`没说哪个尺寸，把 ${leftover[0][0]} 当作直径`);
    }
  }

  // ── ⑥ 形容词微调 ──
  // 关键：明确写了尺寸的，形容词不再叠乘（"长10cm + 细长"不该变成 12cm）
  const explicitDiameter = spec.diameter !== undefined;
  const explicitHeight = spec.height !== undefined;
  const tweak = (re, fn, label) => {
    if (re.test(lower)) {
      fn();
      notes.push(label);
    }
  };

  tweak(/胖|粗一点|粗些|宽一点|墩/, () => {
    if (explicitDiameter) return;
    spec.diameter = Math.round((spec.diameter ?? 50) * 1.15);
  }, explicitDiameter ? '“胖/粗”已忽略（你已写明直径）' : '“胖/粗” → 直径 +15%');

  tweak(/瘦|细一点|细些|窄|苗条/, () => {
    if (explicitDiameter) return;
    spec.diameter = Math.round((spec.diameter ?? 50) * 0.85);
  }, explicitDiameter ? '“瘦/细”已忽略（你已写明直径）' : '“瘦/细” → 直径 −15%');

  tweak(/高一点|高些|细长|修长/, () => {
    if (explicitHeight) return;
    spec.height = Math.round((spec.height ?? 50) * 1.2);
  }, explicitHeight ? '“高/细长”已忽略（你已写明高度）' : '“高/细长” → 高度 +20%');

  tweak(/矮|短一点|短些|扁/, () => {
    if (explicitHeight) return;
    spec.height = Math.round((spec.height ?? 50) * 0.8);
  }, explicitHeight ? '“矮/扁”已忽略（你已写明高度）' : '“矮/扁” → 高度 −20%');

  tweak(/上胖|上面胖|头大|上粗/, () => {
    spec.widestAt = 0.68;
  }, '“上胖” → 最粗处移到 68% 高度');

  tweak(/下胖|下面胖|底部胖|下粗|底座稳/, () => {
    spec.widestAt = 0.34;
  }, '“下胖” → 最粗处移到 34% 高度');

  // ── ⑦ 高宽比兜底：只给了一个尺寸时，另一个按形状惯例推 ──
  if (spec.diameter !== undefined && spec.height === undefined) {
    const ratio = spec.kind === 'cylinder' ? 1.6 : spec.kind === 'cone' ? 1.8 : 1.0;
    spec.height = Math.round(spec.diameter * ratio);
    notes.push(`只给了直径，按「${SHAPE_KINDS[spec.kind]?.label.split(' · ')[0] || '形状'}」惯例把高推为 ${spec.height}mm`);
  }
  if (spec.height !== undefined && spec.diameter === undefined) {
    spec.diameter = Math.round(spec.height * 0.9);
    notes.push(`只给了高度，直径推为 ${spec.diameter}mm`);
  }

  if (!notes.length) {
    notes.push('没认出任何形状或尺寸，保持当前设置不变');
  }

  return { spec: normalizeSpec(spec), notes, matched: notes.length > 0 && !/没认出/.test(notes[0]) };
}
