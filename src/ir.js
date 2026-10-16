/**
 * Pattern IR —— 整套系统唯一的真源（single source of truth）。
 *
 * 铁律：文字图解、符号图、3D 预览都必须从这份 IR 派生。
 * 任何"预览一套数据、图解另一套数据"的做法都会导致漂移。
 *
 * 针法约定（只支持短针体系，覆盖 amigurumi 绝大多数场景）：
 *   sc  (X) 短针：消耗 1 个上一圈针目，产生 1 个新针目
 *   inc (V) 加针：消耗 1 个，产生 2 个
 *   dec (A) 减针：消耗 2 个，产生 1 个
 *
 * 由此得到两条守恒式（validate.js 的判据）：
 *   消耗的基针 bases = sc + inc + 2*dec  必须 == 上一圈针数
 *   产生的针目 tops  = sc + 2*inc + dec  必须 == 本圈针数
 * 两式相减即：本圈 - 上圈 = inc - dec
 */

/** 针法 → 符号字符 */
export const OP = {
  sc: { symbol: 'X', label: '短针', tops: 1, bases: 1 },
  inc: { symbol: 'V', label: '加针', tops: 2, bases: 1 },
  dec: { symbol: 'A', label: '减针', tops: 1, bases: 2 },
};

/** 创建一个空图解 */
export function createPattern({ name = '未命名玩偶', gauge = { w: 5, h: 5 } } = {}) {
  if (!(gauge.w > 0) || !(gauge.h > 0)) throw new Error('gauge.w / gauge.h 必须为正数（单位 mm）');
  return { version: 1, name, gauge: { w: gauge.w, h: gauge.h }, parts: [] };
}

/** 添加一个部件（头/身/手/耳…），每件一条独立的针数曲线 */
export function createPart({ id, startType = 'magic-ring', rounds = [], note = '' } = {}) {
  if (!id) throw new Error('part 必须有 id');
  if (startType !== 'magic-ring' && startType !== 'chain-ring') {
    throw new Error(`未知起始方式：${startType}`);
  }
  return { id, startType, note, rounds: rounds.map((r, i) => normalizeRound(r, i + 1)) };
}

/** 规整一圈：保证 ops 是合法 run 列表，n 从 1 连续编号 */
export function normalizeRound(round, n) {
  const ops = (round.ops || []).map((o) => {
    if (!OP[o.op]) throw new Error(`未知针法：${o.op}`);
    if (!Number.isInteger(o.count) || o.count <= 0) throw new Error(`针数必须为正整数：${o.count}`);
    return { op: o.op, count: o.count };
  });
  if (ops.length === 0) throw new Error(`第 ${n} 圈没有任何针法`);
  return { n: n ?? round.n, ops };
}

/** 本圈产生的针目数（= c_n） */
export function roundTops(round) {
  return round.ops.reduce((s, o) => s + OP[o.op].tops * o.count, 0);
}

/** 本圈消耗的上一圈针目数（第 1 圈无意义，返回 0） */
export function roundBases(round) {
  return round.ops.reduce((s, o) => s + OP[o.op].bases * o.count, 0);
}

/** 本圈总操作针数（不含重复；用于统计工作量） */
export function roundOps(round) {
  return round.ops.reduce((s, o) => s + o.count, 0);
}

/** 每个部件的针数序列 [c_1, c_2, ...] */
export function partCounts(part) {
  return part.rounds.map(roundTops);
}

/** 上一圈针数：第 1 圈取 startCount 的语义值（magic-ring 时等于第 1 圈针数） */
export function prevCount(part, index) {
  if (index === 0) return null; // 第 1 圈没有"上一圈"
  return roundTops(part.rounds[index - 1]);
}

/**
 * 以第 1 圈针数为基准反推起始圈数。
 * magic-ring：环起后直接钩第 1 圈，所以 startCount === c_1。
 * chain-ring：锁针链成环，链条数 = c_1（首圈穿进链条）。
 */
export function startCountOf(part) {
  return roundTops(part.rounds[0]);
}

/** 整个图解的总针数（工作量指标） */
export function totalStitches(pattern) {
  return pattern.parts.reduce(
    (s, p) => s + p.rounds.reduce((a, r) => a + roundOps(r), 0),
    0,
  );
}
