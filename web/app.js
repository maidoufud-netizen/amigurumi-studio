/**
 * 预览界面：剖面 → 针数序列 → 3D 回转体 + 逐圈高亮 + 侧视对照。
 *
 * 铁律（README 设计原则 1）：图解与预览同源。
 * 本文件不自己算任何针数，全部来自 src/build.js，
 * 所以 3D 显示的形状和文字图解**不可能**不一致——不一致就是 bug。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createPattern, roundTops, roundOps } from '../src/ir.js';
import { buildPartFromProfile, PRESETS, normalizeProfile } from '../src/build.js';
import { validatePattern, report } from '../src/validate.js';
import { toText } from '../src/pattern.js';

const $ = (id) => document.getElementById(id);

const state = {
  preset: 'ball',
  gauge: { w: 5, h: 5 },
  current: 1,
  part: null,
  plan: null,
};

/* ────────────────────────────── three.js 场景 ────────────────────────────── */

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef4fb);

const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 20000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0x33415a, 1.15));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
keyLight.position.set(60, 130, 90);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
fillLight.position.set(-90, 30, -70);
scene.add(fillLight);

const group = new THREE.Group();
scene.add(group);

const MAT = {
  past: new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.92, side: THREE.DoubleSide }),
  current: new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.75, side: THREE.DoubleSide }),
  future: new THREE.MeshStandardMaterial({
    color: 0xcbd5e1, roughness: 0.95, side: THREE.DoubleSide, transparent: true, opacity: 0.55,
  }),
};

let bands = [];   // [{ mesh, round }]

function resize() {
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 460;
  renderer.setSize(w, h, false);   // false: 不改 CSS，避免 ResizeObserver 自激
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/**
 * 由针数序列推出回转体的环。
 * 第 n 圈占据 y ∈ [(n-1)h, nh]，中心 (n-0.5)h，半径 rₙ = cₙ·w/2π。
 * 环边界取相邻两圈半径的均值，首尾收成小口（模拟起针与收口）。
 */
function ringsOf(counts, gauge) {
  const n = counts.length;
  const rs = counts.map((c) => (c * gauge.w) / (2 * Math.PI));
  const rings = [{ y: 0, r: rs[0] * 0.42 }];
  for (let i = 1; i < n; i++) rings.push({ y: i * gauge.h, r: (rs[i - 1] + rs[i]) / 2 });
  rings.push({ y: n * gauge.h, r: rs[n - 1] * 0.42 });
  return { rings, rs };
}

function rebuild3D() {
  for (const b of bands) {
    group.remove(b.mesh);
    b.mesh.geometry.dispose();
  }
  bands = [];
  if (!state.part) return;

  const counts = state.part.rounds.map(roundTops);
  const { rings } = ringsOf(counts, state.gauge);

  for (let j = 1; j <= counts.length; j++) {
    const a = rings[j - 1];
    const b = rings[j];
    const geo = new THREE.LatheGeometry(
      [new THREE.Vector2(Math.max(a.r, 0.05), a.y), new THREE.Vector2(Math.max(b.r, 0.05), b.y)],
      72,
    );
    const mesh = new THREE.Mesh(geo, MAT.future);
    mesh.userData.round = j;
    group.add(mesh);
    bands.push({ mesh, round: j });
  }
  applyHighlight();
  fitCamera(counts);
}

function applyHighlight() {
  for (const { mesh, round } of bands) {
    mesh.material = round === state.current ? MAT.current : round < state.current ? MAT.past : MAT.future;
  }
}

function fitCamera(counts) {
  const h = counts.length * state.gauge.h;
  const maxR = (Math.max(...counts) * state.gauge.w) / (2 * Math.PI);
  const d = Math.max(h, maxR * 2.2) * 1.5 + 40;
  camera.position.set(d * 0.52, h * 0.72, d * 0.78);
  camera.near = Math.max(0.5, d / 400);
  camera.far = d * 20;
  camera.updateProjectionMatrix();
  controls.target.set(0, h / 2, 0);
  controls.update();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

/* ────────────────────────── 2D 侧视：目标 vs 实际 ────────────────────────── */

function draw2D() {
  const c = $('profile');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = c.clientWidth || 640;
  const H = c.clientHeight || 170;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!state.part || !state.plan) return;

  const counts = state.part.rounds.map(roundTops);
  const actual = counts.map((n, i) => ({
    r: (n * state.gauge.w) / (2 * Math.PI),
    y: (i + 0.5) * state.gauge.h,
  }));
  const prof = state.plan.profile;
  const totalH = counts.length * state.gauge.h;
  const maxR = Math.max(1, ...prof.map((p) => p.r), ...actual.map((a) => a.r));

  const pad = 18;
  const sx = (W / 2 - pad) / maxR;
  const sy = (H - 2 * pad) / Math.max(totalH, 1);
  const X = (r) => W / 2 + r * sx;
  const Y = (y) => H - pad - y * sy;

  // 中轴
  g.strokeStyle = '#e2e8f0';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(W / 2, pad * 0.6);
  g.lineTo(W / 2, H - pad * 0.6);
  g.stroke();

  // 目标轮廓（虚线）
  g.setLineDash([5, 4]);
  g.strokeStyle = '#94a3b8';
  g.lineWidth = 2;
  g.beginPath();
  prof.forEach((p, i) => (i ? g.lineTo(X(p.r), Y(p.h)) : g.moveTo(X(p.r), Y(p.h))));
  g.stroke();
  g.setLineDash([]);

  // 实际（实线）
  g.strokeStyle = '#2563eb';
  g.lineWidth = 2.5;
  g.beginPath();
  actual.forEach((a, i) => (i ? g.lineTo(X(a.r), Y(a.y)) : g.moveTo(X(a.r), Y(a.y))));
  g.stroke();

  // 当前圈
  const cur = actual[state.current - 1];
  if (cur) {
    g.strokeStyle = '#f59e0b';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(W / 2, Y(cur.y));
    g.lineTo(X(cur.r), Y(cur.y));
    g.stroke();
    g.fillStyle = '#f59e0b';
    g.beginPath();
    g.arc(X(cur.r), Y(cur.y), 3.5, 0, Math.PI * 2);
    g.fill();
  }
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

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

function rebuild() {
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
    $('pattern').textContent = '剖面解析失败：' + e.message;
    return;
  }
  state.part = part;
  state.plan = plan;

  const rounds = part.rounds.length;
  if (state.current > rounds) state.current = rounds;
  if (state.current < 1) state.current = 1;
  const slider = $('round');
  slider.max = String(rounds);
  slider.value = String(state.current);
  $('rv').textContent = String(state.current);

  const pattern = createPattern({ name: '预览部件', gauge: state.gauge });
  pattern.parts.push(part);
  const res = validatePattern(pattern);

  const out = [toText(pattern), '', '─'.repeat(36)];
  if (!res.issues.length) out.push('✅ 校验通过：结构合法，可以照着钩。');
  else out.push(report(res));
  out.push('');
  out.push(
    `整数化 + 约束偏差：最大 ${(plan.deviation.maxRel * 100).toFixed(1)}%` +
      `（${plan.deviation.maxAbs.toFixed(2)} mm）`,
  );
  if (plan.clamps.length) {
    out.push('被耦合约束修正的圈：');
    for (const c of plan.clamps) out.push(`  第 ${c.round} 圈 ${c.want} → ${c.got}（${c.reason}）`);
  }
  $('pattern').textContent = out.join('\n');

  const issuesEl = $('issues');
  if (res.issues.length) {
    issuesEl.className = 'warnbox';
    issuesEl.textContent = report(res);
  } else {
    issuesEl.className = '';
    issuesEl.innerHTML = '<div class="ok" style="margin-top:10px">✅ 结构合法，可以照着钩</div>';
  }

  const peak = Math.max(...part.rounds.map(roundTops));
  const total = part.rounds.reduce((a, r) => a + roundOps(r), 0);
  $('stats').textContent =
    `共 ${rounds} 圈 · 峰值 ${peak} 针 · 合计 ${total} 针 · ` +
    `成品约 Ø${((peak * state.gauge.w) / Math.PI).toFixed(1)}mm × 高 ${(rounds * state.gauge.h).toFixed(1)}mm`;

  rebuild3D();
  draw2D();
}

/* ─────────────────────────────── 事件绑定 ─────────────────────────────── */

$('preset').addEventListener('change', (e) => {
  state.preset = e.target.value;
  applyPreset(state.preset);
  state.current = 1;
  rebuild();
});
$('w').addEventListener('input', rebuild);
$('h').addEventListener('input', rebuild);
$('apply').addEventListener('click', () => {
  state.current = 1;
  rebuild();
});
$('reset').addEventListener('click', () => {
  applyPreset(state.preset);
  state.current = 1;
  rebuild();
});
$('round').addEventListener('input', (e) => {
  state.current = +e.target.value;
  $('rv').textContent = String(state.current);
  applyHighlight();
  draw2D();
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    resize();
    draw2D();
  }).observe(canvas);
}

applyPreset(state.preset);
resize();
rebuild();
animate();
