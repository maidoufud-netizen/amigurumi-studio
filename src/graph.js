/**
 * 针目拓扑图：节点 = 针目，边 = 耦合关系。
 *
 * 这是"任意拓扑"的基础：回转体只是它的一种特例。
 * 有了图，章鱼腿、片织、分件缝合都变成同一个问题——
 * 而力导向求解器不需要知道"这是球还是章鱼"，它只认节点和边。
 *
 * 图里每个节点带一个 seed（初始坐标）：不是随便撒点，而是**按图解结构给出的合理起点**。
 * 好起点能让模拟几十毫秒内收敛，而不是从一团乱麻慢慢解开。
 */
import { OP, roundTops } from './ir.js';
import { expandOps } from './pattern.js';
import { roundsFromCounts } from './build.js';

function ringLinks(list, links, kind = 'ring') {
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const b = list[(i + 1) % list.length];
    if (a !== b) links.push({ source: a.id, target: b.id, kind });
  }
}

/**
 * IR 部件 → 拓扑图。
 * 第 1 圈没有上一圈可依附，按环铺设；之后每圈按"消耗了上一圈哪些针目"连边。
 */
export function graphFromPart(part, gauge = { w: 5, h: 5 }, options = {}) {
  const nodes = [];
  const links = [];
  const { w = 5, h = 5 } = gauge;
  // seedDir = -1：圈号越大越低。装配体用这个朝向，让"最后一圈"落在底部，
  // 挂件（腿 / 触手）才能自然往下长——这个坑在章鱼那轮踩过。
  const dir = options.seedDir === -1 ? -1 : 1;
  const partId = options.partId ?? part.id ?? 'part';

  const seedRing = (list, round) => {
    const r = Math.max(0.4, (list.length * w) / (2 * Math.PI));
    const y = dir * (round - 0.5) * h;
    list.forEach((n, i) => {
      const a = (2 * Math.PI * i) / list.length;
      n.seed = { x: r * Math.cos(a), y, z: r * Math.sin(a) };
      // 解析式目标：圈半径 = 针数 × 针宽 / 2π。
      // 这不是"作弊"，而是把已知的纤维约束交给物理：
      // 板块类部件有闭式解，就用它引导收敛；触手那种没有解的，target 为空，让物理自由发挥。
      n.target = { r, y };
    });
  };

  const mk = (round, index) => {
    const n = { id: `r${round}s${index}`, round, index, partId };
    nodes.push(n);
    return n;
  };

  const seq1 = expandOps(part.rounds[0].ops);
  let prev = [];
  for (const op of seq1) {
    for (let k = 0; k < OP[op].tops; k++) prev.push(mk(1, prev.length));
  }
  seedRing(prev, 1);
  ringLinks(prev, links);

  for (let i = 1; i < part.rounds.length; i++) {
    const seq = expandOps(part.rounds[i].ops);
    const cur = [];
    let cursor = 0;
    for (const op of seq) {
      const spec = OP[op];
      if (cursor + spec.bases > prev.length) {
        throw new Error(`第 ${i + 1} 圈的耦合超出上一圈（图解不可钩），无法建图`);
      }
      const bases = prev.slice(cursor, cursor + spec.bases);
      cursor += spec.bases;

      if (spec.tops === 1) {
        const n = mk(i + 1, cur.length);
        for (const b of bases) links.push({ source: n.id, target: b.id, kind: 'couple' });
        cur.push(n);
      } else {
        // 一针出两针：两个新针目都挂在同一个基针上
        for (let k = 0; k < spec.tops; k++) {
          const n = mk(i + 1, cur.length);
          links.push({ source: n.id, target: bases[0].id, kind: 'couple' });
          cur.push(n);
        }
      }
    }
    if (cursor !== prev.length) {
      throw new Error(`第 ${i + 1} 圈只吃掉 ${cursor}/${prev.length} 个基针（漏针），无法建图`);
    }
    seedRing(cur, i + 1);
    ringLinks(cur, links);
    prev = cur;
  }

  return { name: part.id, nodes, links, gauge };
}

/**
 * 在某个针目上接一条链（触手、腿、耳朵…）。
 * 这就是回转体做不到的事：从图的任意节点长出新分支。
 */
export function attachChain(graph,
  { fromId, counts, spread = 1.2, partId = null, copyIndex = 0, seedAngle = null, seedSpread = 0 },
  gauge = graph.gauge) {
  const { w = 5, h = 5 } = gauge;
  const anchor = graph.nodes.find((n) => n.id === fromId);
  if (!anchor) throw new Error(`找不到锚点 ${fromId}`);

  // 种子的横向方向：优先用给定的方位角，让多条挂件像章鱼腿那样各朝一个方向外张。
  // 只按"锚点半径 × spread"的话，挂在收口圈上的挂件会全部叠在一起（踩过这个坑）。
  const dirX = seedAngle === null ? null : Math.cos(seedAngle);
  const dirZ = seedAngle === null ? null : Math.sin(seedAngle);

  const added = [];
  let prevRing = [anchor];
  counts.forEach((count, step) => {
    const r = Math.max(0.4, (count * w) / (2 * Math.PI));
    const ring = [];
    for (let j = 0; j < count; j++) {
      const a = (2 * Math.PI * j) / count;
      const outward = r + step * seedSpread;      // 越往下越向外
      const node = {
        id: `${fromId}-c${step}-${j}`,
        round: (anchor.round ?? 0) + step + 1,
        index: j,
        chain: true,
        partId: partId || `${anchor.partId || 'root'}-chain`,
        copyIndex,
        seed: dirX !== null
          ? {
            x: anchor.seed.x + dirX * outward + r * Math.cos(a) * 0.3,
            y: anchor.seed.y - (step + 1) * h,
            z: anchor.seed.z + dirZ * outward + r * Math.sin(a) * 0.3,
          }
          : {
            x: anchor.seed.x * spread + r * Math.cos(a),
            y: anchor.seed.y - (step + 1) * h,
            z: anchor.seed.z * spread + r * Math.sin(a),
          },
      };
      graph.nodes.push(node);
      ring.push(node);
    }
    ringLinks(ring, graph.links);
    // 与上一段连边：平均分配（够用即可，物理会自己找位置）
    ring.forEach((n, j) => {
      const b = prevRing[Math.floor((j * prevRing.length) / ring.length)];
      graph.links.push({ source: n.id, target: b.id, kind: 'chain' });
    });
    prevRing = ring;
    added.push(...ring);
  });

  return added;
}

/**
 * 章鱼：一个球形头 + 8 条触手。
 * 这正是解析式（回转体）**根本做不出来**的形状，用来验证力导向这条路的必要性。
 */
export function octopusGraph(gauge = { w: 5, h: 5 }) {
  // 用已验证的 roundsFromCounts 生成圈，而不是手写 ops —— 手写极易把耦合写错。
  //
  // 圈序是**倒着**的：8 针起针在底部，6 针魔术环收在顶部。
  // 因为种子坐标约定是"圈号越大越高"，而触手必须从底部往下垂 ——
  // 按正序（6 针在底）的话，8 条腿就只能从顶部往下穿过身体，那是错的。
  const bodyCounts = [8, 16, 24, 24, 24, 18, 12, 6];
  const body = { id: 'octopus', rounds: roundsFromCounts(bodyCounts) };

  const graph = graphFromPart(body, gauge);

  // 8 条触手，从最底那一圈的 8 个针目各接一条，向下垂
  const bottom = graph.nodes.filter((n) => n.round === 1).sort((a, b) => a.index - b.index);
  const legCounts = [4, 4, 3, 3, 2, 2, 1, 1];
  bottom.forEach((node) => {
    attachChain(graph, { fromId: node.id, counts: legCounts, spread: 2.2 }, gauge);
  });

  graph.name = '章鱼（球头 + 8 条触手）';
  return graph;
}

/** 图的规模摘要 */
export function graphStats(graph) {
  const rounds = [...new Set(graph.nodes.map((n) => n.round))];
  return {
    nodes: graph.nodes.length,
    links: graph.links.length,
    rounds: rounds.length,
    chains: graph.nodes.filter((n) => n.chain).length,
    kinds: [...new Set(graph.links.map((l) => l.kind))],
  };
}
