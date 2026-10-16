/**
 * three.js 用法与"可见性"检查（Node 里跑，不需要浏览器）。
 *
 * 这不是渲染测试——Node 里没有 WebGL。它检查三件真正会让人看到白屏或空画面的事：
 *   ① 页面里那套 three.js 调用能不能跑通（API 用法、参数类型）
 *   ② 几何真的生成了（包围盒非空）
 *   ③ 相机取景后，模型**完整落在画面内**且占比够大（太小 / 被裁掉 = 看起来不对）
 *
 * three.js 从 web/vendor 本地导入，与页面用的是同一份文件。
 *
 *   node test/three-check.mjs
 */
import * as THREE from '../web/vendor/three.module.js';
import { roundTops } from '../src/ir.js';
import { buildPartFromProfile, PRESETS, normalizeProfile } from '../src/build.js';
import { bodyBands, stitchGridSegments, rulerSegments, fitView } from '../src/solid.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) pass++;
  else { fail++; failures.push(label); }
}

/* ── 复刻 web/app.js 的构建流程 ───────────────────────────────────── */
const gauge = { w: 5, h: 5 };
const { part } = buildPartFromProfile(normalizeProfile(PRESETS.ball(25)), gauge, { id: 'head' });
const counts = part.rounds.map(roundTops);

const scene = new THREE.Scene();
const group = new THREE.Group();
scene.add(group);

// ① 曲面分段
let bands = 0;
for (const band of bodyBands(counts, gauge)) {
  const geo = new THREE.LatheGeometry(
    [
      new THREE.Vector2(Math.max(band.r0, 0.05), band.y0),
      new THREE.Vector2(Math.max(band.r1, 0.05), band.y1),
    ],
    96,
  );
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  mesh.userData.round = band.round;
  group.add(mesh);
  bands++;
}
ok(bands === counts.length, `曲面分段数 == 圈数（${bands}）`);

// ② 针目网格
const grid = stitchGridSegments(part, gauge);
const gGeo = new THREE.BufferGeometry();
gGeo.setAttribute('position', new THREE.Float32BufferAttribute(grid.positions, 3));
group.add(new THREE.LineSegments(gGeo, new THREE.LineBasicMaterial()));
ok(gGeo.getAttribute('position').count === grid.positions.length / 3, '网格顶点数与几何数据一致');

// ③ 标尺
const ruler = rulerSegments(counts, gauge);
const rGeo = new THREE.BufferGeometry();
rGeo.setAttribute('position', new THREE.Float32BufferAttribute(ruler.positions, 3));
group.add(new THREE.LineSegments(rGeo, new THREE.LineBasicMaterial()));
ok(rGeo.getAttribute('position').count > 0, '标尺几何非空');

// ④ 相机取景（与 app.js 用同一个 fitView）
const W = 900;
const Hpx = 460;
const camera = new THREE.PerspectiveCamera(36, W / Hpx, 0.5, 20000);

scene.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(group);
ok(!box.isEmpty(), '模型包围盒非空（几何真的生成了）');

const v = fitView(
  { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } },
  { fov: camera.fov, aspect: camera.aspect },
);
camera.position.set(v.position.x, v.position.y, v.position.z);
camera.near = v.near;
camera.far = v.far;
camera.lookAt(v.target.x, v.target.y, v.target.z);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const frustum = new THREE.Frustum().setFromProjectionMatrix(
  new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
);
ok(frustum.intersectsBox(box), '模型落在相机视锥内');

// ⑤ 屏幕占比：包围盒 8 角投影到 NDC
const corners = [];
for (const x of [box.min.x, box.max.x]) {
  for (const y of [box.min.y, box.max.y]) {
    for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  }
}
let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
let inside = 0;
for (const c of corners) {
  const p = c.clone().project(camera);
  if (p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1 && p.z >= -1 && p.z <= 1) inside++;
  minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
  minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
}
ok(inside === 8, `包围盒 8 个角点全在视口内（实际 ${inside}/8）`);
ok(maxX <= 1.02 && minX >= -1.02 && maxY <= 1.02 && minY >= -1.02,
  `模型没有被裁掉（NDC x[${minX.toFixed(2)}, ${maxX.toFixed(2)}] y[${minY.toFixed(2)}, ${maxY.toFixed(2)}]）`);

const spanX = Math.min(1, maxX) - Math.max(-1, minX);
const spanY = Math.min(1, maxY) - Math.max(-1, minY);
// NDC 的 -1..1 是整屏（2 个单位），所以换算成"占屏幕百分比"要除以 2
const pctX = (spanX / 2) * 100;
const pctY = (spanY / 2) * 100;
ok(pctX > 15, `横向占屏 ${pctX.toFixed(0)}%（够大才看得清）`);
ok(pctY > 15, `纵向占屏 ${pctY.toFixed(0)}%（够大才看得清）`);
ok(pctX < 92 && pctY < 92, `也不过满（${pctX.toFixed(0)}% × ${pctY.toFixed(0)}%），四周留有余量`);

// ⑥ 逐圈高亮材质能正常替换
const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
let idx = 0;
for (const child of group.children) {
  if (child.isMesh) child.material = mats[idx++ % 3];
}
ok(idx === bands, '每一段都被赋到了材质（逐圈高亮可切换）');

/* ── 结果 ─────────────────────────────────────────────────────── */
console.log('\n—— three.js 检查 ——');
console.log(`模型包围盒：x[${box.min.x.toFixed(1)}, ${box.max.x.toFixed(1)}] `
  + `y[${box.min.y.toFixed(1)}, ${box.max.y.toFixed(1)}] `
  + `z[${box.min.z.toFixed(1)}, ${box.max.z.toFixed(1)}]`);
console.log(`相机：位置(${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}) `
  + `距中心 ${v.distance.toFixed(1)}  包围半径 ${v.radius.toFixed(1)}  near=${camera.near.toFixed(2)} far=${camera.far.toFixed(0)}`);
console.log(`屏幕占比：横 ${pctX.toFixed(0)}%  纵 ${pctY.toFixed(0)}%`);
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✅ three.js 用法与可见性检查全部通过\n');
