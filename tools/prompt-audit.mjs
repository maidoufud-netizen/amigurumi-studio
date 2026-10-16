/**
 * 提示词解析审计：提示词 → 规格 → 几何，逐条对照"用户到底说了什么"。
 *
 *   node tools/prompt-audit.mjs
 *
 * 只看 spec 不算数——必须看它真的生成出什么形状（半径/高度/最粗处/针数）。
 */
import { parsePrompt } from '../src/prompt.js';
import { profileFromSpec, describeSpec, normalizeSpec } from '../src/shape.js';
import { buildPartFromProfile } from '../src/build.js';
import { roundTops } from '../src/ir.js';

const gauge = { w: 5, h: 5 };
const BALL = { kind: 'ball', diameter: 50, height: 50 };

const CASES = [
  ['直径6cm的球', 'Ø60，高应按球惯例 = 60'],
  ['8cm的球', 'Ø80（没写"直径"也该认）'],
  ['高8cm的水滴形', '高80，形状=水滴'],
  ['直径5cm高10cm的圆柱', 'Ø50 × 高100，形状=直筒'],
  ['头围30cm', 'Ø95（30cm÷π）'],
  ['长10cm粗2cm', 'Ø20 × 高100'],
  ['手臂长12cm', '高120'],
  ['高5cm宽3cm', '高50 × Ø30'],
  ['圆锥', '形状=锥'],
  ['钩一个蛋形，直径4cm', '形状=蛋形，Ø40'],
  ['胖一点', '在 Ø50 基础上变胖'],
  ['瘦一点', '在 Ø50 基础上变瘦'],
  ['下面胖一点', '最粗处下移（<50%）'],
  ['上面尖一点', '最粗处上移（>50%）'],
  ['直径6cm的球，胖一点', '写明直径 → 形容词不叠乘，仍是 Ø60'],
  ['随便来一个玩偶', '认不出时给默认 + 说明'],
  ['直径10cm的底盘', '"底盘"不是形状词，看它怎么处理'],
];

function probe(prompt, base) {
  const { spec, notes } = parsePrompt(prompt, base ? normalizeSpec(base) : undefined);
  const profile = profileFromSpec(spec);
  const { part } = buildPartFromProfile(profile, gauge, { id: 'head' });
  const counts = part.rounds.map(roundTops);
  const maxR = Math.max(...profile.map((p) => p.r));
  const widestAt = profile.reduce((best, p) => (p.r > best.r ? p : best), profile[0]);
  const totalH = Math.max(...profile.map((p) => p.h));
  return {
    spec,
    notes,
    profile,
    maxR,
    widestPct: totalH ? widestAt.h / totalH : 0,
    rounds: counts.length,
    peak: Math.max(...counts),
    total: counts.reduce((a, b) => a + b, 0),
  };
}

console.log('════════ 提示词审计 ════════\n');
let suspicious = 0;

for (const [prompt, intent] of CASES) {
  const needsBase = ['胖一点', '瘦一点', '下面胖一点', '上面尖一点'].includes(prompt);
  const r = probe(prompt, needsBase ? BALL : undefined);
  console.log(`「${prompt}」`);
  console.log(`   意图：${intent}`);
  console.log(`   规格：${describeSpec(r.spec)}`);
  console.log(`   实际：最大半径 ${r.maxR.toFixed(1)}mm（=Ø${(r.maxR * 2).toFixed(0)}）`
    + ` · 高 ${Math.max(...r.profile.map((p) => p.h)).toFixed(0)}mm`
    + ` · 最粗处在 ${(r.widestPct * 100).toFixed(0)}% 高度`
    + ` · ${r.rounds} 圈 / 峰值 ${r.peak} 针 / 合计 ${r.total} 针`);
  console.log(`   说明：${r.notes.join('；') || '（无）'}`);

  // 自动挑刺：说出的尺寸和生成的尺寸对不上，或形容词完全没生效
  const flags = [];
  const said = prompt.match(/(\d+(?:\.\d+)?)\s*(cm|厘米|公分|mm|毫米|m|米)/);
  if (said) {
    const unit = said[2];
    const mm = unit === 'cm' || unit === '厘米' || unit === '公分' ? +said[1] * 10
      : unit === 'm' || unit === '米' ? +said[1] * 1000 : +said[1];
    const d = r.maxR * 2;
    const h = Math.max(...r.profile.map((p) => p.h));
    if (Math.abs(d - mm) > 1.5 && Math.abs(h - mm) > 1.5 && Math.abs(d - mm / Math.PI) > 1.5) {
      flags.push(`说了 ${mm}mm，但既不是直径(${d.toFixed(0)})也不是高(${h.toFixed(0)})也不是围度`);
    }
  }
  if (/胖|瘦|尖|圆/.test(prompt) && !/直径|头围|周长|围度/.test(prompt)) {
    const specHasModifier = r.notes.some((n) => /胖|瘦|尖|最粗处|扁/.test(n));
    if (!specHasModifier) flags.push('写了形容词，但说明里没有任何形状微调');
  }
  if (flags.length) {
    suspicious++;
    for (const f of flags) console.log(`   ⚠️  ${f}`);
  }
  console.log('');
}

console.log(`════════ 汇总：${CASES.length} 条中 ${suspicious} 条可疑 ════════`);
