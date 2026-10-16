/**
 * IR → 文字图解。
 *
 * 输出语法对齐中文圈通行写法（也是你给的那套）：
 *   6X          环起后钩 6 个短针
 *   6V          6 次加针（6 → 12）
 *   (X,V)×6     括号内重复 6 次（12 → 18）
 *   (2X,V)×6    两个短针 + 一个加针，重复 6 次（18 → 24）
 *   行末括号里的数字 = 本圈总针数
 *
 * 注意歧义：`6X` 的 6 是"次数"，`6V` 的 6 也是"次数"，
 * 但 `(X,V)×6` 的 6 也是次数 —— 统一按"重复次数"读，不会有歧义。
 * 真正的坑在"立针算不算针数"，所以输出里显式声明。
 */

import { OP, roundTops, roundOps } from './ir.js';

/** 把 run 列表摊平成单针序列 */
export function expandOps(ops) {
  const seq = [];
  for (const { op, count } of ops) for (let i = 0; i < count; i++) seq.push(op);
  return seq;
}

/** 把一段单针序列压缩成 "2X,V,3X" 这种写法 */
function compressSeq(seq) {
  const runs = [];
  for (const op of seq) {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.count++;
    else runs.push({ op, count: 1 });
  }
  return runs.map((r) => (r.count > 1 ? r.count : '') + OP[r.op].symbol).join(',');
}

/** 一圈 → 带重复记号的字符串 */
export function formatOps(ops) {
  const seq = expandOps(ops);
  const n = seq.length;
  if (n === 0) return '';
  // 找最小周期，把 (X,V)×6 这种规律还原出来
  let p = n;
  for (let d = 1; d <= n; d++) {
    if (n % d !== 0) continue;
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (seq[i] !== seq[i % d]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      p = d;
      break;
    }
  }
  const unit = seq.slice(0, p);
  const reps = n / p;
  const unitStr = compressSeq(unit);
  if (reps === 1) return unitStr;
  if (p === 1) return `${reps}${OP[unit[0]].symbol}`;
  return `(${unitStr})×${reps}`;
}

/** 一圈 → 中文口述说明 */
export function describeRound(round) {
  const parts = [];
  for (const { op, count } of round.ops) {
    const name = OP[op].label;
    if (op === 'sc') parts.push(count > 1 ? `${count} 个${name}` : `1 个${name}`);
    else parts.push(count > 1 ? `${count} 次${name}` : `1 次${name}`);
  }
  return parts.join('，');
}

/** 单个部件 → 文字图解 */
export function partToText(part, gauge) {
  const lines = [];
  const counts = part.rounds.map(roundTops);
  const peak = Math.max(...counts);
  lines.push(`【${part.id}】${part.note ? ' ' + part.note : ''}`);
  lines.push(
    `起始：${part.startType === 'magic-ring' ? '魔术环（环起）' : '锁针链成环'}` +
      `　峰值 ${peak} 针　共 ${part.rounds.length} 圈　` +
      `成品约 Ø${((peak * gauge.w) / Math.PI).toFixed(1)}mm × 高 ${(part.rounds.length * gauge.h).toFixed(1)}mm`,
  );
  for (const round of part.rounds) {
    const n = round.n;
    const ops = roundOps(round);
    lines.push(`第 ${String(n).padStart(2, ' ')} 圈：${formatOps(round.ops).padEnd(14)} (${roundTops(round)} 针)`);
    if (ops <= 12) lines.push(`          　└ ${describeRound(round)}`);
  }
  return lines.join('\n');
}

/** 整个图解 → 文字稿 */
export function toText(pattern, { legend = true } = {}) {
  const out = [];
  out.push(`# ${pattern.name}`);
  out.push('');
  lines: {
    out.push(`线材密度（gauge）：针宽 ${pattern.gauge.w}mm　针高 ${pattern.gauge.h}mm`);
    out.push('※ 本图解统一约定：起立针/引拔针不计入针数；玩偶按螺旋圈钩（不引拔）');
  }
  out.push('');
  for (const part of pattern.parts) {
    out.push(partToText(part, pattern.gauge));
    out.push('');
  }
  if (legend) {
    out.push('符号：X = 短针　V = 加针（一针里钩两针）　A = 减针（两针并一针）');
    out.push('( )×N = 括号内重复 N 次；行末括号数字 = 本圈总针数');
  }
  return out.join('\n');
}

/** 一眼可读的针数曲线，便于和预览对照 */
export function countsCurveText(pattern) {
  return pattern.parts
    .map((p) => {
      const counts = p.rounds.map(roundTops);
      const bar = counts.map((c) => String(c)).join(' → ');
      return `${p.id}：${bar}`;
    })
    .join('\n');
}
