/**
 * 把几何导出成 JSON，交给 Python 软件渲染器（tools/render.py）画图。
 *
 * 为什么分两步：几何逻辑在 src/ 里已经被 62 项测试覆盖，
 * Python 端只负责"把数字画出来"，不再实现一遍针数与半径的换算。
 * 这样单一真源不破：几何只有一份，两种渲染（浏览器 / 原生窗口）共用。
 *
 *   node tools/emit-scene.mjs [preset] [w] [h] [outPath]
 */
import { writeFileSync } from 'node:fs';
import { roundTops } from '../src/ir.js';
import { buildPartFromProfile, PRESETS, normalizeProfile } from '../src/build.js';
import { bodyBands, stitchGridSegments, rulerSegments } from '../src/solid.js';

const [, , presetArg = 'ball', wArg = '5', hArg = '5', outArg = 'tools/scene.json'] = process.argv;

const gauge = { w: Number(wArg), h: Number(hArg) };
const profiles = {
  ball: () => PRESETS.ball(25),
  teardrop: () => PRESETS.teardrop(25),
  cone: () => PRESETS.cone(25),
  cylinder: () => PRESETS.cylinder(20, 50),
};
const profile = normalizeProfile((profiles[presetArg] || profiles.ball)());

const { part, plan } = buildPartFromProfile(profile, gauge, { id: 'head' });
const counts = part.rounds.map(roundTops);
const grid = stitchGridSegments(part, gauge);
const ruler = rulerSegments(counts, gauge);

const scene = {
  preset: presetArg,
  gauge,
  counts,
  bands: bodyBands(counts, gauge),
  grid: grid.positions,
  ruler: ruler.positions,
  totalHeight: counts.length * gauge.h,
  peak: Math.max(...counts),
  maxDeviation: plan.deviation.maxRel,
};

writeFileSync(outArg, JSON.stringify(scene));
console.log(
  `写出 ${outArg}：${counts.length} 圈 · 峰值 ${scene.peak} 针 · 高 ${scene.totalHeight}mm · `
  + `网格 ${grid.positions.length / 3} 顶点 · 标尺 ${ruler.positions.length / 3} 顶点`,
);
