/**
 * 力导向求解器：把拓扑图摊成一个三维形状。
 *
 * 三个力（语义与 d3-force 对齐，那是参考站点用的库）：
 *   link   弹簧：相连的针目保持约一个针宽的距离
 *   charge 互斥：不相连的针目互相排斥 —— **这才是把织物撑开的力**
 *   center 向心：只平移整体质心，不改变相对形状
 *
 * 退火：alpha 每步乘 (1 - alphaDecay)，速度每步乘 (1 - velocityDecay)。
 * 这带来天然的阻尼缓动 —— 运动不会突跳，这正是参考实现"丝滑"的来源。
 *
 * 确定性：初始位置来自图里的 seed，只有按索引决定的**极小抖动**用于打破对称。
 * 所以同样的图 + 同样的参数 = 同样的结果，可以写进测试断言。
 */

const JITTER = 0.01;

export const FORCE_DEFAULTS = {
  linkDistance: 5,      // 弹簧静止长度（≈ 针宽 mm）
  linkStrength: 0.9,
  chargeStrength: -6,   // 负 = 排斥（只用来防止针目重叠，别把织物吹胀）
  chargeCutoff: 7,      // 超过这个距离不算，省算力
  guideStrength: 0.06,  // 向解析目标收敛的强度（节点没有 target 时自动跳过）
  gravityStrength: 0,   // 自重：垂挂件（触手、腿）靠它往下垂；板块类部件保持 0
  centerStrength: 0.05,
  velocityDecay: 0.4,
  alphaDecay: 0.028,
  alphaMin: 0.001,
};

export function createSimulation(graph, options = {}) {
  const o = { ...FORCE_DEFAULTS, ...options };
  // 形状记忆：把种子位置换算成"相对种子质心"的偏移。
  // 种子本身就是解析解（圈半径 = 针数×针宽/2π；触手向下垂），
  // 所以这条力 = 让织物记住本该有的形状；物理只在局部做松弛。
  let sx = 0, sy = 0, sz = 0;
  for (const n of graph.nodes) { sx += n.seed?.x ?? 0; sy += n.seed?.y ?? 0; sz += n.seed?.z ?? 0; }
  const N = Math.max(1, graph.nodes.length);
  const seedC = { x: sx / N, y: sy / N, z: sz / N };

  const nodes = graph.nodes.map((n, i) => ({
    id: n.id,
    round: n.round,
    index: n.index,
    chain: !!n.chain,
    x: (n.seed?.x ?? 0) + Math.sin(i * 12.9898) * JITTER,
    y: (n.seed?.y ?? 0) + Math.sin(i * 78.233) * JITTER,
    z: (n.seed?.z ?? 0) + Math.sin(i * 37.719) * JITTER,
    vx: 0, vy: 0, vz: 0,
    fx: null, fy: null, fz: null,
    target: n.target || null,
    rel: {
      x: (n.seed?.x ?? 0) - seedC.x,
      y: (n.seed?.y ?? 0) - seedC.y,
      z: (n.seed?.z ?? 0) - seedC.z,
    },
  }));
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const links = graph.links
    .map((l) => ({ s: at.get(l.source), t: at.get(l.target), kind: l.kind }))
    .filter((l) => l.s !== undefined && l.t !== undefined);

  let alpha = 1;
  let ticks = 0;

  function tick() {
    if (alpha <= 0) return false;
    const a = alpha;

    // ① 弹簧：相连的针目保持针宽距离
    for (const l of links) {
      const s = nodes[l.s];
      const t = nodes[l.t];
      let dx = t.x - s.x;
      let dy = t.y - s.y;
      let dz = t.z - s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const f = ((d - o.linkDistance) / d) * o.linkStrength * a * 0.5;
      dx *= f; dy *= f; dz *= f;
      t.vx -= dx; t.vy -= dy; t.vz -= dz;
      s.vx += dx; s.vy += dy; s.vz += dz;
    }

    // ② 互斥：把织物撑开（O(n²)，n 几百以内够用；再大要上四叉树/八叉树）
    const cut2 = o.chargeCutoff * o.chargeCutoff;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const q = nodes[j];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const dz = q.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cut2 || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const f = (o.chargeStrength * a) / d2;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        const uz = (dz / d) * f;
        p.vx += ux; p.vy += uy; p.vz += uz;
        q.vx -= ux; q.vy -= uy; q.vz -= uz;
      }
    }

    // ③ 形状记忆：把节点拉回"相对质心的种子位置"。
    //    解析式负责整体形状，物理负责局部松弛 —— 两边各干各擅长的事。
    if (o.guideStrength > 0) {
      let mx = 0, my = 0, mz = 0;
      for (const n of nodes) { mx += n.x; my += n.y; mz += n.z; }
      mx /= nodes.length; my /= nodes.length; mz /= nodes.length;
      const g = o.guideStrength * a;
      for (const n of nodes) {
        n.vx += (mx + n.rel.x - n.x) * g;
        n.vy += (my + n.rel.y - n.y) * g;
        n.vz += (mz + n.rel.z - n.z) * g;
      }
    }

    // ④ 自重：让垂挂件往下垂（配合向心只平移质心，整体不会掉下去，只是被拉长）
    if (o.gravityStrength > 0) {
      const g = o.gravityStrength * a;
      for (const n of nodes) {
        if (n.fy === null) n.vy -= g;
      }
    }

    // ⑤ 向心：只平移质心（若改成逐点拉向原点，形状会被压扁）
    let cx = 0, cy = 0, cz = 0;
    for (const n of nodes) { cx += n.x; cy += n.y; cz += n.z; }
    cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
    const k = o.centerStrength * a;
    for (const n of nodes) {
      n.x -= cx * k; n.y -= cy * k; n.z -= cz * k;
    }

    // ⑥ 积分 + 阻尼；被钉住的节点（fx/fy/fz）不参与运动
    const damp = 1 - o.velocityDecay;
    for (const n of nodes) {
      if (n.fx !== null) { n.x = n.fx; n.vx = 0; } else { n.vx *= damp; n.x += n.vx; }
      if (n.fy !== null) { n.y = n.fy; n.vy = 0; } else { n.vy *= damp; n.y += n.vy; }
      if (n.fz !== null) { n.z = n.fz; n.vz = 0; } else { n.vz *= damp; n.z += n.vz; }
    }

    alpha += (0 - alpha) * o.alphaDecay;
    if (alpha < o.alphaMin) alpha = 0;
    ticks++;
    return true;
  }

  return {
    nodes,
    links,
    params: o,
    get alpha() { return alpha; },
    get ticks() { return ticks; },
    /** 重新加热：改动图解或拖动针目后调用，让整张网重新找平衡 */
    reheat(value = 1) { alpha = value; return alpha; },
    /** 钉住一个节点（拖动），传 null 释放 */
    pin(id, pos) {
      const n = nodes.find((x) => x.id === id);
      if (!n) return false;
      if (!pos) { n.fx = n.fy = n.fz = null; return true; }
      n.fx = pos.x; n.fy = pos.y; n.fz = pos.z;
      return true;
    },
    tick,
    /** 一直跑到收敛（离线用）；返回实际步数 */
    run(maxTicks = 600) {
      let i = 0;
      while (i < maxTicks && tick()) i++;
      return i;
    },
    /** 位置快照，便于渲染/测试 */
    positions() {
      return nodes.map((n) => ({ id: n.id, round: n.round, chain: n.chain, x: n.x, y: n.y, z: n.z }));
    },
    /** 尺度摘要：质心、包围半径、每圈平均半径（用来判断形状是否符合预期） */
    summary() {
      let cx = 0, cy = 0, cz = 0;
      for (const n of nodes) { cx += n.x; cy += n.y; cz += n.z; }
      cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
      let maxR = 0;
      for (const n of nodes) {
        maxR = Math.max(maxR, Math.hypot(n.x - cx, n.y - cy, n.z - cz));
      }
      return { center: { x: cx, y: cy, z: cz }, radius: maxR, nodes: nodes.length, links: links.length };
    },
  };
}

/**
 * 离线采样成一串帧（给"生长动画"用）。
 * 参考站点也是这个套路：跑约 1 秒，期间每帧把坐标推给渲染器。
 */
export function sampleFrames(graph, { steps = 120, every = 4, ...options } = {}) {
  const sim = createSimulation(graph, options);
  const frames = [];
  for (let i = 0; i < steps; i++) {
    sim.tick();
    if (i % every === 0) frames.push(sim.positions());
  }
  return { frames, summary: sim.summary(), ticks: sim.ticks };
}
