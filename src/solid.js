/**
 * 三维几何：把 IR 变成"线数据"（纯数字数组，不依赖 three.js、不碰 DOM）。
 *
 * 为什么要单独一层：几何是三维可视化的实质，也是唯一能被自动验证的部分。
 * 页面只负责把这里算出的数字塞进 three.js；算法错了，测试先发现，而不是靠眼睛看。
 *
 * 关键性质（测试里逐条断言）：
 *   · 圈边界的 y 严格递增、半径非负（回转体不自交的充要条件）
 *     —— 注意半径本身**不是**单调的：球体先增后减，这是对的
 *   · 每一圈的纵向网格线数量 == 该圈针数 cₙ（所以数格子 = 数针）
 *   · 纵向网格线的角度取自 chart.js 的 layoutChart()（与符号图解同源）
 */
import { roundTops } from './ir.js';
import { layoutChart } from './chart.js';

export const SOLID_DEFAULTS = {
  circleSeg: 120,     // 圈边界圆的采样段数
  rulerStep: 10,      // 标尺刻度间隔（mm）
  rulerLongEvery: 5,  // 每几格一个长刻度（5 × 10mm = 50mm）
};

/** 圈边界：第 n 圈占 y ∈ [(n−1)h, nh]，边界半径取相邻两圈半径均值；首尾收成小口 */
export function boundaryRings(counts, gauge) {
  const n = counts.length;
  if (!n) return { rings: [], radii: [] };
  const radii = counts.map((c) => (c * gauge.w) / (2 * Math.PI));
  const rings = [{ y: 0, r: radii[0] * 0.42 }];
  for (let i = 1; i < n; i++) rings.push({ y: i * gauge.h, r: (radii[i - 1] + radii[i]) / 2 });
  rings.push({ y: n * gauge.h, r: radii[n - 1] * 0.42 });
  return { rings, radii };
}

/** 曲面分段：每圈一段截锥，便于逐圈高亮 */
export function bodyBands(counts, gauge) {
  const { rings } = boundaryRings(counts, gauge);
  const bands = [];
  for (let j = 1; j <= counts.length; j++) {
    bands.push({
      round: j,
      y0: rings[j - 1].y,
      r0: rings[j - 1].r,
      y1: rings[j].y,
      r1: rings[j].r,
    });
  }
  return bands;
}

/** 两个角度的中点，处理跨 0 的接缝 */
export function angleMid(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d / 2;
}

/**
 * 针目网格：横向（圈边界整圆） + 纵向（针与针的分界）。
 * @returns {{positions:number[], verticalCounts:number[], ok:boolean, error?:string}}
 *          positions 为 [x,y,z, x,y,z, …] 的线段端点对
 */
export function stitchGridSegments(part, gauge, options = {}) {
  const { circleSeg } = { ...SOLID_DEFAULTS, ...options };
  const counts = part.rounds.map(roundTops);
  const { rings } = boundaryRings(counts, gauge);
  const layout = layoutChart(part);
  if (!layout.ok) return { positions: [], verticalCounts: [], ok: false, error: layout.error };

  const pos = [];
  const seg = (r0, y0, a0, r1, y1, a1) => {
    pos.push(
      r0 * Math.cos(a0), y0, r0 * Math.sin(a0),
      r1 * Math.cos(a1), y1, r1 * Math.sin(a1),
    );
  };

  // 横向：每个圈边界的整圆
  for (let i = 0; i < rings.length; i++) {
    const { y, r } = rings[i];
    for (let k = 0; k < circleSeg; k++) {
      const a0 = (k / circleSeg) * Math.PI * 2;
      const a1 = ((k + 1) / circleSeg) * Math.PI * 2;
      seg(r, y, a0, r, y, a1);
    }
  }

  // 纵向：每一圈里"针与针之间"的分界线
  const verticalCounts = [];
  for (let n = 1; n <= counts.length; n++) {
    const angles = layout.rings[n - 1].stitches.map((s) => s.angle);
    verticalCounts.push(angles.length);
    const yBot = rings[n - 1].y;
    const yTop = rings[n].y;
    const rBot = rings[n - 1].r;
    const rTop = rings[n].r;
    for (let i = 0; i < angles.length; i++) {
      const a = angleMid(angles[i], angles[(i + 1) % angles.length]);
      seg(rBot, yBot, a, rTop, yTop, a);
    }
  }

  return { positions: pos, verticalCounts, ok: true };
}

/** 标尺：竖轴 + 每 step 一个刻度（每 rulerLongEvery 格加长） */
export function rulerSegments(counts, gauge, options = {}) {
  const { rulerStep, rulerLongEvery } = { ...SOLID_DEFAULTS, ...options };
  const H = counts.length * gauge.h;
  const maxR = counts.length ? (Math.max(...counts) * gauge.w) / (2 * Math.PI) : 0;
  const x = maxR * 1.75 + 12;

  const pos = [x, 0, 0, x, H, 0];
  let ticks = 0;
  let i = 0;
  for (let y = 0; y <= H + 1e-6; y += rulerStep, i++) {
    const len = i % rulerLongEvery === 0 ? 9 : 4.5;
    pos.push(x - len, y, 0, x, y, 0);
    ticks++;
  }
  return { positions: pos, ticks, x, height: H };
}
