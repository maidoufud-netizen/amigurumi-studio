/**
 * 三维可视化：把图解渲染成可以看、可以数针的实体。
 *
 * 三个层次，从粗到细：
 *   ① 曲面本体   —— 按每圈针数换算半径的回转体
 *   ② 针目网格   —— 每一针在曲面上占一个格子（横向=圈边界，纵向=针与针的分界）
 *   ③ 标尺       —— 每 10mm 一格，50mm 加长，用来读尺寸
 *
 * 关键点：②的每一根纵向网格线，角度来自 src/chart.js 的 layoutChart()，
 * 也就是"这一针真正穿在上一圈哪一针上"的拓扑定位。
 * 所以三维网格、符号图解、文字图解三者用的是同一份角度数据 —— 不可能对不上。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createPattern, roundTops, roundOps } from '../src/ir.js';
import { buildPartFromProfile, PRESETS, normalizeProfile } from '../src/build.js';
import { validatePattern, report } from '../src/validate.js';
import { toText } from '../src/pattern.js';
import { bodyBands, stitchGridSegments, rulerSegments, fitView } from '../src/solid.js';

const $ = (id) => document.getElementById(id);

const state = {
  preset: 'ball',
  gauge: { w: 5, h: 5 },
  current: 1,
  part: null,
  plan: null,
  showGrid: true,
  showRuler: true,
};

/* ────────────────────────────── three.js 场景 ────────────────────────────── */

const canvas = $('view');

function showBootError(text) {
  const el = $('boot-error');
  if (el) {
    el.style.display = 'block';
    el.textContent = String(text);
  }
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  showBootError(
    '无法创建 WebGL 上下文，三维视图无法显示。\n'
    + '可能原因：浏览器禁用了 WebGL / 显卡驱动过旧 / 远程桌面或虚拟机没有硬件加速。\n'
    + '排查：地址栏打开 chrome://gpu 看 WebGL 是否 Enabled；或在浏览器设置里开启「使用硬件加速」。\n\n'
    + '原始错误：' + err.message,
  );
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

// 诊断信息：三维若空白，这一行能立刻区分「WebGL 没起来」还是「几何算错了」
let glInfo = '未知';
try {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  glInfo = `three r${THREE.REVISION} · ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '（渲染器名被浏览器隐藏）'}`;
} catch { /* 拿不到就算了，不影响渲染 */ }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef2f7);

const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 20000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4658, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
keyLight.position.set(70, 140, 100);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
fillLight.position.set(-90, 40, -80);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
rimLight.position.set(0, -60, -100);
scene.add(rimLight);

const group = new THREE.Group();
scene.add(group);

const bodyMat = {
  past: new THREE.MeshStandardMaterial({ color: 0x7ea6d8, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
  current: new THREE.MeshStandardMaterial({ color: 0xf0a63a, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }),
  future: new THREE.MeshStandardMaterial({
    color: 0xc2d0e0, roughness: 0.97, metalness: 0, side: THREE.DoubleSide, transparent: true, opacity: 0.92,
  }),
};
const gridMat = new THREE.LineBasicMaterial({ color: 0x6f8399, transparent: true, opacity: 0.6 });
const rulerMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.85 });

let bandMeshes = [];
let gridObject = null;
let rulerObject = null;

function resize() {
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 460;
  renderer.setSize(w, h, false);   // false：不改 CSS，避免 ResizeObserver 自激
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* ① 曲面本体：每圈一个截锥段，便于逐圈高亮 */
function buildBody(counts, gauge) {
  for (const m of bandMeshes) {
    group.remove(m);
    m.geometry.dispose();
  }
  bandMeshes = [];
  for (const band of bodyBands(counts, gauge)) {
    const geo = new THREE.LatheGeometry(
      [
        new THREE.Vector2(Math.max(band.r0, 0.05), band.y0),
        new THREE.Vector2(Math.max(band.r1, 0.05), band.y1),
      ],
      96,
    );
    const mesh = new THREE.Mesh(geo, bodyMat.future);
    mesh.userData.round = band.round;
    group.add(mesh);
    bandMeshes.push(mesh);
  }
  applyHighlight();
}

/* ② 针目网格：横向圈边界 + 纵向针与针的分界（几何由 src/solid.js 算，可测） */
function buildStitchGrid(part, gauge, counts) {
  if (gridObject) {
    group.remove(gridObject);
    gridObject.geometry.dispose();
    gridObject = null;
  }
  if (!state.showGrid) return;

  const { positions, ok } = stitchGridSegments(part, gauge);
  if (!ok || !positions.length) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  gridObject = new THREE.LineSegments(geo, gridMat);
  group.add(gridObject);
}

/* ③ 标尺：每 10mm 一格，50mm 加长（几何由 src/solid.js 算） */
function buildRuler(counts, gauge) {
  if (rulerObject) {
    group.remove(rulerObject);
    rulerObject.geometry.dispose();
    rulerObject = null;
  }
  if (!state.showRuler) return;

  const { positions } = rulerSegments(counts, gauge);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  rulerObject = new THREE.LineSegments(geo, rulerMat);
  group.add(rulerObject);
}

function applyHighlight() {
  for (const mesh of bandMeshes) {
    const n = mesh.userData.round;
    mesh.material = n === state.current ? bodyMat.current : n < state.current ? bodyMat.past : bodyMat.future;
  }
}

/** 按模型实际包围盒取景：保证整件（含标尺）完整落在画面里 */
function fitCamera() {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const v = fitView(
    {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
    },
    { fov: camera.fov, aspect: camera.aspect },
  );
  camera.position.set(v.position.x, v.position.y, v.position.z);
  camera.near = v.near;
  camera.far = v.far;
  camera.updateProjectionMatrix();
  controls.target.set(v.target.x, v.target.y, v.target.z);
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

  g.strokeStyle = '#e2e8f0';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(W / 2, pad * 0.6);
  g.lineTo(W / 2, H - pad * 0.6);
  g.stroke();

  g.setLineDash([5, 4]);
  g.strokeStyle = '#94a3b8';
  g.lineWidth = 2;
  g.beginPath();
  prof.forEach((p, i) => (i ? g.lineTo(X(p.r), Y(p.h)) : g.moveTo(X(p.r), Y(p.h))));
  g.stroke();
  g.setLineDash([]);

  g.strokeStyle = '#2563eb';
  g.lineWidth = 2.5;
  g.beginPath();
  actual.forEach((a, i) => (i ? g.lineTo(X(a.r), Y(a.y)) : g.moveTo(X(a.r), Y(a.y))));
  g.stroke();

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

  const counts = part.rounds.map(roundTops);
  buildBody(counts, state.gauge);
  buildStitchGrid(part, state.gauge, counts);
  buildRuler(counts, state.gauge);
  fitCamera();
  draw2D();

  const out = [toText(pattern), '', '─'.repeat(36)];
  if (!res.issues.length) out.push('✅ 校验通过：结构合法，可以照着钩。');
  else out.push(report(res));
  out.push('');
  out.push(`整数化 + 约束偏差：最大 ${(plan.deviation.maxRel * 100).toFixed(1)}%（${plan.deviation.maxAbs.toFixed(2)} mm）`);
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

  const peak = Math.max(...counts);
  const total = part.rounds.reduce((a, r) => a + roundOps(r), 0);
  const H = rounds * state.gauge.h;
  $('stats').textContent =
    `共 ${rounds} 圈 · 峰值 ${peak} 针 · 合计 ${total} 针 · ` +
    `成品约 Ø${((peak * state.gauge.w) / Math.PI).toFixed(1)}mm × 高 ${H.toFixed(1)}mm` +
    `　（标尺：每格 10mm，长格 50mm）` +
    `\n渲染：${glInfo} · 分段 ${bandMeshes.length} 段 · 网格线 ${gridObject ? '已开' : '已关'}`;
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
$('grid').addEventListener('change', (e) => {
  state.showGrid = e.target.checked;
  rebuild();
});
$('ruler').addEventListener('change', (e) => {
  state.showRuler = e.target.checked;
  rebuild();
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
