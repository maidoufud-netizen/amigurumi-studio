/**
 * 力导向实验台 / 参数标定。
 *
 *   node tools/force-lab.mjs [ticks] [--sweep]
 *
 * 核心问题：给它一个球体的**纯拓扑**（只有"谁连着谁"，没有任何坐标提示），
 * 它能不能自己摊出一个球？而且尺度能不能和解析式 (r = c·w/2π) 对上？
 *
 * 期望：弹簧（相邻针目保持一个针宽）应当主导尺度，排斥力只需防止重叠。
 * 排斥力过强会把织物吹胀——这个扫描就是找这个平衡点。
 */
import { createPart } from '../src/ir.js';
import { planRound } from '../src/build.js';
import { graphFromPart, octopusGraph, graphStats } from '../src/graph.js';
import { createSimulation } from '../src/force.js';

const gauge = { w: 5, h: 5 };
const ticks = Number(process.argv[2] || 500);
const sweep = process.argv.includes('--sweep');

const counts = [6, 12, 18, 24, 30, 24, 18, 12, 6];
const rounds = [{ n: 1, ops: [{ op: 'sc', count: counts[0] }] }];
for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
const sphereGraph = graphFromPart(createPart({ id: 'sphere', rounds }), gauge);

/** 按圈统计圈半径（到中心轴的距离）与轴向位置 */
function ringProfile(sim) {
  const c = sim.summary().center;
  const byRound = new Map();
  for (const n of sim.nodes) {
    if (!byRound.has(n.round)) byRound.set(n.round, []);
    byRound.get(n.round).push(n);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, list]) => {
      const radii = list.map((n) => Math.hypot(n.x - c.x, n.z - c.z));
      return {
        round,
        count: list.length,
        ringR: radii.reduce((s, v) => s + v, 0) / radii.length,
        y: list.reduce((s, n) => s + n.y, 0) / list.length - c.y,
        spread: Math.max(...radii) - Math.min(...radii),
        predicted: (list.length * gauge.w) / (2 * Math.PI),
      };
    });
}

function runSphere(options) {
  const sim = createSimulation(sphereGraph, { linkDistance: gauge.w, ...options });
  sim.run(ticks);
  const rows = ringProfile(sim);
  const errs = rows.map((r) => Math.abs(r.ringR - r.predicted) / r.predicted);
  return { sim, rows, maxErr: Math.max(...errs), avgErr: errs.reduce((a, b) => a + b, 0) / errs.length };
}

if (sweep) {
  console.log('排斥力扫描（链弹簧静止长度 = 针宽 5mm；期望圈半径 = 针数 × 5 / 2π）\n');
  console.log(' chargeStrength  cutoff   最大相对误差   平均相对误差   第5圈半径(应 23.87)');
  for (const charge of [-2, -4, -6, -10, -16]) {
    for (const cutoff of [4, 5, 6, 8]) {
      const { maxErr, avgErr, rows } = runSphere({ chargeStrength: charge, chargeCutoff: cutoff });
      const mid = rows.find((r) => r.round === 5)?.ringR ?? NaN;
      console.log(
        String(charge).padStart(14),
        String(cutoff).padStart(7),
        `${(maxErr * 100).toFixed(1)}%`.padStart(14),
        `${(avgErr * 100).toFixed(1)}%`.padStart(14),
        mid.toFixed(2).padStart(18),
      );
    }
  }
  process.exit(0);
}

// ── 实验一：球体 ──
const best = runSphere({});
console.log('══ 球体（6→30→6，纯拓扑喂进去）══');
console.log('图：', JSON.stringify(graphStats(sphereGraph)));
console.log('收敛：', best.sim.alpha === 0 ? `已收敛（${best.sim.ticks} 步）` : `未收敛 alpha=${best.sim.alpha.toFixed(4)}`);
console.log(' 圈  针数   解析预测   物理求解    差异    轴向位置   圈内波动');
for (const r of best.rows) {
  console.log(
    String(r.round).padStart(3),
    String(r.count).padStart(5),
    r.predicted.toFixed(2).padStart(10),
    r.ringR.toFixed(2).padStart(10),
    (r.ringR - r.predicted).toFixed(2).padStart(8),
    r.y.toFixed(2).padStart(11),
    r.spread.toFixed(2).padStart(10),
  );
}
console.log(`最大相对误差 ${(best.maxErr * 100).toFixed(1)}%`);

// ── 实验二：章鱼（解析式根本做不出来）──
{
  const graph = octopusGraph(gauge);
  const sim = createSimulation(graph, { linkDistance: gauge.w, gravityStrength: 0.05 });
  sim.run(ticks);
  const st = graphStats(graph);
  const chains = sim.nodes.filter((n) => n.chain);
  const body = sim.nodes.filter((n) => !n.chain);
  const c = sim.summary().center;
  const lowY = Math.min(...chains.map((n) => n.y));
  const bodyLow = Math.min(...body.map((n) => n.y));
  console.log('\n══ 章鱼（球头 + 8 条触手）══');
  console.log('图：', JSON.stringify(st));
  console.log('收敛：', sim.alpha === 0 ? `已收敛（${sim.ticks} 步）` : `未收敛 alpha=${sim.alpha.toFixed(4)}`);
  console.log(`包围半径 ${sim.summary().radius.toFixed(1)}mm　主体最低 y=${bodyLow.toFixed(1)}　触手最低 y=${lowY.toFixed(1)}`);
  console.log(`触手是否向下伸展：${lowY < bodyLow - 5 ? '是 ✅' : '否 ❌'}`);
}

// ── 实验三：确定性 ──
{
  const a = createSimulation(sphereGraph, { linkDistance: gauge.w });
  const b = createSimulation(sphereGraph, { linkDistance: gauge.w });
  a.run(200); b.run(200);
  let worst = 0;
  for (let i = 0; i < a.nodes.length; i++) {
    worst = Math.max(worst, Math.abs(a.nodes[i].x - b.nodes[i].x),
      Math.abs(a.nodes[i].y - b.nodes[i].y), Math.abs(a.nodes[i].z - b.nodes[i].z));
  }
  console.log(`\n══ 确定性 ══\n两次独立模拟最大坐标差 ${worst.toExponential(2)}（0 = 完全可复现）`);
}

// ── 实验四：钉住 + 重新加热（拖动交互）──
{
  const sim = createSimulation(sphereGraph, { linkDistance: gauge.w });
  sim.run(300);
  const target = sim.nodes[Math.floor(sim.nodes.length / 2)];
  const before = { x: target.x, y: target.y, z: target.z };
  const rBefore = sim.summary().radius;
  sim.pin(target.id, { x: before.x + 20, y: before.y, z: before.z });
  sim.reheat(1);
  sim.run(300);
  const rAfter = sim.summary().radius;
  console.log('\n══ 拖动 + 重新加热 ══');
  console.log(`钉住点 x：${before.x.toFixed(1)} → ${target.x.toFixed(1)}（期望正好 +20）`);
  console.log(`包围半径：${rBefore.toFixed(1)} → ${rAfter.toFixed(1)}（全图确实重新松弛了）`);
  console.log(`收敛：${sim.alpha === 0 ? '已收敛' : 'alpha=' + sim.alpha.toFixed(4)}`);
}
