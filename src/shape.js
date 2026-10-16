/**
 * 形状规格 → 剖面曲线。
 *
 * 规格是"人话参数"，不是针数：
 *   { kind, diameter, height, widestAt, bottomRatio, topRatio, bulge }
 *
 * 其中：
 *   diameter    成品最大直径（mm）
 *   height      成品高度（mm）
 *   widestAt    最粗处的高度比例（0 = 最底，1 = 最顶）
 *   bottomRatio 最底处半径 / 最大半径（0 = 收成尖，1 = 不收）
 *   topRatio    最顶处半径 / 最大半径
 *   bulge       鼓起程度：<1 起步快（像球），>1 起步慢（像锥）
 *
 * 输出的剖面再交给 src/build.js 做"整数化 + 耦合夹紧"，
 * 所以这里是连续形状，那里才是针数。两者刻意分开。
 */

const TAU = Math.PI * 2;

/** 形状预设：把常用玩偶部件表达成一组参数 */
export const SHAPE_KINDS = {
  ball: { label: '球 · 头/身', widestAt: 0.5, bottomRatio: 0.28, topRatio: 0.28, bulge: 0.62 },
  egg: { label: '蛋形 · 身体', widestAt: 0.62, bottomRatio: 0.3, topRatio: 0.2, bulge: 0.6 },
  teardrop: { label: '水滴', widestAt: 0.38, bottomRatio: 0.22, topRatio: 0.1, bulge: 0.7 },
  cone: { label: '锥 · 手/腿', widestAt: 0.02, bottomRatio: 1.0, topRatio: 0.06, bulge: 1.0 },
  cylinder: { label: '直筒', widestAt: 0.5, bottomRatio: 1.0, topRatio: 1.0, bulge: 1.0 },
};

export const DEFAULT_SPEC = { kind: 'ball', diameter: 50, height: 50 };

/** 把一个规格补全成完整参数（未知 kind 退回 ball） */
export function normalizeSpec(spec = {}) {
  const kind = SHAPE_KINDS[spec.kind] ? spec.kind : 'ball';
  const preset = SHAPE_KINDS[kind];
  const pick = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  return {
    kind,
    diameter: Math.max(4, pick(spec.diameter, DEFAULT_SPEC.diameter)),
    height: Math.max(4, pick(spec.height, DEFAULT_SPEC.height)),
    widestAt: Math.min(0.98, Math.max(0.02, pick(spec.widestAt, preset.widestAt))),
    bottomRatio: Math.min(1, Math.max(0.01, pick(spec.bottomRatio, preset.bottomRatio))),
    topRatio: Math.min(1, Math.max(0.01, pick(spec.topRatio, preset.topRatio))),
    bulge: Math.min(3, Math.max(0.2, pick(spec.bulge, preset.bulge))),
  };
}

/** 平滑缓动：u ∈ [0,1] → [0,1]，u=0 处平缓或陡峭由 bulge 控制 */
function ease(u, bulge) {
  const clamped = Math.min(1, Math.max(0, u));
  return Math.sin((Math.PI / 2) * clamped) ** bulge;
}

/** 半径比例函数：t = y/height ∈ [0,1] → 半径 / 最大半径 */
export function radiusRatio(t, spec) {
  const s = normalizeSpec(spec);
  if (t <= s.widestAt) {
    const u = s.widestAt <= 1e-6 ? 1 : t / s.widestAt;
    return s.bottomRatio + (1 - s.bottomRatio) * ease(u, s.bulge);
  }
  const u = (t - s.widestAt) / Math.max(1e-6, 1 - s.widestAt);
  return 1 - (1 - s.topRatio) * ease(u, s.bulge);
}

/**
 * 规格 → 剖面控制点（高度 mm，半径 mm）
 * 采样点越多，剖面越贴合连续曲线；build.js 会再按针高切成圈。
 */
export function profileFromSpec(spec, { samples = 9 } = {}) {
  const s = normalizeSpec(spec);
  const R = s.diameter / 2;
  const n = Math.max(3, Math.round(samples));

  // 等距采样之外，**必须额外采到最粗处**：
  // 否则当 widestAt 不落在采样点上（例如蛋形 0.62），实际最大半径会小于设定直径，
  // 峰值针数跟着偏小 —— 用户设的尺寸就没被兑现。
  const ts = new Set();
  for (let i = 0; i < n; i++) ts.add(i / (n - 1));
  ts.add(s.widestAt);

  return [...ts]
    .sort((a, b) => a - b)
    .map((t) => ({ h: t * s.height, r: Math.max(0.2, R * radiusRatio(t, s)) }));
}

/** 规格 → 一句话描述（界面回显用） */
export function describeSpec(spec) {
  const s = normalizeSpec(spec);
  const name = SHAPE_KINDS[s.kind].label.split(' · ')[0];
  const widest = (s.widestAt * 100).toFixed(0);
  return `${name} · 直径 ${s.diameter}mm × 高 ${s.height}mm · 最粗处在 ${widest}% 高度`;
}

/** 由成品尺寸与 gauge 估算圈数与峰值针数（给界面即时反馈，不建 IR） */
export function estimate(spec, gauge) {
  const s = normalizeSpec(spec);
  const rounds = Math.max(1, Math.round(s.height / gauge.h));
  const peak = Math.max(1, Math.round((TAU * (s.diameter / 2)) / gauge.w));
  return { rounds, peak, totalHeight: s.height };
}
