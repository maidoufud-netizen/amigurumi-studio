/**
 * 几何 + 图解导出：一个请求 JSON 进去，一份场景 JSON 出来。
 *
 *   node tools/emit-scene.mjs '<请求JSON>' [输出路径]
 *
 * 请求 JSON：
 *   {
 *     "prompt": "直径6cm的圆球",        // 可选：自然语言
 *     "spec":   { "kind": "ball", "diameter": 50, "height": 50 },   // 可选：直接给规格
 *     "gauge":  { "w": 5, "h": 5 }      // 针宽 / 针高（mm）
 *   }
 *
 * 输出里除了三维几何，还带 chart（符号图布局）与 pattern（文字图解），
 * 这样原生窗口点一次「确定」就能同时拿到三维和图解，不必再算第二遍。
 *
 * 几何与图解的算法**全部**来自 src/，这里只做搬运。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createPattern, roundTops, roundOps } from '../src/ir.js';
import { buildPartFromProfile } from '../src/build.js';
import { bodyBands, stitchGridSegments, rulerSegments } from '../src/solid.js';
import { layoutChart } from '../src/chart.js';
import { toText } from '../src/pattern.js';
import { validatePattern, report } from '../src/validate.js';
import { profileFromSpec, normalizeSpec, describeSpec } from '../src/shape.js';
import { parsePrompt } from '../src/prompt.js';

const [, , requestArg, outArg = 'tools/scene.json'] = process.argv;

if (!requestArg) {
  console.error('用法: node tools/emit-scene.mjs \'{"prompt":"直径6cm的圆球","gauge":{"w":5,"h":5}}\' [out.json]');
  process.exit(2);
}

let request;
try {
  // 参数以 @ 开头 = 从 UTF-8 文件读取请求，避免中文经过控制台编码被破坏
  const text = requestArg.startsWith('@')
    ? readFileSync(requestArg.slice(1), 'utf8')
    : requestArg;
  request = JSON.parse(text);
} catch (err) {
  console.error('请求 JSON 解析失败：' + err.message);
  process.exit(2);
}

const gauge = {
  w: Number(request.gauge?.w) > 0 ? Number(request.gauge.w) : 5,
  h: Number(request.gauge?.h) > 0 ? Number(request.gauge.h) : 5,
};

// ① 形状：有提示词就先解析，解析结果作为基准，再让显式 spec 覆盖
let spec;
let notes = [];
if (request.prompt) {
  const parsed = parsePrompt(request.prompt, request.spec || {});
  spec = parsed.spec;
  notes = parsed.notes;
} else {
  spec = normalizeSpec(request.spec || {});
  notes = ['直接使用给定规格'];
}
if (request.spec) spec = normalizeSpec({ ...spec, ...request.spec });

// ② 规格 → 剖面 → 针数 → IR
const profile = profileFromSpec(spec);
const { part, plan } = buildPartFromProfile(profile, gauge, { id: 'part' });
const counts = part.rounds.map(roundTops);
const pattern = createPattern({ name: describeSpec(spec), gauge });
pattern.parts.push(part);

// ③ 校验
const validation = validatePattern(pattern);

// ④ 三维几何
const grid = stitchGridSegments(part, gauge);
const ruler = rulerSegments(counts, gauge);

// ⑤ 符号图布局（角度就是三维网格用的同一份）
const layout = layoutChart(part);

const scene = {
  spec,
  notes,
  gauge,
  counts,
  bands: bodyBands(counts, gauge),
  grid: grid.positions,
  ruler: ruler.positions,
  chart: layout.ok
    ? {
      maxR: layout.maxR,
      cell: layout.cell,
      minGap: layout.minGap,
      rings: layout.rings.map((r) => ({
        n: r.n,
        r: r.r,
        total: r.total,
        glyphs: r.glyphs.map((g) => ({ op: g.op, angle: g.angle })),
      })),
    }
    : null,
  pattern: toText(pattern),
  validation: { ok: validation.ok, issues: validation.issues, text: report(validation) },
  totalHeight: counts.length * gauge.h,
  peak: Math.max(...counts),
  rounds: counts.length,
  totalOps: part.rounds.reduce((a, r) => a + roundOps(r), 0),
  maxDeviation: plan.deviation.maxRel,
  clamps: plan.clamps,
};

writeFileSync(outArg, JSON.stringify(scene));

console.log(
  `已写出 ${outArg}\n`
  + `  ${describeSpec(spec)}\n`
  + `  ${counts.length} 圈 · 峰值 ${scene.peak} 针 · 合计 ${scene.totalOps} 针 · 高 ${scene.totalHeight}mm\n`
  + `  校验：${validation.ok ? '合法' : '不可钩'}　整数化偏差 ${(scene.maxDeviation * 100).toFixed(1)}%\n`
  + `  三维网格 ${grid.positions.length / 3} 顶点 · 符号图 ${layout.ok ? layout.rings.reduce((a, r) => a + r.glyphs.length, 0) : 0} 个符号`
  + (notes.length ? `\n  解析说明：\n    - ${notes.join('\n    - ')}` : ''),
);
