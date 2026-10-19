/**
 * 装配体 → 三维场景 + 文字图解。
 *
 *   node tools/emit-assembly.mjs @tools/octopus-assembly.json [out.json]
 *
 * 装配规格（多部件 + 挂载）：
 *   { "name": "章鱼", "parts": [
 *       { "id": "head", "kind": "ball", "diameter": 46, "height": 52 },
 *       { "id": "leg",  "kind": "cone", "diameter": 14, "height": 44,
 *         "attach": { "to": "head", "round": "last", "count": 8 } } ] }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildAssembly, describeAssembly, assemblyToPattern } from '../src/assembly.js';
import { createSimulation } from '../src/force.js';
import { validatePattern, report } from '../src/validate.js';
import { toText } from '../src/pattern.js';

const [, , reqArg, outArg = 'tools/assembly-scene.json', stepsArg] = process.argv;
if (!reqArg) {
  console.error('用法：node tools/emit-assembly.mjs <@file|json> [out.json] [求解步数]');
  process.exit(1);
}

const raw = reqArg.startsWith('@') ? readFileSync(reqArg.slice(1), 'utf8') : reqArg;
const req = JSON.parse(raw);
const gauge = req.gauge || { w: 5, h: 5 };

console.log('══ 装配体 ══');
console.log(describeAssembly(req));

const { graph } = buildAssembly(req, gauge);
const sim = createSimulation(graph, {
  linkDistance: gauge.w,
  chargeStrength: -6,
  chargeCutoff: 7,
  guideStrength: 0.06,
});
const steps = sim.run(Number(stepsArg || 400));

const scene = {
  name: graph.name,
  gauge,
  nodes: sim.nodes.map((n) => ({ x: n.x, y: n.y, z: n.z, chain: !!n.chain, round: n.round })),
  links: sim.links.map((l) => [l.s, l.t, l.kind]),
  summary: sim.summary(),
  converged: sim.alpha === 0,
  ticks: steps,
};
writeFileSync(outArg, JSON.stringify(scene));
console.log(`\n已写出 ${outArg}`);
console.log(`  ${scene.nodes.length} 节点 / ${scene.links.length} 边`
  + ` · ${sim.alpha === 0 ? `已收敛（${steps} 步）` : `未收敛 alpha=${sim.alpha.toFixed(4)}`}`
  + ` · 包围半径 ${sim.summary().radius.toFixed(1)}mm`);

console.log('\n══ 文字图解 ══');
const { pattern } = assemblyToPattern(req, gauge);
const res = validatePattern(pattern);
console.log(toText(pattern));
console.log(res.issues.length ? report(res) : '✅ 校验通过：结构合法，可以照着钩。');
