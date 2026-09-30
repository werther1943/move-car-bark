/**
 * 把 src/app.js 打包成根目录的 worker.js —— 单文件版本，
 * 可直接整段复制到「EdgeOne 控制台 → 边缘函数 → 代码编辑器」中部署。
 *
 * 原理：EdgeOne 边缘函数编辑器只支持单个文件，因此剥离 ESM 语法后追加
 * Service Worker 风格的入口（env 在 EdgeOne 中是全局注入的）。
 *
 * 用法：npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

const banner = `/* ==========================================================================
 * 挪车通知 Worker（EdgeOne 边缘函数 · 单文件版）
 * --------------------------------------------------------------------------
 * 本文件由 scripts/build-worker.js 自动生成，请勿直接编辑。
 * 源码见 src/app.js，修改后执行：npm run build
 *
 * 部署方式：
 *   1. 打开 腾讯云 EdgeOne 控制台 → 边缘函数 → 新建函数
 *   2. 把本文件全部内容粘贴进代码编辑器（覆盖默认示例代码）
 *   3. 在「环境变量」中添加 BARK_KEY 等配置并点击部署
 *   4. 配置触发规则（如 /* 或 /move-car/*），访问对应域名即可
 *
 * 也可以直接在文件顶部 HARD_CODE 中写死配置（优先级低于环境变量）。
 * ========================================================================== */
`;

const footer = `
/* ------------------------------------------------------------------ */
/* 入口：EdgeOne 边缘函数 / Cloudflare Workers 均支持该写法            */
/* ------------------------------------------------------------------ */
addEventListener('fetch', (event) => {
  // EdgeOne 中 env 为全局注入对象；其他场景下退化为空对象，走 HARD_CODE
  const scope = typeof env !== 'undefined' ? env : {};
  event.respondWith(handleRequest(event.request, scope));
});
`;

// 剥离 ESM 语法（EdgeOne 单文件编辑器不支持 import / export）
const body = src
  .split('\n')
  .filter((line) => !/^\s*export\s+/.test(line))
  .join('\n')
  .replace(/^export\s+/gm, '');

const out = banner + body.trimEnd() + '\n' + footer;
fs.writeFileSync(path.join(root, 'worker.js'), out, 'utf8');
console.log('[build] worker.js 已生成，' + Buffer.byteLength(out, 'utf8') + ' bytes');
