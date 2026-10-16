/**
 * 合法性校验 —— 这是"能不能钩得出来"的判据，也是 AI 生成结果的唯一裁判。
 *
 * 分两级：
 *   error  结构性错误，照着钩一定出错
 *   warn   不违法但容易出问题（工作量、收口、形状异常）
 *
 * 核心是 V003：本圈消耗的基针数必须严格等于上一圈的针目数。
 * 这一条成立，"相邻两圈耦合"就成立，图解就一定可钩；不成立就是错图解。
 */

import { OP, roundBases, roundTops, roundOps } from './ir.js';

export function validatePattern(pattern) {
  const issues = [];
  const add = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra });

  if (!pattern?.parts?.length) {
    add('error', 'V000', '图解里没有任何部件');
    return { ok: false, issues };
  }
  if (!(pattern.gauge?.w > 0) || !(pattern.gauge?.h > 0)) {
    add('error', 'V010', 'gauge（针宽/针高）必须是正数，否则无法换算尺寸');
  }

  for (const part of pattern.parts) {
    const tag = `[${part.id}]`;
    if (!part.rounds.length) {
      add('error', 'V001', `${tag} 部件没有任何圈`, { part: part.id });
      continue;
    }

    part.rounds.forEach((round, i) => {
      const n = i + 1;
      const tops = roundTops(round);

      if (round.n !== n) {
        add('warn', 'V007', `${tag} 第 ${n} 圈编号不连续（IR 里是 ${round.n}）`, { part: part.id, round: n });
      }
      if (tops < 1) {
        add('error', 'V002', `${tag} 第 ${n} 圈产生 ${tops} 针，非法`, { part: part.id, round: n });
      }

      if (i === 0) {
        if (tops < 3) {
          add('warn', 'V011', `${tag} 第 1 圈只有 ${tops} 针，太少，正常起针建议 ≥ 6`, { part: part.id, round: n });
        }
        return;
      }

      const prev = roundTops(part.rounds[i - 1]);
      const bases = roundBases(round);

      // ★ 核心：耦合守恒
      if (bases !== prev) {
        add(
          'error',
          'V003',
          `${tag} 第 ${n} 圈吃掉了 ${bases} 个上一圈针目，但上一圈只有 ${prev} 针 —— 多钩或漏钩，图解不可钩`,
          { part: part.id, round: n, prev, bases },
        );
      }

      // 单圈变化幅度上限（耦合约束的直接推论）
      const lo = Math.ceil(prev / 2);
      const hi = 2 * prev;
      if (tops > hi) {
        add('error', 'V004', `${tag} 第 ${n} 圈从 ${prev} 猛增到 ${tops}，超过单圈上限 ${hi}（一个基针最多穿 2 次）`, {
          part: part.id,
          round: n,
        });
      }
      if (tops < lo) {
        add('error', 'V005', `${tag} 第 ${n} 圈从 ${prev} 骤减到 ${tops}，低于单圈下限 ${lo}（减针不许跳针）`, {
          part: part.id,
          round: n,
        });
      }

      // 中间圈的减针使用过密（形状会出现台阶）
      const decs = round.ops.filter((o) => o.op === 'dec').reduce((s, o) => s + o.count, 0);
      if (decs > 0 && decs / prev > 0.5) {
        add('warn', 'V006', `${tag} 第 ${n} 圈减针占了 ${Math.round((decs / prev) * 100)}%，收口会很陡`, {
          part: part.id,
          round: n,
        });
      }
      const ops = roundOps(round);
      if (ops > 200) {
        add('warn', 'V008', `${tag} 第 ${n} 圈有 ${ops} 针，钩起来很累，考虑放大 gauge（换粗线/大钩针）`, {
          part: part.id,
          round: n,
        });
      }

      // 圈内加减针分布是否均匀（决定是不是正圆）
      const spec = round.ops.filter((o) => o.op !== 'sc').reduce((s, o) => s + o.count, 0);
      if (spec > 0 && round.ops.length === 1 && ops === spec && spec > 1) {
        add('warn', 'V009', `${tag} 第 ${n} 圈所有特殊针连在一起（${spec} 个连续），会形成明显偏心`, {
          part: part.id,
          round: n,
        });
      }
    });

    // 封闭件收口检查：最后几圈应递减
    const counts = part.rounds.map(roundTops);
    const last = counts[counts.length - 1];
    const peak = Math.max(...counts);
    if (counts.length >= 4 && last > peak / 2) {
      add('warn', 'V012', `${tag} 最后一圈还有 ${last} 针（峰值 ${peak}），没有收口，做出来是开口的`, {
        part: part.id,
      });
    }
  }

  return { ok: !issues.some((x) => x.level === 'error'), issues };
}

/** 人话版报告 */
export function report(result) {
  if (!result.issues.length) return '✅ 校验通过：结构合法，可以照着钩。';
  const icon = { error: '❌', warn: '⚠️' };
  const lines = result.issues.map((i) => `${icon[i.level]} ${i.code} ${i.message}`);
  const errs = result.issues.filter((i) => i.level === 'error').length;
  const warns = result.issues.length - errs;
  return [
    result.ok ? `⚠️ 可以钩，但有 ${warns} 处提醒：` : `❌ 不可钩：${errs} 处错误、${warns} 处提醒`,
    ...lines,
  ].join('\n');
}

/** 摘要统计，给界面显示 */
export function summarize(pattern) {
  const rows = [];
  for (const part of pattern.parts) {
    const counts = part.rounds.map(roundTops);
    const peak = counts.length ? Math.max(...counts) : 0;
    rows.push({
      id: part.id,
      rounds: part.rounds.length,
      peak,
      last: counts[counts.length - 1] ?? 0,
      stitches: part.rounds.reduce((a, r) => a + roundOps(r), 0),
      maxRadius: (peak * pattern.gauge.w) / (2 * Math.PI),
      height: part.rounds.length * pattern.gauge.h,
    });
  }
  return rows;
}

export { OP };
