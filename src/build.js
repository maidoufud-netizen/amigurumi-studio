/**
 * 剖面曲线 → 针数序列 → 图解。
 *
 * 这是"数学公式"那一层：
 *   r(y) = 目标半径（由剖面插值得到，单位 mm）
 *   c_n  = round(2π · r(y_n) / w)        ← 离散化 + 整数化
 *   y_n  = (n - 0.5) · h                 ← 第 n 圈的中心高度
 *   然后按"相邻两圈必须耦合"的约束，把 inc/dec 均匀分配到圈内。
 *
 * 关键诚实点：整数化和耦合约束会修改序列（clamp），
 * 所以实际做出的形状必然偏离目标轮廓。偏差要量化并暴露给用户，
 * 而不是假装公式是精确的。deviation() 就是干这个的。
 */

import { OP, createPart, roundTops } from './ir.js';

/** 剖面点按高度升序排列并校验 */
export function normalizeProfile(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('剖面至少需要 2 个点：(高度 mm, 半径 mm)');
  }
  const pts = points
    .map((p) => ({ h: Number(p.h), r: Number(p.r) }))
    .sort((a, b) => a.h - b.h);
  for (const p of pts) {
    if (!Number.isFinite(p.h) || !Number.isFinite(p.r)) throw new Error('剖面点必须是数字');
    if (p.r < 0) throw new Error('半径不能为负');
  }
  return pts;
}

/** 线性插值求高度 y 处的目标半径 */
export function interpRadius(profile, y) {
  const pts = profile;
  if (y <= pts[0].h) return pts[0].r;
  if (y >= pts[pts.length - 1].h) return pts[pts.length - 1].r;
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i].h) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (y - a.h) / (b.h - a.h || 1);
      return a.r + (b.r - a.r) * t;
    }
  }
  return pts[pts.length - 1].r;
}

/**
 * 剖面 + gauge → 每圈目标针数（未做耦合约束）
 * @returns {number[]} counts[n-1] = 第 n 圈的理想针数
 */
export function idealCounts(profile, gauge, { minPerRound = 3 } = {}) {
  const top = profile[profile.length - 1].h;
  const nRounds = Math.max(1, Math.round(top / gauge.h));
  const out = [];
  for (let n = 1; n <= nRounds; n++) {
    const y = (n - 0.5) * gauge.h;
    const r = interpRadius(profile, y);
    const c = Math.round((2 * Math.PI * r) / gauge.w);
    out.push(Math.max(minPerRound, c));
  }
  return out;
}

/**
 * 耦合约束：单圈内针数的变化幅度有硬上限。
 *   加针：每针最多再添 1 针（一个基针最多被穿 2 次）→ c_n ≤ 2·c_{n-1}
 *   减针：每减针吃掉 2 个基针、且不许跳针        → c_n ≥ ceil(c_{n-1} / 2)
 * 违反时按上限夹紧，并记录被修正的位置。
 */
export function clampForCoupling(counts, { minPerRound = 3 } = {}) {
  const out = counts.slice();
  const clamps = [];
  if (out.length === 0) return { counts: out, clamps };
  out[0] = Math.max(minPerRound, out[0]);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const hi = 2 * prev;
    const lo = Math.max(minPerRound, Math.ceil(prev / 2));
    const want = counts[i];
    if (want > hi) {
      out[i] = hi;
      clamps.push({ round: i + 1, want, got: hi, reason: '单圈最多翻倍（每针最多加 1 针）' });
    } else if (want < lo) {
      out[i] = lo;
      clamps.push({ round: i + 1, want, got: lo, reason: '单圈最多减半（不许跳针）' });
    }
  }
  return { counts: out, clamps };
}

/** 把 k 个特殊针尽量均匀地插进 opsCount 个位置里；返回压缩后的 run 列表 */
export function spreadOps(opsCount, k, special) {
  if (k <= 0) return [{ op: 'sc', count: opsCount }];
  if (k > opsCount) {
    throw new Error(`无法在 ${opsCount} 个位置里放下 ${k} 个 ${special}（约束不允许）`);
  }
  const flags = new Array(opsCount).fill(false);
  let acc = 0;
  for (let i = 0; i < opsCount; i++) {
    acc += k;
    if (acc >= opsCount) {
      flags[i] = true;
      acc -= opsCount;
    }
  }
  const ops = [];
  for (const f of flags) {
    const op = f ? special : 'sc';
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.count++;
    else ops.push({ op, count: 1 });
  }
  return ops;
}

/** 由上一圈针数 prev 和目标针数 next 生成一圈 */
export function planRound(prev, next, n) {
  const delta = next - prev;
  if (delta === 0) return { n, ops: [{ op: 'sc', count: prev }] };
  if (delta > 0) {
    return { n, ops: spreadOps(prev, delta, 'inc') };
  }
  const k = -delta;
  // dec 会减少操作位数量：prev 个基针被 k 个 dec（各吃 2 个）和若干 sc 覆盖
  const opsCount = prev - k;
  if (opsCount <= 0) throw new Error(`第 ${n} 圈无法从 ${prev} 减到 ${next}`);
  return { n, ops: spreadOps(opsCount, k, 'dec') };
}

/**
 * 针数序列 → 圈列表
 * 第 1 圈全部是 sc（环起后钩 c_1 个短针）
 */
export function roundsFromCounts(counts) {
  if (!counts.length) throw new Error('针数序列为空');
  const rounds = [{ n: 1, ops: [{ op: 'sc', count: counts[0] }] }];
  for (let i = 1; i < counts.length; i++) {
    rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  }
  return rounds;
}

/**
 * 一步到位：剖面 → 部件
 * @returns {{part, plan}} plan 里带理想序列、实际序列、被夹紧的记录、偏差
 */
export function buildPartFromProfile(profile, gauge, { id = 'part', startType = 'magic-ring' } = {}) {
  const pts = normalizeProfile(profile);
  const ideal = idealCounts(pts, gauge);
  const { counts: actual, clamps } = clampForCoupling(ideal);
  const rounds = roundsFromCounts(actual);
  const part = createPart({ id, startType, rounds });
  return {
    part,
    plan: {
      profile: pts,
      ideal,
      actual,
      clamps,
      deviation: deviation(pts, gauge, actual),
      rounds: rounds.length,
    },
  };
}

/** 实际针数序列对应的半径曲线（用于和剖面叠加比对） */
export function actualProfile(counts, gauge) {
  return counts.map((c, i) => ({
    h: (i + 0.5) * gauge.h,
    r: (c * gauge.w) / (2 * Math.PI),
  }));
}

/**
 * 量化"整数化 + 夹紧"带来的形状偏差
 * @returns {{maxAbs:number, maxRel:number, perRound:Array}}
 */
export function deviation(profile, gauge, counts) {
  const perRound = counts.map((c, i) => {
    const y = (i + 0.5) * gauge.h;
    const wantR = interpRadius(profile, y);
    const gotR = (c * gauge.w) / (2 * Math.PI);
    const abs = gotR - wantR;
    return {
      round: i + 1,
      y,
      wantR,
      gotR,
      diff: abs,
      rel: wantR > 0.01 ? abs / wantR : 0,
    };
  });
  const maxAbs = perRound.reduce((m, x) => Math.max(m, Math.abs(x.diff)), 0);
  const maxRel = perRound.reduce((m, x) => Math.max(m, Math.abs(x.rel)), 0);
  return { maxAbs, maxRel, perRound };
}

/** 常用剖面预设（单位 mm） */
export const PRESETS = {
  ball: (r = 25) => [
    { h: 0, r: r * 0.35 },
    { h: r * 0.5, r: r * 0.85 },
    { h: r, r },
    { h: r * 1.5, r: r * 0.85 },
    { h: r * 2, r: r * 0.35 },
  ],
  teardrop: (r = 25) => [
    { h: 0, r: r * 0.25 },
    { h: r * 0.4, r: r * 0.72 },
    { h: r * 0.9, r },
    { h: r * 1.6, r: r * 0.7 },
    { h: r * 2.2, r: r * 0.3 },
  ],
  cone: (r = 25) => [
    { h: 0, r: r * 0.2 },
    { h: r, r: r * 0.55 },
    { h: r * 2, r },
  ],
  cylinder: (r = 20, h = 50) => [
    { h: 0, r },
    { h, r },
  ],
};
