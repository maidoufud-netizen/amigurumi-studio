/**
 * 零依赖静态服务器，只为本项目的预览页服务。
 *
 *   node scripts/serve.js [port]     默认 5173
 *
 * 为什么需要它：预览页用的是原生 ES 模块 + importmap，
 * 浏览器在 file:// 协议下会拒绝加载模块，必须走 http。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] || 5173);

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
