/**
 * 多部件装配：把「头 + 8 条腿 + 2 只耳朵」这种结构表达出来。
 *
 * 为什么需要它：单个 spec 只能描述**一个回转体**，所以"章鱼"永远只能变成球。
 * 装配把规格从"一个形状"扩成"一棵挂载树"：
 *
 *   { "name": "章鱼", "parts": [
 *       { "id": "head", "kind": "ball", "diameter": 46, "height": 50 },
 *       { "id": "leg",  "kind": "cone", "diameter": 13, "height": 42,
 *         "attach": { "to": "head", "round": "last", "count": 8 } } ] }
 *
 * 每个带 attach 的部件会**重复 count 次**，各自挂在宿主某一圈的针目上，
 * 然后交给已经能处理任意拓扑的力导向管线去布局。
 *
 * 朝向约定：装配体里**圈号越大越低**（从头顶往下钩），
 * 于是"最后一圈"在底部，挂件自然往下长——这个坑我们在章鱼那轮踩过一次。
 */
import { createPart, roundTops } from './ir.js';
import { buildPartFromProfile, roundsFromCounts } from './build.js';
import { normalizeSpec, profileFromSpec, describeSpec } from './shape.js';
import { graphFromPart, attachChain } from './graph.js';

const ROUND_KEYWORDS = new Set(['last', 'first']);
const MAX_COPIES = 64;

/** 校验并规范化装配规格；错误信息要能直接告诉人哪里写错了 */
export function normalizeAssembly(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || !Array.isArray(raw.parts) || raw.parts.length === 0) {
    throw new Error('装配体必须包含至少一个 parts 项');
  }
  if (raw.parts.length > 24) {
    throw new Error(`部件种类最多 24 个，现在 ${raw.parts.length} 个`);
  }

  const seen = new Set();
  const parts = raw.parts.map((p, i) => {
    const id = String(p.id || `part${i + 1}`);
    if (seen.has(id)) throw new Error(`部件 id 重复：「${id}」`);

    let attach = null;
    if (p.attach) {
      const to = String(p.attach.to || '');
      if (!to) throw new Error(`部件「${id}」的 attach 缺少 to`);
      if (!seen.has(to)) {
        throw new Error(`部件「${id}」要挂在「${to}」上，但「${to}」不是它之前定义过的部件`);
      }
      const round = p.attach.round ?? 'last';
      if (typeof round === 'string' && !ROUND_KEYWORDS.has(round)) {
        throw new Error(`部件「${id}」的 attach.round 只支持 "last" / "first" / 正整数，收到「${round}」`);
      }
      if (typeof round === 'number' && (!Number.isInteger(round) || round < 1)) {
        throw new Error(`部件「${id}」的 attach.round 是圈号，必须是 ≥1 的整数`);
      }
      const count = p.attach.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_COPIES) {
        throw new Error(`部件「${id}」的 attach.count 必须是 1~${MAX_COPIES} 的整数，收到「${count}」`);
      }
      attach = {
        to,
        round,
        count,
        spread: Number(p.attach.spread ?? 1.35),
        offset: Number(p.attach.offset ?? 0),
        divergence: Number(p.attach.divergence ?? 2.2),
      };
    }

    seen.add(id);
    // 幂等：规范化过的部件是 { id, spec:{kind,diameter,...}, attach }，
    // 尺寸在嵌套的 spec 里。只读顶层字段的话，二次规范化会把所有部件
    // 悄悄换成默认的球 Ø50（实测章鱼从 499 针变成 1809 针）。
    const src = p.spec && typeof p.spec === 'object' ? p.spec : p;
    const spec = normalizeSpec({
      kind: src.kind,
      diameter: src.diameter,
      height: src.height,
      widestAt: src.widestAt,
      bottomRatio: src.bottomRatio,
      topRatio: src.topRatio,
      bulge: src.bulge,
    });

    const counts = Array.isArray(p.counts) && p.counts.length
      ? p.counts.map((c) => Math.round(Number(c)))
      : null;

    return { id, spec, counts, attach };
  });

  const roots = parts.filter((p) => !p.attach);
  if (roots.length !== 1) {
    throw new Error(
      `装配体必须有且只有一个主体（不带 attach 的部件），现在有 ${roots.length} 个：`
      + roots.map((r) => r.id).join('、'),
    );
  }

  return { name: String(raw.name || '装配体'), parts };
}

/** 每个部件先生成 IR（复用已验证的耦合逻辑），再据此建图 */
export function buildAssembly(input, gauge = { w: 5, h: 5 }) {
  const assembly = normalizeAssembly(input);

  const built = assembly.parts.map((p) => {
    if (p.counts) {
      const part = createPart({ id: p.id, rounds: roundsFromCounts(p.counts) });
      return { ...p, part, plan: null, counts: part.rounds.map(roundTops) };
    }
    const { part, plan } = buildPartFromProfile(profileFromSpec(p.spec), gauge, { id: p.id });
    return { ...p, part, plan, counts: part.rounds.map(roundTops) };
  });

  const root = built.find((p) => !p.attach);
  // 主体朝向：圈号越大越低，于是"最后一圈"在底部
  const graph = graphFromPart(root.part, gauge, { seedDir: -1 });
  graph.name = assembly.name;
  graph.gauge = gauge;

  const attachments = [];
  for (const p of built.filter((x) => x.attach)) {
    const host = built.find((x) => x.id === p.attach.to);
    const hostNodes = graph.nodes.filter((n) => n.partId === host.id);
    const hostRounds = [...new Set(hostNodes.map((n) => n.round))].sort((a, b) => a - b);
    const roundNo = p.attach.round === 'first' ? hostRounds[0]
      : p.attach.round === 'last' ? hostRounds[hostRounds.length - 1]
        : p.attach.round;

    if (!hostRounds.includes(roundNo)) {
      throw new Error(
        `部件「${p.id}」要挂在「${host.id}」第 ${roundNo} 圈，但「${host.id}」只有 `
        + `${hostRounds[0]}~${hostRounds[hostRounds.length - 1]} 圈`,
      );
    }

    const ring = hostNodes.filter((n) => n.round === roundNo).sort((a, b) => a.index - b.index);
    const warnings = [];
    if (p.attach.count > ring.length) {
      warnings.push(
        `要挂 ${p.attach.count} 条，但第 ${roundNo} 圈只有 ${ring.length} 针——`
        + `会有 ${p.attach.count - ring.length} 条共用锚点`,
      );
    }

    for (let i = 0; i < p.attach.count; i++) {
      const pick = ring[Math.floor((i * ring.length) / p.attach.count + p.attach.offset) % ring.length];
      // 每条挂件给一个自己的方位角，并随深度外张——否则挂在收口圈上的 8 条会叠成一坨
      const angle = (2 * Math.PI * (i + p.attach.offset)) / p.attach.count;
      attachChain(graph, {
        fromId: pick.id,
        counts: p.counts,
        spread: p.attach.spread,
        partId: p.id,
        copyIndex: i,
        seedAngle: angle,
        seedSpread: p.attach.divergence ?? 2.2,
      }, gauge);
    }

    attachments.push({
      partId: p.id,
      to: host.id,
      round: roundNo,
      roundLabel: p.attach.round,
      count: p.attach.count,
      anchors: p.attach.count,
      warnings,
    });
  }

  return { assembly, built, root, graph, attachments, gauge };
}

/** 文字图解用的 IR 图案：每个部件列一次，挂载关系写在备注里 */
export function assemblyToPattern(input, gauge = { w: 5, h: 5 }) {
  const { assembly, built, attachments } = buildAssembly(input, gauge);
  const pattern = {
    name: assembly.name,
    gauge,
    parts: built.map((p) => {
      const twin = attachments.find((a) => a.partId === p.id);
      if (!twin) return p.part;
      const how = twin.roundLabel === 'last' ? '最后一圈'
        : twin.roundLabel === 'first' ? '第一圈' : `第 ${twin.round} 圈`;
      const note = `× ${twin.count} 条：各自起针后，从「${twin.to}」的${how}均匀取针挂上去`;
      return createPart({
        id: p.id,
        startType: p.part.startType,
        rounds: p.part.rounds,
        note: p.part.note ? `${p.part.note}；${note}` : note,
      });
    }),
  };
  return { pattern, assembly, built, attachments };
}

/** 一句话说清这个装配体是什么 */
export function describeAssembly(input) {
  const { assembly, built, root, attachments, graph } = buildAssembly(input);
  const lines = [`${assembly.name}：主体「${root.id}」${describeSpec(root.spec)}`
    + `（${root.counts.length} 圈，峰值 ${Math.max(...root.counts)} 针）`];
  for (const a of attachments) {
    const p = built.find((x) => x.id === a.partId);
    const how = a.roundLabel === 'last' ? '最后一圈'
      : a.roundLabel === 'first' ? '第一圈' : `第 ${a.round} 圈`;
    lines.push(`　└─「${a.partId}」${describeSpec(p.spec)} × ${a.count}`
      + `，挂在「${a.to}」的${how}（第 ${a.round} 圈）`);
    for (const w of a.warnings) lines.push(`　　⚠️ ${w}`);
  }
  lines.push(`　合计 ${graph.nodes.length} 个针目 / ${graph.links.length} 条耦合`);
  return lines.join('\n');
}
