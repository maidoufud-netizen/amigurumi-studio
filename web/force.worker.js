/**
 * 力导向求解 Worker。
 *
 * 为什么必须放 Worker 里：一次收敛要跑 200~400 步，每步都是 O(n²) 的互斥计算。
 * 放在主线程就会把渲染和交互卡住；放在这里，主线程只管收坐标、更新缓冲。
 *
 * 协议：
 *   收 { type:'init', part, gauge, options, stepsPerFrame }
 *      → 回 { type:'ready', nodes:[{id,round,chain}], links:[a,b,...] }
 *      → 每帧回 { type:'tick', positions:Float32Array }
 *      → 收敛后回 { type:'end', ticks }
 *   收 { type:'pin', index, pos }   拖动时钉住一个针目（null 释放）
 *   收 { type:'stop' }
 */
import { createPart } from '../src/ir.js';
import { graphFromPart } from '../src/graph.js';
import { createSimulation } from '../src/force.js';

let sim = null;
let links = null;
let timer = null;

function stop() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    stop();
    const part = createPart({ id: msg.part.id || 'part', rounds: msg.part.rounds });
    const graph = graphFromPart(part, msg.gauge);

    sim = createSimulation(graph, {
      linkDistance: msg.gauge.w,
      ...(msg.options || {}),
    });

    // 图结构只发一次：几何在渲染端建一次，之后每个 tick 只更新坐标
    const index = new Map(sim.nodes.map((n, i) => [n.id, i]));
    links = [];
    for (const l of sim.links) links.push(l.s, l.t);

    self.postMessage({
      type: 'ready',
      nodes: sim.nodes.map((n) => ({ id: n.id, round: n.round, chain: !!n.chain })),
      links,
      total: sim.nodes.length,
    });

    const perFrame = Math.max(1, msg.stepsPerFrame || 3);
    const pump = () => {
      for (let i = 0; i < perFrame && sim.alpha > 0; i++) sim.tick();
      const flat = new Float32Array(sim.nodes.length * 3);
      sim.nodes.forEach((n, i) => {
        flat[i * 3] = n.x;
        flat[i * 3 + 1] = n.y;
        flat[i * 3 + 2] = n.z;
      });
      self.postMessage({ type: 'tick', positions: flat, alpha: sim.alpha });
      if (sim.alpha > 0) {
        timer = setTimeout(pump, 16);
      } else {
        timer = null;
        self.postMessage({ type: 'end', ticks: sim.ticks });
      }
    };
    pump();
    return;
  }

  if (msg.type === 'pin') {
    if (sim) sim.pin(msg.id, msg.pos || null);
    return;
  }

  if (msg.type === 'stop') {
    stop();
    sim = null;
    links = null;
  }
};
