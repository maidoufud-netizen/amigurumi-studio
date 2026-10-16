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

// ---------- 结果 ----------
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✅ 全部通过\n');
