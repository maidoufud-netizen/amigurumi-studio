/**
 * IR → 环形图解（符号图）SVG。
 *
 * 为什么是环形：玩偶是圈钩的，**一针画在哪里，由它穿在上一圈的哪一针上决定**。
 * 所以本模块不做"平均分角度"这种偷懒事，而是按拓扑消费关系定位。
 *
 * ── 两个概念必须分开（这是本模块的核心）──────────────────────────
 *
 *   stitches[]  针目位置：本圈**产生**的每一个针目（长度 = cₙ）。
 *               下一圈消耗的就是它们，所以角度必须准确。
 *   glyphs[]    绘图符号：图上真正画出来的记号（长度 = 本圈操作数）。
 *               加针是一针出两针 → 2 个针目，但只画 1 个 V 符号；
 *               减针是两针并一针 → 1 个针目，画 1 个 A 符号。
 *
 * 把两者混为一谈就会出现"第 3 圈要消耗 12 个基针，可第 2 环只有 6 个位置"
 * 这种错——单元测试里就是这么抓出来的。
 *
 * 半径策略：既保证圈与圈嵌套（≥ 上一圈 + minGap），
 * 又保证每针有足够弧长（≥ cell），否则 60 针的圈会挤成一团。
 *
 * 纯函数：只读 IR，不碰 DOM，可在 Node 里直接测试。
 */
import { OP, roundTops, roundOps } from './ir.js';
import { expandOps } from './pattern.js';

const DEFAULTS = {
  cell: 7.2,      // 每针至少占的弧长（px）
  minGap: 9,      // 相邻圈的径向最小间距（px）
  r1: 13,         // 第 1 圈半径（px）
  splitRatio: 0.22, // 加针两个针目的角向分离量（× 局部角步长）
};

/** 两个角度的中点，处理跨 0 的接缝 */
function midAngle(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d / 2;
}

function fail(rings, radii, msg) {
  return { rings, maxR: radii[radii.length - 1] ?? DEFAULTS.r1, ok: false, error: msg };
}

/**
 * 计算每一针在平面上的落点。
 * @returns {{rings:Array, maxR:number, ok:boolean, error?:string}}
 */
export function layoutChart(part, options = {}) {
  const { cell, minGap, r1, splitRatio } = { ...DEFAULTS, ...options };
  const rounds = part.rounds;
  const counts = rounds.map(roundTops);

  // ① 半径：嵌套 + 弧长双约束
  const radii = [];
  let r = r1;
  for (let i = 0; i < rounds.length; i++) {
    const need = (counts[i] * cell) / (2 * Math.PI);
    r = i === 0 ? Math.max(r1, need) : Math.max(r + minGap, need);
    radii.push(r);
  }

  // ② 第 1 圈：没有上一圈可依附，针目均匀铺开
  const firstSeq = expandOps(rounds[0].ops);
  const firstStitches = [];
  const firstGlyphs = [];
  {
    const n = counts[0];
    const base = [];
    for (let j = 0; j < n; j++) base.push((2 * Math.PI * j) / n);
    let cursor = 0;
    for (const op of firstSeq) {
      const produces = OP[op].tops;
      if (produces === 1) {
        const a = base[Math.min(cursor, n - 1)];
        firstStitches.push({ op, angle: a });
        firstGlyphs.push({ op, angle: a });
      } else {
        const a = base[Math.min(cursor, n - 2)];
        const off = ((2 * Math.PI) / n) * splitRatio;
        firstStitches.push({ op, angle: a - off });
        firstStitches.push({ op, angle: a + off });
        firstGlyphs.push({ op, angle: a });
      }
      cursor += produces;
    }
  }

  const rings = [{ n: 1, r: radii[0], total: counts[0], stitches: firstStitches, glyphs: firstGlyphs }];

  // ③ 之后每圈：按"消耗了上一圈的哪些针目"定位
  for (let i = 1; i < rounds.length; i++) {
    const seq = expandOps(rounds[i].ops);
    const prev = rings[i - 1].stitches;
    const step = (2 * Math.PI) / Math.max(prev.length, 1);
    let cursor = 0;
    const stitches = [];
    const glyphs = [];

    for (const op of seq) {
      const bases = OP[op].bases;
      const produces = OP[op].tops;
      if (cursor + bases > prev.length) {
        return fail(rings, radii,
          `第 ${i + 1} 圈吃掉的基针超过了上一圈的 ${prev.length} 针（图解不可钩），无法定位`);
      }
      const consumed = [];
      for (let k = 0; k < bases; k++) consumed.push(prev[cursor + k].angle);
      cursor += bases;

      if (produces === 1) {
        const a = consumed.length === 1 ? consumed[0] : midAngle(consumed[0], consumed[1]);
        stitches.push({ op, angle: a });
        glyphs.push({ op, angle: a });
      } else {
        // 一针出两针：两个针目左右分开，图上合成一个 V
        const a = consumed[0];
        const off = step * splitRatio;
        stitches.push({ op, angle: a - off });
        stitches.push({ op, angle: a + off });
        glyphs.push({ op, angle: a });
      }
    }

    if (cursor !== prev.length) {
      return fail(rings, radii,
        `第 ${i + 1} 圈只吃掉了 ${cursor} / ${prev.length} 个基针（漏针），无法定位`);
    }
    rings.push({ n: i + 1, r: radii[i], total: counts[i], stitches, glyphs });
  }

  return { rings, maxR: radii[radii.length - 1], ok: true };
}

/** 单个针法的线稿符号（无填充、无颜色） */
function symbolMarkup(op, x, y, s, stroke) {
  const h = s / 2;
  const common = `fill="none" stroke="${stroke}" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"`;
  if (op === 'sc') {
    return `<path d="M${x - h} ${y - h} L${x + h} ${y + h} M${x + h} ${y - h} L${x - h} ${y + h}" ${common}/>`;
  }
  if (op === 'inc') {
    return `<path d="M${x - h} ${y - h} L${x} ${y + h} L${x + h} ${y - h}" ${common}/>`;
  }
  return `<path d="M${x - h} ${y + h} L${x} ${y - h} L${x + h} ${y + h}" ${common}/>`
    + `<path d="M${x - h * 0.62} ${y + h * 0.92} L${x + h * 0.62} ${y + h * 0.92}" ${common}/>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
}

/**
 * 渲染成 SVG 字符串。
 * @param {object} part IR 部件
 * @param {object} opts { cell, minGap, r1, pad, stroke, guide, label, showGuides, title }
 */
export function chartToSVG(part, opts = {}) {
  const {
    pad = 30,
    stroke = '#111827',
    guide = '#d7dee8',
    label = '#64748b',
    showGuides = true,
    title = null,
  } = opts;

  const layout = layoutChart(part, opts);
  const { rings, maxR } = layout;
  const size = Math.round((maxR + pad) * 2);
  const c = size / 2;
  // 角度 0 放在 12 点方向（图解惯例：起针在正上方）
  const X = (r, a) => c + r * Math.cos(a - Math.PI / 2);
  const Y = (r, a) => c + r * Math.sin(a - Math.PI / 2);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="钩织符号图解">`);
  out.push(`<rect width="${size}" height="${size}" fill="#ffffff"/>`);

  if (showGuides) {
    for (const ring of rings) {
      out.push(`<circle cx="${c}" cy="${c}" r="${ring.r.toFixed(2)}" fill="none" stroke="${guide}" stroke-width="0.6"/>`);
    }
  }

  // 起针方向标记
  out.push(`<path d="M${c} ${c - (maxR + 12)} L${c} ${c - (maxR + 4)}" stroke="${label}" stroke-width="0.8"/>`);

  // 符号（画 glyphs，不画 stitches——加针的两个针目合成一个 V）
  const symSize = Math.min(6.4, DEFAULTS.cell * 0.85);
  for (const ring of rings) {
    for (const g of ring.glyphs) {
      out.push(symbolMarkup(g.op, X(ring.r, g.angle), Y(ring.r, g.angle), symSize, stroke));
    }
  }

  // 圈号·针数，沿 12 点方向排一列
  for (const ring of rings) {
    out.push(
      `<text x="${c + 3}" y="${c - ring.r + 3}" font-size="8.5" fill="${label}" `
      + `font-family="ui-monospace,Consolas,monospace">${ring.n}·${ring.total}</text>`,
    );
  }

  if (title) {
    out.push(`<text x="10" y="14" font-size="10" fill="${label}" font-family="system-ui,sans-serif">${escapeXml(title)}</text>`);
  }

  out.push('</svg>');
  return { svg: out.join('\n'), layout, size };
}

/** 图解统计，给界面显示 */
export function chartStats(part) {
  const counts = part.rounds.map(roundTops);
  const ops = part.rounds.map(roundOps);
  return {
    rounds: part.rounds.length,
    peak: counts.length ? Math.max(...counts) : 0,
    peakRound: counts.indexOf(Math.max(...counts)) + 1,
    last: counts[counts.length - 1] ?? 0,
    totalStitches: counts.reduce((a, b) => a + b, 0),
    totalOps: ops.reduce((a, b) => a + b, 0),
    incs: part.rounds.reduce((a, r) => a + r.ops.filter((o) => o.op === 'inc').reduce((s, o) => s + o.count, 0), 0),
    decs: part.rounds.reduce((a, r) => a + r.ops.filter((o) => o.op === 'dec').reduce((s, o) => s + o.count, 0), 0),
  };
}
