/**
 * AI 提示词桥 —— 命令行端（给 DSH 会话里的 AI 用）。
 *
 *   node tools/ai-bridge.mjs list                         看队列（pending 优先）
 *   node tools/ai-bridge.mjs show <id>                     看单条
 *   node tools/ai-bridge.mjs answer <id> --spec '<json>' --notes '说明1|说明2'
 *   node tools/ai-bridge.mjs answer <id> --spec @file.json
 *   node tools/ai-bridge.mjs clear                         清掉已回答的旧条目
 *
 * 页面在 /api/prompt 上轮询，所以写完 spec 页面就会自己更新。
 * spec 会用 src/shape.js 的 normalizeSpec 校验——AI 也可能给错，必须拦住。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpec, describeSpec, profileFromSpec } from '../src/shape.js';

const here = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(here, 'ai-queue.json');

async function readQueue() {
  try {
    const q = JSON.parse(await readFile(QUEUE, 'utf8'));
    if (!Array.isArray(q.requests)) return { requests: [] };
    return q;
  } catch {
    return { requests: [] };
  }
}

async function writeQueue(q) {
  await writeFile(QUEUE, JSON.stringify(q, null, 2), 'utf8');
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadSpec(raw) {
  const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw;
  return JSON.parse(text);
}

const cmd = process.argv[2] || 'list';
const q = await readQueue();

if (cmd === 'list') {
  const pending = q.requests.filter((r) => r.status === 'pending');
  const done = q.requests.filter((r) => r.status !== 'pending');
  console.log(`队列：${q.requests.length} 条（待处理 ${pending.length}，已回答 ${done.length}）\n`);
  for (const r of pending) {
    console.log(`⏳ ${r.id}`);
    console.log(`   提示词：${r.prompt}`);
    if (r.base) console.log(`   基于：${JSON.stringify(r.base)}`);
    console.log(`   提交于：${r.createdAt}`);
  }
  if (done.length) {
    console.log('\n—— 已回答 ——');
    for (const r of done.slice(-8)) {
      console.log(`${r.status === 'answered' ? '✅' : '⚠️'} ${r.id}  ${r.prompt}`);
      if (r.spec) console.log(`   → ${describeSpec(normalizeSpec(r.spec))}`);
    }
  }
} else if (cmd === 'show') {
  const r = q.requests.find((x) => x.id === process.argv[3]);
  console.log(r ? JSON.stringify(r, null, 2) : `没有这个请求：${process.argv[3]}`);
} else if (cmd === 'answer') {
  const id = process.argv[3];
  const r = q.requests.find((x) => x.id === id);
  if (!r) {
    console.error(`没有这个请求：${id}`);
    process.exit(1);
  }
  const rawSpec = arg('spec');
  if (!rawSpec) {
    console.error('缺少 --spec（形状规格 JSON）');
    process.exit(1);
  }

  let spec;
  try {
    spec = normalizeSpec(await loadSpec(rawSpec));
    // 立刻算一遍剖面，能在这一步就发现"规格合法但几何不成立"的情况
    const profile = profileFromSpec(spec);
    if (!profile.length || profile.some((p) => !Number.isFinite(p.r) || !Number.isFinite(p.h))) {
      throw new Error('剖面里有非法数值');
    }
  } catch (err) {
    console.error(`规格被拒绝：${err.message}`);
    process.exit(1);
  }

  const notes = (arg('notes') || '').split('|').map((s) => s.trim()).filter(Boolean);
  r.spec = spec;
  r.notes = notes;
  r.status = 'answered';
  r.answeredAt = new Date().toISOString();
  r.answeredBy = arg('by', 'dsh-session');
  await writeQueue(q);

  console.log(`✅ 已答复 ${id}`);
  console.log(`   ${r.prompt}`);
  console.log(`   → ${describeSpec(spec)}`);
  if (notes.length) console.log(`   说明：${notes.join('；')}`);
  console.log('   页面会自动取到结果（它在轮询 /api/prompt）。');
} else if (cmd === 'clear') {
  const keep = q.requests.filter((r) => r.status === 'pending');
  await writeQueue({ requests: keep });
  console.log(`已清理，保留 ${keep.length} 条待处理。`);
} else {
  console.log('用法：list | show <id> | answer <id> --spec <json|@file> [--notes "a|b"] | clear');
}
