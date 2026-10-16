/**
 * 零依赖静态服务器，只为本项目的预览页服务。
 *
 *   node scripts/serve.js [port]     默认 5173
 *
 * 为什么需要它：预览页用的是原生 ES 模块 + importmap，
 * 浏览器在 file:// 协议下会拒绝加载模块，必须走 http。
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] || 5173);

/**
 * ── AI 提示词桥 ──
 *
 * 规则解析器只认 5 个形状词，遇到「手臂」「底盘」这类名词只能瞎猜
 * （实测：手臂长12cm → Ø108mm）。所以提示词先交给 DSH 会话里的 AI 来生成规格。
 *
 * 流程：
 *   页面 POST /api/prompt  →  写进 tools/ai-queue.json（status=pending）
 *   DSH 会话里的 AI 用 tools/ai-bridge.mjs 写入 spec（status=answered）
 *   页面轮询 GET /api/prompt?id=…  →  拿到 spec 后应用
 *
 * 队列文件放在 tools/ 下（已 gitignore），是页面与 AI 之间唯一的握手点。
 */
const QUEUE = join(root, 'tools', 'ai-queue.json');
const MAX_REQUESTS = 60;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    // ── 提示词桥的 API（必须在静态文件之前处理）──
    if (pathname === '/api/prompt') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const prompt = String(body.prompt || '').trim();
        if (!prompt) {
          sendJson(res, 400, { error: 'prompt 不能为空' });
          return;
        }
        const q = await readQueue();
        const entry = {
          id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          prompt,
          base: body.base || null,
          status: 'pending',
          createdAt: new Date().toISOString(),
          spec: null,
          notes: [],
          answeredAt: null,
          answeredBy: null,
        };
        q.requests.push(entry);
        if (q.requests.length > MAX_REQUESTS) q.requests = q.requests.slice(-MAX_REQUESTS);
        await writeQueue(q);
        console.log(`[ai-bridge] 收到提示词请求 ${entry.id}：${prompt}`);
        sendJson(res, 200, { id: entry.id, status: 'pending' });
        return;
      }

      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      const q = await readQueue();
      if (!id) {
        sendJson(res, 200, q);
        return;
      }
      const entry = q.requests.find((r) => r.id === id);
      if (!entry) {
        sendJson(res, 404, { error: '没有这个请求', id });
        return;
      }
      sendJson(res, 200, entry);
      return;
    }

    if (pathname === '/') pathname = '/web/index.html';
    if (pathname.endsWith('/')) pathname += 'index.html';

    const rel = normalize(pathname).replace(/^[/\\]+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 forbidden');
      return;
    }

    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 ' + err.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`预览地址：http://127.0.0.1:${port}/web/`);
  console.log('按 Ctrl+C 停止');
});
