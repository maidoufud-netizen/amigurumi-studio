/**
 * 零依赖测试：node test/run.js
 * 覆盖：经典头部件序列、耦合守恒、夹紧修正、校验器、剖面构建。
 */
import {
  createPattern, createPart, roundTops, roundBases, roundOps, partCounts,
} from '../src/ir.js';
import { planRound, spreadOps, clampForCoupling, buildPartFromProfile, PRESETS, idealCounts, normalizeProfile } from '../src/build.js';
import { formatOps, toText, expandOps } from '../src/pattern.js';
import { validatePattern } from '../src/validate.js';
import { layoutChart, chartToSVG, chartStats } from '../src/chart.js';
import { boundaryRings, bodyBands, stitchGridSegments, rulerSegments } from '../src/solid.js';
import { profileFromSpec, normalizeSpec, radiusRatio, estimate } from '../src/shape.js';
import { parsePrompt } from '../src/prompt.js';
import { graphFromPart, octopusGraph, graphStats } from '../src/graph.js';
import { createSimulation, sampleFrames } from '../src/force.js';

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}\n    期望 ${b}\n    实际 ${a}`);
  }
}
function ok(cond, label) {
  if (cond) pass++;
  else { fail++; failures.push(label); }
}
function throws(fn, label) {
  try { fn(); fail++; failures.push(`${label}（本该抛错但没有）`); }
  catch { pass++; }
}

// ---------- 1. 经典头部件序列 ----------
{
  const counts = [6, 12, 18, 24, 30];
  const rounds = [ { n: 1, ops: [{ op: 'sc', count: 6 }] } ];
  for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  eq(rounds.map(roundTops), counts, '经典头部：每圈针数 6→12→18→24→30');
  eq(formatOps(rounds[0].ops), '6X', '第 1 圈写成 6X');
  eq(formatOps(rounds[1].ops), '6V', '第 2 圈写成 6V');
  eq(formatOps(rounds[2].ops), '(X,V)×6', '第 3 圈写成 (X,V)×6');
  eq(formatOps(rounds[3].ops), '(2X,V)×6', '第 4 圈写成 (2X,V)×6');
  eq(formatOps(rounds[4].ops), '(3X,V)×6', '第 5 圈写成 (3X,V)×6');
}

// ---------- 2. 耦合守恒：每圈吃掉的基针 == 上一圈针数 ----------
{
  const counts = [6, 12, 18, 24, 30, 24, 18, 12, 6];
  const rounds = [{ n: 1, ops: [{ op: 'sc', count: 6 }] }];
  for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  let allOk = true;
  for (let i = 1; i < rounds.length; i++) {
    if (roundBases(rounds[i]) !== roundTops(rounds[i - 1])) allOk = false;
  }
  ok(allOk, '先加后减的完整球体：每圈基针数严格等于上一圈针数');
  eq(rounds.map(roundTops), counts, '球体针数曲线对称');
}

// ---------- 3. 加减针分布是均匀的（正圆而非偏心） ----------
{
  const r = planRound(12, 18, 3);
  const spec = new Set();
  let idx = 0;
  let lastPos = null;
  for (const { op, count } of r.ops) {
    for (let i = 0; i < count; i++) {
      if (op === 'inc') { if (lastPos !== null) spec.add(idx - lastPos); lastPos = idx; }
      idx++;
    }
  }
  ok(spec.size <= 2, '加针间距均匀（只有一种或两种间距）');
  eq(expandOps(spreadOps(12, 6, 'inc')).length, 12, '12 个基针里放 6 个加针 → 12 个操作位');
  eq(expandOps(spreadOps(18, 6, 'dec')).length, 18, '24 减到 18：18 个操作位（6 个减针各吃 2 基针）');
  const rd = planRound(24, 18, 2);
  eq(roundBases(rd), 24, '24→18 的圈吃满 24 个基针');
  eq(roundTops(rd), 18, '24→18 的圈产生 18 针');
}

// ---------- 4. 耦合约束与夹紧 ----------
{
  const { counts, clamps } = clampForCoupling([6, 20, 3, 9]);
  eq(counts, [6, 12, 6, 9], '夹紧：20→12（最多翻倍）、3→6（最多减半）');
  eq(clamps.length, 2, '记录了两处夹紧');
  eq(clamps[0].reason.includes('翻倍'), true, '夹紧原因可读');
}

// ---------- 5. 校验器能抓出错误图解 ----------
{
  // 第 2 圈只吃掉 5 个基针，但上一圈有 6 针 → 漏钩
  const bad = createPattern({ name: '错图解' });
  bad.parts.push(createPart({
    id: 'head',
    rounds: [
      { n: 1, ops: [{ op: 'sc', count: 6 }] },
      { n: 2, ops: [{ op: 'sc', count: 4 }, { op: 'inc', count: 1 }] }, // bases=5 ≠ 6
    ],
  }));
  const res = validatePattern(bad);
  eq(res.ok, false, '错图解被判定为不可钩');
  ok(res.issues.some((i) => i.code === 'V003'), '抓到 V003 基针数不匹配');

  // 正确的球体应通过
  const good = createPart({ id: 'head', rounds: [
    { ops: [{ op: 'sc', count: 6 }] },
    { ops: [{ op: 'inc', count: 6 }] },
    { ops: [{ op: 'sc', count: 1 }, { op: 'inc', count: 1 }, { op: 'sc', count: 1 }, { op: 'inc', count: 1 },
            { op: 'sc', count: 1 }, { op: 'inc', count: 1 }, { op: 'sc', count: 1 }, { op: 'inc', count: 1 },
            { op: 'sc', count: 1 }, { op: 'inc', count: 1 }, { op: 'sc', count: 1 }, { op: 'inc', count: 1 }] },
    { ops: [{ op: 'sc', count: 6 }, { op: 'dec', count: 6 }] },
  ] });
  const p = createPattern({ name: '好图解' });
  p.parts.push(good);
  const res2 = validatePattern(p);
  eq(res2.ok, true, '合法图解通过校验');
}

// ---------- 6. 剖面 → 针数曲线（球体应先增后减、大致对称） ----------
{
  const gauge = { w: 5, h: 5 };
  const profile = normalizeProfile(PRESETS.ball(25));
  const { part, plan } = buildPartFromProfile(profile, gauge, { id: 'head' });
  const counts = partCounts(part);
  const peakIdx = counts.indexOf(Math.max(...counts));
  ok(peakIdx > 0 && peakIdx < counts.length - 1, '球体峰值出现在中段');
  ok(counts[0] < counts[peakIdx], '起点小于峰值');
  ok(counts[counts.length - 1] < counts[peakIdx], '终点小于峰值');
  ok(plan.deviation.maxRel < 0.35, `整数化偏差在可接受范围（实际 ${(plan.deviation.maxRel * 100).toFixed(1)}%）`);
  const res = validatePattern(createPatternWith(part));
  ok(res.ok, '剖面生成的部件通过校验：' + (res.issues.map(i=>i.code).join(',') || '无问题'));
}

function createPatternWith(part) {
  const p = createPattern({ name: 't', gauge: { w: 5, h: 5 } });
  p.parts.push(part);
  return p;
}

// ---------- 7. 边界与错误处理 ----------
{
  throws(() => planRound(6, 13, 2), '单圈翻倍以上被拒绝（13 > 2×6）');
  throws(() => normalizeProfile([{ h: 0, r: 5 }]), '剖面点太少被拒绝');
  const t = toText(createPatternWith(createPart({ id: 'head', rounds: [
    { ops: [{ op: 'sc', count: 6 }] }, { ops: [{ op: 'inc', count: 6 }] },
  ] })));
  ok(t.includes('6X') && t.includes('6V'), '文字图解包含 6X / 6V');
  ok(t.includes('起立针/引拔针不计入针数'), '文字图解显式声明了立针约定');
}

// ---------- 8. 图解布局与渲染（chart.js） ----------
{
  const counts = [6, 12, 18, 24, 30, 24, 18, 12, 6];
  const rounds = [{ n: 1, ops: [{ op: 'sc', count: 6 }] }];
  for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  const ball = createPart({ id: 'ball', rounds });

  const L = layoutChart(ball);
  eq(L.ok, true, '球体图解可以定位');
  eq(L.rings.length, counts.length, '环数 == 圈数');

  const opsCounts = rounds.map(roundOps);
  eq(L.rings.map((r) => r.stitches.length), counts, '每环针目数 == 该圈针数 cₙ（拓扑正确，下一圈靠它定位）');
  eq(L.rings.map((r) => r.glyphs.length), opsCounts, '每环绘图符号数 == 该圈操作数（加针两针合一符号）');

  let mono = true;
  for (let i = 1; i < L.rings.length; i++) if (L.rings[i].r <= L.rings[i - 1].r) mono = false;
  ok(mono, '半径单调递增（圈与圈必须嵌套）');

  let arcOk = true;
  for (const ring of L.rings) {
    if ((2 * Math.PI * ring.r) / ring.stitches.length < 7.19) arcOk = false;
  }
  ok(arcOk, '每针弧长 ≥ cell（60 针的圈不会挤成一团）');

  eq(L.rings[0].stitches[0].angle, 0, '第 1 圈首针角度为 0（正上方起针）');

  const totalOps = opsCounts.reduce((a, b) => a + b, 0);
  const { svg } = chartToSVG(ball);
  ok(svg.startsWith('<svg'), 'SVG 以 <svg 开头');
  ok(svg.trimEnd().endsWith('</svg>'), 'SVG 正确闭合');
  ok((svg.match(/<path/g) || []).length >= totalOps, `SVG 的 path 数不少于总针数 ${totalOps}`);
  ok(!svg.includes('fill="#0'), '符号无填充色（纯线稿）');

  // 不可钩的图解必须被拒绝，且给出原因
  const bad = createPart({
    id: 'bad',
    rounds: [
      { n: 1, ops: [{ op: 'sc', count: 6 }] },
      { n: 2, ops: [{ op: 'sc', count: 4 }, { op: 'inc', count: 1 }] },
    ],
  });
  const LB = layoutChart(bad);
  eq(LB.ok, false, '漏针的图解无法定位');
  ok(typeof LB.error === 'string' && LB.error.length > 0, '拒绝定位时给出原因');

  const st = chartStats(ball);
  eq(st.rounds, counts.length, 'chartStats 圈数正确');
  eq(st.peak, 30, 'chartStats 峰值正确');
  eq(st.peakRound, 5, 'chartStats 峰值所在圈正确');
  eq(st.last, 6, 'chartStats 收口正确');
}

// ---------- 9. 三维几何数据（solid.js） ----------
{
  const gauge = { w: 5, h: 5 };
  const counts = [6, 12, 18, 24, 30, 24, 18, 12, 6];
  const rounds = [{ n: 1, ops: [{ op: 'sc', count: 6 }] }];
  for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  const ball = createPart({ id: 'ball', rounds });

  const { rings, radii } = boundaryRings(counts, gauge);
  eq(rings.length, counts.length + 1, '圈边界数 == 圈数 + 1');
  let yMono = true;
  for (let i = 1; i < rings.length; i++) if (!(rings[i].y > rings[i - 1].y)) yMono = false;
  ok(yMono, '圈边界的 y 严格递增（回转体不自交的充要条件）');
  ok(rings.every((r) => r.r >= 0), '所有边界半径非负');
  ok(rings[0].r < Math.max(...rings.map((x) => x.r)), '两端是收口小口（球体半径先增后减，不单调是对的）');
  eq(radii[4], (30 * 5) / (2 * Math.PI), '第 5 圈半径 == c·w/2π');

  const bands = bodyBands(counts, gauge);
  eq(bands.length, counts.length, '曲面分段数 == 圈数');
  eq(bands.map((b) => b.round), counts.map((_, i) => i + 1), '每段挂着正确的圈号（逐圈高亮靠它）');
  eq(bands[0].y0, 0, '第一段从 y=0 起');
  eq(bands[bands.length - 1].y1, counts.length * gauge.h, '最后一段到总高度');

  const grid = stitchGridSegments(ball, gauge);
  eq(grid.ok, true, '针目网格生成成功');
  eq(grid.verticalCounts, counts, '每圈纵向网格线数 == 该圈针数（数格子 = 数针）');
  eq(grid.positions.length % 6, 0, '线段端点成对（每 6 个数字一段）');
  ok(grid.positions.every((v) => Number.isFinite(v)), '网格坐标全是有限数');

  const ruler = rulerSegments(counts, gauge);
  eq(ruler.height, counts.length * gauge.h, '标尺高度 == 成品高度');
  eq(ruler.ticks, Math.floor(ruler.height / 10) + 1, '刻度数 == 高度/10 + 1');

  const bad = createPart({
    id: 'bad',
    rounds: [
      { n: 1, ops: [{ op: 'sc', count: 6 }] },
      { n: 2, ops: [{ op: 'sc', count: 4 }, { op: 'inc', count: 1 }] },
    ],
  });
  const gb = stitchGridSegments(bad, gauge);
  eq(gb.ok, false, '不可钩的图解拒绝生成三维网格');
  ok(typeof gb.error === 'string' && gb.error.length > 0, '拒绝时给出原因');
}

// ---------- 10. 形状规格（shape.js） ----------
{
  const ball = profileFromSpec({ kind: 'ball', diameter: 50, height: 50 });
  eq(ball.length, 9, '默认采样 9 个剖面点');
  eq(ball[0].h, 0, '第一个点在底部');
  eq(ball[ball.length - 1].h, 50, '最后一个点在顶部');
  const maxR = Math.max(...ball.map((p) => p.r));
  ok(Math.abs(maxR - 25) < 1e-6, `球体最大半径 == 直径/2 == 25（实际 ${maxR.toFixed(4)}）`);
  ok(Math.abs(radiusRatio(0.5, { kind: 'ball' }) - 1) < 1e-9, '最粗处的半径比例 == 1');

  ok(normalizeSpec({ kind: '不存在的形状' }).kind === 'ball', '未知形状退回球');
  const clamped = normalizeSpec({ kind: 'ball', diameter: -5, height: 1e9, widestAt: 5, bulge: 99 });
  ok(clamped.diameter >= 4, '直径被夹到下限');
  ok(clamped.widestAt <= 0.98 && clamped.bulge <= 3, '比例与鼓起度被夹到区间内');

  const cylR = profileFromSpec({ kind: 'cylinder', diameter: 40, height: 60 }).map((p) => p.r);
  ok(Math.max(...cylR) - Math.min(...cylR) < 1e-6, '直筒半径处处相等');

  const cone = profileFromSpec({ kind: 'cone', diameter: 40, height: 60 });
  ok(cone[0].r > cone[cone.length - 1].r, '锥体底部比顶部粗');

  const egg = profileFromSpec({ kind: 'egg', diameter: 40, height: 60 });
  const eggPeak = egg.reduce((a, b) => (b.r > a.r ? b : a));
  ok(Math.abs(eggPeak.h - 0.62 * 60) < 1e-9, `蛋形峰值采样在 62% 高度（${eggPeak.h}mm）`);
  ok(Math.abs(eggPeak.r - 20) < 1e-9, '蛋形实际最大半径 == 设定直径的一半（最粗处被采到了）');

  for (const kind of ['ball', 'egg', 'teardrop', 'cone', 'cylinder']) {
    const pts = profileFromSpec({ kind, diameter: 40, height: 60 });
    const peak = Math.max(...pts.map((p) => p.r));
    ok(Math.abs(peak - 20) < 1e-6, `${kind}：最大半径严格等于 直径/2`);
  }

  const est = estimate({ kind: 'ball', diameter: 50, height: 50 }, { w: 5, h: 5 });
  eq(est.rounds, 10, '估计圈数 == 高 / 针高');
  eq(est.peak, Math.round((Math.PI * 50) / 5), '估计峰值针数 == 周长 / 针宽');
}

// ---------- 11. 提示词解析（prompt.js） ----------
{
  const a = parsePrompt('直径 6cm 的圆球');
  eq(a.spec.kind, 'ball', '“圆球” → 球');
  eq(a.spec.diameter, 60, '“直径 6cm” → 60mm');
  eq(a.spec.height, 60, '只给直径时按形状惯例推出高度');

  const b = parsePrompt('高 8cm 的水滴形');
  eq(b.spec.kind, 'teardrop', '“水滴形” → 水滴');
  eq(b.spec.height, 80, '“高 8cm” → 80mm');
  ok(b.spec.diameter !== 80, '高度用的数字不会被再当成直径（这是修过的 bug）');
  ok(b.spec.diameter > 0, '只给高度时直径被推出');

  const c = parsePrompt('5厘米的小球');
  eq(c.spec.kind, 'ball', '“小球” → 球');
  eq(c.spec.diameter, 50, '没有关键词的尺寸按直径理解');

  const d = parsePrompt('头围 30cm 的圆头');
  eq(d.spec.diameter, Math.round(300 / Math.PI), '围度 ÷ π 换算成直径');

  const e = parsePrompt('细长的手臂，长 10cm，粗 2cm');
  eq(e.spec.height, 100, '写明高度后“细长”不再叠乘');
  eq(e.spec.diameter, 20, '“粗 2cm” → 直径 20mm');

  const f = parsePrompt('直径8cm高12cm的直筒');
  eq(f.spec.kind, 'cylinder', '“直筒” → 直筒');
  eq(f.spec.diameter, 80, '直径 80mm');
  eq(f.spec.height, 120, '高 120mm');

  const g = parsePrompt('圆球，胖一点');
  ok(g.spec.diameter > 50, '“胖一点”让直径变大');

  const h = parsePrompt('下面胖一点的水滴');
  eq(h.spec.kind, 'teardrop', '“水滴”优先于“圆”类词');
  ok(h.spec.widestAt < 0.5, '“下面胖”让最粗处下移');

  ok(parsePrompt('').notes.length > 0, '空输入给出说明');
  ok(parsePrompt('随便什么').notes.some((n) => n.includes('没认出')), '认不出时明确说明');
}

// ---------- 12. 拓扑图与力导向（graph.js / force.js） ----------
{
  const gauge = { w: 5, h: 5 };
  const counts = [6, 12, 18, 24, 30, 24, 18, 12, 6];
  const rounds = [{ n: 1, ops: [{ op: 'sc', count: 6 }] }];
  for (let i = 1; i < counts.length; i++) rounds.push(planRound(counts[i - 1], counts[i], i + 1));
  const sphere = graphFromPart(createPart({ id: 'sphere', rounds }), gauge);

  eq(sphere.nodes.length, counts.reduce((a, b) => a + b, 0), '节点数 == 所有针数之和');
  eq(new Set(sphere.nodes.map((n) => n.id)).size, sphere.nodes.length, '节点 id 唯一');
  ok(sphere.links.length > sphere.nodes.length, '边数多于节点数（圈内边 + 耦合边）');
  ok(sphere.nodes.every((n) => n.seed && Number.isFinite(n.seed.x)), '每个节点都有初始种子坐标');
  const kinds = new Set(sphere.links.map((l) => l.kind));
  ok(kinds.has('ring') && kinds.has('couple'), '同时存在圈内边与耦合边');

  throws(
    () => graphFromPart(createPart({
      id: 'bad',
      rounds: [
        { n: 1, ops: [{ op: 'sc', count: 6 }] },
        { n: 2, ops: [{ op: 'sc', count: 4 }, { op: 'inc', count: 1 }] },
      ],
    }), gauge),
    '漏针的图解拒绝建图',
  );

  // 收敛与确定性
  const a = createSimulation(sphere, { linkDistance: gauge.w });
  const steps = a.run(400);
  eq(a.alpha, 0, `力求解在 400 步内收敛（实际 ${steps} 步）`);
  const b = createSimulation(sphere, { linkDistance: gauge.w });
  b.run(400);
  let worst = 0;
  for (let i = 0; i < a.nodes.length; i++) {
    worst = Math.max(
      worst,
      Math.abs(a.nodes[i].x - b.nodes[i].x),
      Math.abs(a.nodes[i].y - b.nodes[i].y),
      Math.abs(a.nodes[i].z - b.nodes[i].z),
    );
  }
  eq(worst, 0, '两次独立模拟完全一致（确定性可复现）');

  // 关键交叉验证：纯拓扑喂进去，物理算出来的圈半径应接近解析式 c·w/2π
  const c0 = a.summary().center;
  const byRound = new Map();
  for (const n of a.nodes) {
    if (!byRound.has(n.round)) byRound.set(n.round, []);
    byRound.get(n.round).push(n);
  }
  let maxRatio = 0;
  for (const [, list] of byRound) {
    const ringR = list.reduce((s, n) => s + Math.hypot(n.x - c0.x, n.z - c0.z), 0) / list.length;
    const predicted = (list.length * gauge.w) / (2 * Math.PI);
    maxRatio = Math.max(maxRatio, Math.abs(ringR - predicted) / predicted);
  }
  ok(maxRatio < 0.4, `纯拓扑力布局与解析式的最大相对偏差 ${(maxRatio * 100).toFixed(0)}% < 40%`);

  // 钉住 + 重新加热（拖动交互）
  const sim = createSimulation(sphere, { linkDistance: gauge.w });
  sim.run(200);
  const target = sim.nodes[0];
  const wantX = target.x + 15;
  sim.pin(target.id, { x: wantX, y: target.y, z: target.z });
  sim.reheat(1);
  eq(sim.alpha, 1, '重新加热把 alpha 重置为 1');
  sim.run(200);
  ok(Math.abs(target.x - wantX) < 1e-6, '被钉住的节点精确停在拖动位置');
  ok(sim.pin(target.id, null), '释放钉住返回成功');

  // 章鱼：解析式（回转体）根本表达不了的拓扑
  const oct = octopusGraph(gauge);
  const st = graphStats(oct);
  ok(st.chains > 0, '章鱼图包含分支节点（触手）');
  ok(st.nodes > sphere.nodes.length, '章鱼规模大于球体');
  const osim = createSimulation(oct, { linkDistance: gauge.w, gravityStrength: 0.05 });
  osim.run(300);
  const bodyLow = Math.min(...osim.nodes.filter((n) => !n.chain).map((n) => n.y));
  const chainLow = Math.min(...osim.nodes.filter((n) => n.chain).map((n) => n.y));
  ok(chainLow < bodyLow - 3, `触手垂到身体下方 ${(bodyLow - chainLow).toFixed(1)}mm`);

  const { frames } = sampleFrames(sphere, { steps: 40, every: 10, linkDistance: gauge.w });
  eq(frames.length, 4, 'sampleFrames 按间隔产出 4 帧');
  eq(frames[0].length, sphere.nodes.length, '每帧包含全部节点');
}

// ---------- 结果 ----------
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✅ 全部通过\n');
