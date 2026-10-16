/**
 * 用拓扑图 + 力导向求解布局，导出成 JSON 交给 render.py 画。
 *
 *   node tools/emit-graph.mjs [octopus|sphere] [out.json]
 *
 * 这条路径和解析式那条完全不同：
 *   解析式：剖面 → 针数序列 → 回转体（只能做旋转对称件）
 *   本脚本：拓扑图 → 力求解 → 任意形状（章鱼腿、片织、分件缝合都能表达）
 */
import { writeFileSync } from 'node:fs';
import { createPart } from '../src/ir.js';
import { planRound } from '../src/build.js';
import { graphFromPart, octopusGraph, graphStats } from '../src/graph.js';
import { createSimulation } from '../src/force.js';

const [, , which = 'octopus', outArg = 'tools/graph.json'] = process.argv;
const gauge = { w: 5, h: 5 };

let graph;
if (which === 'octopus') {
  graph = octopusGraph(gauge);
} else {
  const counts = [6, 12, 18, 24, 30, 24, 18, 12, 6];
  const rounds = [{ n: 1, ops: [{ op: 'sc', count: 6 }] }];
  for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  graph = graphFromPart(createPart({ id: 'sphere', rounds }), gauge);
  graph.name = '球体（纯拓扑）';
}

const sim = createSimulation(graph, {
  linkDistance: gauge.w,
  gravityStrength: which === 'octopus' ? 0.05 : 0,
});
const steps = sim.run(900);

const nodes = sim.nodes.map((n) => ({
  id: n.id, x: n.x, y: n.y, z: n.z,
  chain: n.chain, round: n.round,
}));
const links = sim.links.map((l) => [l.s, l.t, l.kind]);

writeFileSync(outArg, JSON.stringify({
  name: graph.name || which,
  gauge,
  nodes,
  links,
  summary: sim.summary(),
  stats: graphStats(graph),
  converged: sim.alpha === 0,
  ticks: steps,
}));

console.log(
  `已写出 ${outArg}\n`
  + `  ${graph.name || which}\n`
  + `  节点 ${nodes.length} · 边 ${links.length} · 圈 ${graphStats(graph).rounds}\n`
  + `  ${sim.alpha === 0 ? `已收敛（${steps} 步）` : `未收敛 alpha=${sim.alpha.toFixed(4)}`}`
  + ` · 包围半径 ${sim.summary().radius.toFixed(1)}mm`,
);
