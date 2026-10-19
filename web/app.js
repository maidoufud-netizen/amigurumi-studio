/**
 * 三维预览 —— 已重构为「拓扑图 + 力导向」管线。
 *
 * 和旧版的根本区别：
 *   旧版：针数序列 → 回转体截锥（只画旋转对称的壳，看不到针）
 *   新版：IR → 拓扑图 → 力导向求解 → **每个针目一个实例** + 耦合连线
 *
 * 所以你现在能在三维里直接数针、看见触手这类非回转体结构。
 *
 * 性能做法（对齐成熟实现）：几何只建一次，之后每个 tick 只更新
 * 实例矩阵与位置缓冲，绝不重建几何。物理跑在 Worker 里，主线程只收坐标。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createPattern, roundTops, roundOps } from '../src/ir.js';
import { buildPartFromProfile, normalizeProfile } from '../src/build.js';
import { profileFromSpec, normalizeSpec, describeSpec } from '../src/shape.js';
import { parsePrompt } from '../src/prompt.js';
import { buildAssembly, assemblyToPattern, describeAssembly } from '../src/assembly.js';
import { graphFromPart } from '../src/graph.js';
import { validatePattern, report } from '../src/validate.js';
import { toText } from '../src/pattern.js';
import { fitView } from '../src/solid.js';
import { createSimulation } from '../src/force.js';

const $ = (id) => document.getElementById(id);

const MAX_NODES = 6000;

const state = {
  // 形状规格是"人话参数"，提示词与形状控件都写到这里，再由 shape.js 变成剖面
  spec: { kind: 'ball', diameter: 50, height: 50 },
  // 装配体（多部件 + 挂载）。非空时优先于 spec —— 章鱼这种结构只能这么表达
  assembly: null,
  profileOverride: false,   // 手改过剖面曲线后置 true，此时剖面优先于规格
  gauge: { w: 5, h: 5 },
  current: 1,
  part: null,
  plan: null,
  count: 0,
  rounds: 0,
  showLinks: true,
  showNodes: true,
};

function showBootError(text) {
  const el = $('boot-error');
  if (el) {
    el.style.display = 'block';
    el.textContent = String(text);
  }
}

/* ────────────────────────────── three.js 场景 ────────────────────────────── */

const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  showBootError(
    '无法创建 WebGL 上下文，三维视图无法显示。\n'
    + '可能原因：浏览器禁用了 WebGL / 显卡驱动过旧 / 远程桌面无硬件加速。\n'
    + '排查：地址栏打开 chrome://gpu 看 WebGL 是否 Enabled。\n\n原始错误：' + err.message,
  );
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

let glInfo = '未知';
try {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  glInfo = `three r${THREE.REVISION} · ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '（渲染器名被隐藏）'}`;
} catch { /* 忽略 */ }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef2f7);

const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 20000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4658, 1.25));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
keyLight.position.set(70, 140, 100);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
fillLight.position.set(-90, 40, -80);
scene.add(fillLight);

/* ─────────────────── 针目（实例化）与耦合连线（一次建好） ─────────────────── */

const nodeGeo = new THREE.SphereGeometry(1, 10, 8);
const nodeMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02 });
const nodeMesh = new THREE.InstancedMesh(nodeGeo, nodeMat, MAX_NODES);
nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
nodeMesh.frustumCulled = false;
nodeMesh.count = 0;
scene.add(nodeMesh);

const linkGeo = new THREE.BufferGeometry();
linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_NODES * 8 * 3), 3));
linkGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
linkGeo.setDrawRange(0, 0);
const linkMesh = new THREE.LineSegments(
  linkGeo,
  new THREE.LineBasicMaterial({ color: 0x7d8ea4, transparent: true, opacity: 0.42 }),
);
linkMesh.frustumCulled = false;
scene.add(linkMesh);

const COLOR = {
  past: new THREE.Color(0x5b8cc8),
  current: new THREE.Color(0xe89a3c),
  future: new THREE.Color(0xb9c6d6),
  chain: new THREE.Color(0xd98a52),
};

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

let nodeMeta = [];          // [{round, chain}]
let linkPairs = null;       // Int32Array，[a,b, a,b, ...]
let lastPositions = null;

function ensureWorker() {
  try {
    return new Worker(new URL('./force.worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('Worker 不可用，退回主线程求解：', err);
    return null;
  }
}
const worker = ensureWorker();

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

let fallbackSim = null;
let fallbackRaf = 0;

function stopFallback() {
  if (fallbackRaf) cancelAnimationFrame(fallbackRaf);
  fallbackRaf = 0;
  fallbackSim = null;
}

/** 把一份坐标应用到场景（几何不变，只改矩阵与缓冲） */
function applyPositions(flat) {
  lastPositions = flat;
  const n = flat.length / 3;
  const r = Math.max(0.6, state.gauge.w * 0.42);   // 视觉半径 ≈ 半个针宽

  for (let i = 0; i < n; i++) {
    tmpPos.set(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]);
    tmpScale.set(r, r, r);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    nodeMesh.setMatrixAt(i, tmpMat);
  }
  nodeMesh.count = n;
  nodeMesh.instanceMatrix.needsUpdate = true;
  nodeMesh.visible = state.showNodes;

  if (linkPairs) {
    const arr = linkGeo.attributes.position.array;
    const count = linkPairs.length / 2;
    for (let k = 0; k < count; k++) {
      const a = linkPairs[k * 2] * 3;
      const b = linkPairs[k * 2 + 1] * 3;
      const o = k * 6;
      arr[o] = flat[a]; arr[o + 1] = flat[a + 1]; arr[o + 2] = flat[a + 2];
      arr[o + 3] = flat[b]; arr[o + 4] = flat[b + 1]; arr[o + 5] = flat[b + 2];
    }
    linkGeo.attributes.position.needsUpdate = true;
    linkGeo.setDrawRange(0, count * 2);
    linkMesh.visible = state.showLinks;
  }
  paintNodes();
}

/** 按"已钩 / 当前 / 未钩"给实例上色 */
function paintNodes() {
  if (!nodeMesh.count) return;
  const cur = state.current;
  for (let i = 0; i < nodeMesh.count; i++) {
    const meta = nodeMeta[i] || {};
    let c;
    if (meta.chain) c = COLOR.chain;
    else if (meta.round === cur) c = COLOR.current;
    else if (meta.round < cur) c = COLOR.past;
    else c = COLOR.future;
    nodeMesh.setColorAt(i, c);
  }
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
}

function fitCameraToNodes(flat) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < flat.length; i += 3) {
    minX = Math.min(minX, flat[i]); maxX = Math.max(maxX, flat[i]);
    minY = Math.min(minY, flat[i + 1]); maxY = Math.max(maxY, flat[i + 1]);
    minZ = Math.min(minZ, flat[i + 2]); maxZ = Math.max(maxZ, flat[i + 2]);
  }
  if (!Number.isFinite(minX)) return;
  const v = fitView(
    { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
    { fov: camera.fov, aspect: camera.aspect },
    { margin: 1.35 },
  );
  camera.position.set(v.position.x, v.position.y, v.position.z);
  camera.near = v.near;
  camera.far = v.far;
  camera.updateProjectionMatrix();
  controls.target.set(v.target.x, v.target.y, v.target.z);
  controls.update();
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.type === 'ready') {
    nodeMeta = msg.nodes;
    linkPairs = Int32Array.from(msg.links);
    linkGeo.setDrawRange(0, linkPairs.length / 2 * 2);
    $('status').textContent = `求解中…（${msg.total} 个针目）`;
    return;
  }
  if (msg.type === 'tick') {
    applyPositions(msg.positions);
    if (nodeMesh.count && !state.fitted) {
      fitCameraToNodes(msg.positions);
      state.fitted = true;
    }
    $('status').textContent = `求解中… α=${msg.alpha.toFixed(3)}`;
    return;
  }
  if (msg.type === 'end') {
    $('status').textContent = `收敛完成（${msg.ticks} 步）`;
    if (lastPositions) fitCameraToNodes(lastPositions);
  }
}

if (worker) worker.onmessage = onWorkerMessage;

function startLayout(graph) {
  state.fitted = false;
  stopFallback();
  const payload = {
    type: 'init',
    graph,
    gauge: state.gauge,
    options: { guideStrength: 0.06, chargeStrength: -6, chargeCutoff: 7 },
    stepsPerFrame: 3,
  };

  if (worker) {
    worker.postMessage(payload);
    return;
  }
  // 主线程兜底：结构一样，只是会和渲染抢时间
  fallbackSim = createSimulation(graph, { linkDistance: state.gauge.w, ...payload.options });
  nodeMeta = fallbackSim.nodes.map((n) => ({ round: n.round, chain: n.chain }));
  const at = new Map(fallbackSim.nodes.map((n, i) => [n.id, i]));
  linkPairs = Int32Array.from(
    fallbackSim.links.flatMap((l) => [at.get(l.source), at.get(l.target)]),
  );
  const pump = () => {
    if (!fallbackSim) return;
    for (let i = 0; i < 3 && fallbackSim.alpha > 0; i++) fallbackSim.tick();
    const flat = new Float32Array(fallbackSim.nodes.length * 3);
    fallbackSim.nodes.forEach((n, i) => {
      flat[i * 3] = n.x; flat[i * 3 + 1] = n.y; flat[i * 3 + 2] = n.z;
    });
    applyPositions(flat);
    if (!state.fitted) { fitCameraToNodes(flat); state.fitted = true; }
    if (fallbackSim.alpha > 0) fallbackRaf = requestAnimationFrame(pump);
    else { $('status').textContent = `收敛完成（${fallbackSim.ticks} 步）`; fitCameraToNodes(flat); }
  };
  pump();
}

/* ────────────────────────── 2D 侧视：目标 vs 实际 ────────────────────────── */

function draw2D() {
  // 注意：这里必须用 profileView（侧视图画布），不是 profile（剖面输入框）。
  // 早先两者同名，getElementById 拿到的是 textarea，于是 getContext 报错。
  const c = $('profileView');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = c.clientWidth || 640;
  const H = c.clientHeight || 170;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (state.assembly) {
    g.fillStyle = '#94a3b8';
    g.font = '13px sans-serif';
    g.fillText('装配体没有单一侧视轮廓 —— 请看三维视图与右侧文字图解', 16, 26);
    return;
  }
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
  }
}

/* ─────────────────────────────── 重建 ─────────────────────────────── */

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

/** 把形状规格落地：更新输入控件，并把生成的剖面写进文本框 */
function applySpec(spec, { silent = false } = {}) {
  state.assembly = null;          // 回到单件模式
  state.spec = normalizeSpec(spec);
  state.profileOverride = false;
  const pts = profileFromSpec(state.spec);
  $('profile').value = pts.map((q) => `${q.h.toFixed(1)}, ${q.r.toFixed(1)}`).join('\n');
  $('kind').value = state.spec.kind;
  $('dia').value = String(Math.round(state.spec.diameter));
  $('hei').value = String(Math.round(state.spec.height));
  if (!silent) setNotes(describeSpec(state.spec));
}

/**
 * 装配体模式：多部件 + 挂载。
 * 注意不要调 applySpec —— 那会把 assembly 清掉（它就是用来退出装配体的）。
 */
function applyAssembly(assembly) {
  state.assembly = assembly;
  state.profileOverride = false;
  const root = (assembly.parts || []).find((p) => !p.attach);
  if (root) {
    // 主体形状回填到控件，方便用户继续微调主体尺寸
    state.spec = normalizeSpec({
      kind: root.kind,
      diameter: root.diameter,
      height: root.height,
      widestAt: root.widestAt,
      bottomRatio: root.bottomRatio,
      topRatio: root.topRatio,
    });
    $('kind').value = state.spec.kind;
    $('dia').value = String(Math.round(state.spec.diameter));
    $('hei').value = String(Math.round(state.spec.height));
  }
}

/** 当前该用哪份剖面：手改过就用文本框，否则由规格生成 */
function currentProfilePoints() {
  if (state.profileOverride) return parseProfile($('profile').value);
  return profileFromSpec(state.spec);
}

function setNotes(text) {
  $('promptNotes').textContent = text;
}

const EXAMPLES = [
  '直径6cm高7cm的水滴形，下面胖一点',
  '头围30cm的圆头',
  '细长的手臂，长10cm，粗2cm',
  '直径8cm高12cm的直筒',
  '高8cm的蛋形，胖一点',
  '直径5厘米的小球',
];
let exampleIndex = 0;

function fillExample() {
  $('promptInput').value = EXAMPLES[exampleIndex % EXAMPLES.length];
  exampleIndex++;
  $('promptInput').focus();
}

/** 本地规则解析：不依赖 AI，随时可用，也是 AI 通道不通时的兜底 */
function ruleParse(text) {
  const { spec, notes } = parsePrompt(text, state.spec);
  applySpec(spec, { silent: true });
  setNotes(`规则解析：${notes.join('　·　')}`);
  state.current = 1;
  rebuild();
}

/** 轮询等待 AI 的答复 */
async function pollAnswer(id, { timeoutMs = 180000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let waited = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    waited += intervalMs;
    try {
      const res = await fetch(`/api/prompt?id=${encodeURIComponent(id)}`);
      if (res.ok) {
        const entry = await res.json();
        if (entry.status === 'answered' && entry.spec) return entry;
      }
    } catch { /* 网络抖动，继续等 */ }
    if (waited % 6000 < intervalMs) {
      setNotes(`已把提示词交给 DSH 会话里的 AI（已等 ${Math.round(waited / 1000)}s）。`
        + '一直不回就去对话里发一句催一下；或点「规则解析」立刻用本地规则生成。');
    }
  }
  return null;
}

/**
 * 提示词 → 形状规格。
 *
 * 走 AI 通道：提示词进本地队列（tools/ai-queue.json），
 * 由 DSH 会话里的 AI 生成规格，页面轮询取回。
 * 通道不可用或超时就退回本地规则解析 —— 规则法只认 5 个形状词，
 * 遇到「手臂」「底盘」这类名词会瞎猜，所以优先用 AI。
 */
async function generateFromPrompt() {
  const text = $('promptInput').value.trim();
  if (!text) {
    setNotes('请先写一句提示词，或直接改下面的形状与尺寸。');
    return;
  }

  const btn = $('genPrompt');
  btn.disabled = true;
  btn.textContent = '等待 AI…';
  setNotes('已把提示词交给 DSH 会话里的 AI，等待生成规格…');

  try {
    const res = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text, base: state.spec }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { id } = await res.json();

    const answer = await pollAnswer(id);
    if (answer) {
      // AI 可以回两种东西：单件规格（spec）或多部件装配（assembly）
      if (answer.assembly) {
        applyAssembly(answer.assembly);
      } else if (answer.spec) {
        applySpec(answer.spec, { silent: true });
      } else {
        setNotes('AI 回了结果，但既没有 spec 也没有 assembly。');
        return;
      }
      setNotes(`${answer.answeredBy || 'AI'}：${(answer.notes || []).join('　·　') || '（无说明）'}`);
      state.current = 1;
      rebuild();
    } else {
      setNotes('AI 等待超时，已改用本地规则解析（名词类提示词可能不准）。');
      ruleParse(text);
    }
  } catch (err) {
    setNotes(`AI 通道不可用（${err.message}），已改用本地规则解析。`);
    ruleParse(text);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成预览';
  }
}

function resize() {
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 460;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function rebuild() {
  state.gauge = { w: +$('w').value, h: +$('h').value };
  $('wv').textContent = state.gauge.w.toFixed(1);
  $('hv').textContent = state.gauge.h.toFixed(1);

  let graph = null;
  let pattern = null;
  let counts = null;
  let plan = null;
  let modeText = '';

  if (state.assembly) {
    // ── 装配体：多部件 + 挂载（章鱼、带腿带耳朵的玩偶走这条）──
    let built;
    try {
      built = buildAssembly(state.assembly, state.gauge);
    } catch (e) {
      $('pattern').textContent = '装配体有误：' + e.message;
      $('issues').className = 'warnbox';
      $('issues').textContent = e.message;
      return;
    }
    graph = built.graph;
    pattern = assemblyToPattern(state.assembly, state.gauge).pattern;
    counts = built.root.counts;
    state.part = built.root.part;
    const copies = built.attachments.reduce((a, x) => a + x.count, 0);
    modeText = `装配体：${built.built.length} 种部件 / ${copies} 个挂件`;
    $('profile').value = built.built
      .map((p) => `${p.id}${p.attach ? ` ×${p.attach.count}` : '（主体）'}：`
        + `${p.counts.length} 圈，峰值 ${Math.max(...p.counts)} 针`)
      .join('\n');
  } else {
    // ── 单件：一个回转体 ──
    let r;
    try {
      r = buildPartFromProfile(currentProfilePoints(), state.gauge, { id: 'head' });
    } catch (e) {
      $('pattern').textContent = '剖面解析失败：' + e.message;
      return;
    }
    state.part = r.part;
    state.plan = r.plan;
    plan = r.plan;
    counts = r.part.rounds.map(roundTops);
    pattern = createPattern({ name: '预览部件', gauge: state.gauge });
    pattern.parts.push(r.part);
    graph = graphFromPart(r.part, state.gauge);
    modeText = '单件';
  }

  // 圈滑杆按图里实际出现的最大圈号来
  const rounds = Math.max(1, ...graph.nodes.map((n) => n.round || 1));
  state.rounds = rounds;
  if (state.current > rounds) state.current = rounds;
  if (state.current < 1) state.current = 1;
  $('round').max = String(rounds);
  $('round').value = String(state.current);
  $('rv').textContent = String(state.current);

  const res = validatePattern(pattern);

  const out = [toText(pattern), '', '─'.repeat(36)];
  out.push(res.issues.length ? report(res) : '✅ 校验通过：结构合法，可以照着钩。');
  if (plan) {
    out.push(`整数化偏差：最大 ${(plan.deviation.maxRel * 100).toFixed(1)}%（${plan.deviation.maxAbs.toFixed(2)} mm）`);
    if (plan.clamps.length) {
      out.push('被耦合约束修正的圈：');
      for (const c of plan.clamps) out.push(`  第 ${c.round} 圈 ${c.want} → ${c.got}（${c.reason}）`);
    }
  }
  if (state.assembly) {
    out.push('', '装配说明：', describeAssembly(state.assembly));
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
  $('stats').textContent =
    `${modeText} · 共 ${rounds} 圈 · 峰值 ${peak} 针 · `
    + `图规模 ${graph.nodes.length} 针目 / ${graph.links.length} 耦合`
    + `　（每个小球 = 一针，连线 = 耦合关系）
渲染：${glInfo} · 求解在 ${worker ? 'Worker' : '主线程（兜底）'}`;

  resize();
  // 先启动三维求解，再画 2D 侧视：2D 只是辅助视图，
  // 万一它出错也不该把三维拖下水（之前就是顺序反了，导致三维一直不出）
  startLayout(graph);
  try {
    draw2D();
  } catch (err) {
    console.warn('侧视图绘制失败（不影响三维）:', err);
  }
}

/* ─────────────────────────────── 事件 ─────────────────────────────── */

$('genPrompt').addEventListener('click', generateFromPrompt);
$('promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generateFromPrompt();
});
$('sampleBtn').addEventListener('click', fillExample);
$('ruleBtn').addEventListener('click', () => {
  const text = $('promptInput').value.trim();
  if (text) ruleParse(text);
  else setNotes('先写一句提示词。');
});

// 形状控件改动 → 重算剖面（并把手改标记清掉）
$('kind').addEventListener('change', () => {
  applySpec({ ...state.spec, kind: $('kind').value });
  state.current = 1;
  rebuild();
});
$('dia').addEventListener('change', () => {
  applySpec({ ...state.spec, diameter: +$('dia').value });
  state.current = 1;
  rebuild();
});
$('hei').addEventListener('change', () => {
  applySpec({ ...state.spec, height: +$('hei').value });
  state.current = 1;
  rebuild();
});
$('w').addEventListener('input', rebuild);
$('h').addEventListener('input', rebuild);
$('apply').addEventListener('click', () => {
  state.profileOverride = true;     // 手改剖面优先
  state.current = 1;
  rebuild();
});
$('reset').addEventListener('click', () => {
  applySpec(state.spec);
  state.current = 1;
  rebuild();
});
$('round').addEventListener('input', (e) => {
  state.current = +e.target.value;
  $('rv').textContent = String(state.current);
  paintNodes();
  draw2D();
});
$('nodes').addEventListener('change', (e) => {
  state.showNodes = e.target.checked;
  nodeMesh.visible = state.showNodes;
});
$('links').addEventListener('change', (e) => {
  state.showLinks = e.target.checked;
  linkMesh.visible = state.showLinks;
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => { resize(); draw2D(); }).observe(canvas);
}

applySpec(state.spec, { silent: true });
setNotes('写一句提示词点「生成预览」，也可以直接改下面的形状与尺寸。');
resize();
rebuild();
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();
