/**
 * 图解预览窗口的接线层。
 * 自己不画图、不算针数：剖面来自 src/build.js，图来自 src/chart.js。
 */
import { createPattern } from '../src/ir.js';
import { buildPartFromProfile, PRESETS, normalizeProfile } from '../src/build.js';
import { validatePattern, report } from '../src/validate.js';
import { toText } from '../src/pattern.js';
import { chartToSVG, chartStats } from '../src/chart.js';

const $ = (id) => document.getElementById(id);
const state = { preset: 'ball', gauge: { w: 5, h: 5 } };

function parseProfile(text) {
  const pts = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.split(/[,，\s]+/).filter(Boolean);
    if (m.length < 2) continue;
    pts.push({ h: parseFloat(m[0]), r: parseFloat(m[1]) });
  }
  return normalizeProfile(pts);
}

function applyPreset(name) {
  const p = {
    ball: PRESETS.ball(25),
    teardrop: PRESETS.teardrop(25),
    cone: PRESETS.cone(25),
    cylinder: PRESETS.cylinder(20, 50),
  }[name] || PRESETS.ball(25);
  $('profile').value = p.map((q) => `${q.h.toFixed(1)}, ${q.r.toFixed(1)}`).join('\n');
}

function render() {
  state.gauge = { w: +$('w').value, h: +$('h').value };
  $('wv').textContent = state.gauge.w.toFixed(1);
  $('hv').textContent = state.gauge.h.toFixed(1);

  let part;
  let plan;
  try {
    const r = buildPartFromProfile(parseProfile($('profile').value), state.gauge, { id: 'head' });
    part = r.part;
    plan = r.plan;
  } catch (e) {
    $('chart').textContent = '剖面解析失败：' + e.message;
    return;
  }

  const pattern = createPattern({ name: '预览部件', gauge: state.gauge });
  pattern.parts.push(part);

  // ① 图解渲染
  const { svg, layout } = chartToSVG(part, { title: `第 1–${part.rounds.length} 圈` });
  $('chart').innerHTML = layout.ok
    ? svg
    : `<div style="padding:20px;color:#b91c1c;font-size:14px">无法画图：${layout.error}</div>`;

  // ② 统计
  const st = chartStats(part);
  const res = validatePattern(pattern);
  const peakMm = ((st.peak * state.gauge.w) / Math.PI).toFixed(1);
  $('info').innerHTML =
    `共 <b>${st.rounds}</b> 圈 · 峰值 <b>${st.peak}</b> 针（第 ${st.peakRound} 圈）· 收口 ${st.last} 针 · ` +
    `合计 <b>${st.totalOps}</b> 针（加针 ${st.incs} 次 / 减针 ${st.decs} 次）<br>` +
    `成品约 Ø${peakMm}mm × 高 ${(st.rounds * state.gauge.h).toFixed(1)}mm　` +
    (res.ok ? '<b style="color:#059669">✅ 结构合法</b>' : '<b style="color:#b91c1c">❌ 不可钩</b>');

  // ③ 文字图解
  const out = [toText(pattern), '', '─'.repeat(34)];
  out.push(res.issues.length ? report(res) : '✅ 校验通过：结构合法，可以照着钩。');
  out.push(`整数化偏差：最大 ${(plan.deviation.maxRel * 100).toFixed(1)}%（${plan.deviation.maxAbs.toFixed(2)} mm）`);
  if (plan.clamps.length) {
    out.push('被耦合约束修正的圈：');
    for (const c of plan.clamps) out.push(`  第 ${c.round} 圈 ${c.want} → ${c.got}（${c.reason}）`);
  }
  $('pattern').textContent = out.join('\n');
}

$('preset').addEventListener('change', (e) => {
  state.preset = e.target.value;
  applyPreset(state.preset);
  render();
});
$('w').addEventListener('input', render);
$('h').addEventListener('input', render);
$('apply').addEventListener('click', render);
$('reset').addEventListener('click', () => {
  applyPreset(state.preset);
  render();
});
$('print').addEventListener('click', () => window.print());

applyPreset(state.preset);
render();
