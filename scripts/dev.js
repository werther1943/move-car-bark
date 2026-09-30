/**
 * 本地预览：npm run dev
 * 用 Node 内置 http + 全局 Request/Response 模拟边缘函数运行时，
 * 配置从 .env（或环境变量）读取，访问 http://localhost:8787 预览页面。
 *
 * 路由刻意复刻真实部署形态：
 *   /        → 根目录 index.html（静态托管）
 *   /api/*   → 边缘函数
 *   /ssr     → 服务端渲染版（functions/index.js 的效果），用于对照
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8787;

function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) return;
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
    });
  return out;
}

const env = Object.assign({}, loadEnv(), process.env);
const { handleRequest } = await import(pathToFileURL(path.join(root, 'src', 'app.js')).href);

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
      else headers.set(k, v);
    });

    const url = new URL(req.url, 'http://localhost');

    try {
      if ((url.pathname === '/' || url.pathname === '/index.html') && fs.existsSync(path.join(root, 'index.html'))) {
        const buf = fs.readFileSync(path.join(root, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
        res.end(buf);
        return;
      }

      const target = url.pathname === '/ssr' ? '/' + (url.search || '') : req.url;
      const request = new Request('http://localhost:' + PORT + target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });

      const response = await handleRequest(request, env);
      const buf = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('worker error: ' + (e && e.stack ? e.stack : e));
    }
  })
  .listen(PORT, () => {
    console.log('本地预览已启动： http://localhost:' + PORT);
    console.log('  /      静态 index.html（等同线上静态托管的形态）');
    console.log('  /ssr   服务端渲染版（等同 functions/index.js 的形态）');
    console.log('当前 BARK_KEY：' + (env.BARK_KEY ? '已配置' : '未配置（在 .env 中填写后可真实推送）'));
  });
