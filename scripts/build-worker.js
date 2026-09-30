/**
 * 从 src/app.js 生成各运行时的部署文件。
 *
 * 为什么每个产物都「自包含」（把 app.js 内联进去）：
 *   - EdgeOne 边缘函数编辑器只支持单文件粘贴
 *   - Pages / Makers 构建时跨目录 import（如 ../src/app.js）存在打包失败风险
 * 因此每个产物都是独立可运行的文件，互不依赖。
 *
 * 产物说明：
 *   index.html                 根目录静态页 —— 保证站点「存在」，任何静态托管都能打开
 *   edge-functions/**          EdgeOne Makers（*.edgeone.dev）
 *   functions/**               EdgeOne Pages Functions（国际站）
 *   node-functions/**          EdgeOne Pages Node Functions（国内站）
 *   worker.js                  EdgeOne 控制台「边缘函数」单文件粘贴版
 *
 * 三个函数目录作用相同，平台只认自己那一个，用不到的可以删掉。
 * 注意：Pages / Makers 都不支持 addEventListener，统一用 onRequest(context)。
 *
 * 用法：npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, getConfig } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

// 剥离 ESM 语法，得到可在任意单文件环境直接运行的普通脚本
const body = src
  .split('\n')
  .filter((line) => !/^\s*export\s+/.test(line))
  .join('\n')
  .replace(/^export\s+/gm, '')
  .trimEnd();

const GENERATED = '本文件由 scripts/build-worker.js 自动生成，请勿直接编辑，源码见 src/app.js。';

/* Pages / Makers 官方入口：Function Handlers */
const HANDLER_FOOTER = `
/* ------------------------------------------------------------------ */
/* Function Handlers —— EdgeOne Pages / Makers 入口                    */
/* 注意：Pages 与 Makers 均不支持 addEventListener，必须使用 onRequest  */
/* ------------------------------------------------------------------ */
export async function onRequest(context) {
  const request = (context && context.request) || context;
  const scope = (context && context.env) || (typeof env !== 'undefined' ? env : null) || {};
  return handleRequest(request, scope);
}
export async function onRequestGet(context) {
  return onRequest(context);
}
export async function onRequestPost(context) {
  return onRequest(context);
}
export default onRequest;
`;

/* EdgeOne 控制台「边缘函数」入口：Service Worker 写法 */
const SW_FOOTER = `
/* ------------------------------------------------------------------ */
/* 入口：EdgeOne 控制台「边缘函数」（Service Worker 写法）             */
/* ------------------------------------------------------------------ */
addEventListener('fetch', (event) => {
  const scope = typeof env !== 'undefined' ? env : {};
  event.respondWith(handleRequest(event.request, scope));
});
`;

/* ------------------------------------------------------------------ */
/* 构建期环境变量：用于把 plate / phone 等展示型配置烘焙进 index.html   */
/* （BARK_KEY 永远不会被写进 index.html）                              */
/* ------------------------------------------------------------------ */

function loadEnvFile() {
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

/**
 * 是否把 .env 里的「展示型」配置（车牌、电话、标题）烘焙进 index.html。
 * 默认关闭：仓库里提交的 index.html 保持干净，不带任何个人信息；
 * 纯静态部署（完全没有边缘函数）时才需要打开：BAKE_CONFIG=1 npm run build。
 * 注意：BARK_KEY 在任何情况下都不会被写进 index.html。
 */
const bake = process.env.BAKE_CONFIG === '1';
const buildEnv = bake ? Object.assign({}, loadEnvFile(), process.env) : {};

/* ------------------------------------------------------------------ */
/* 产物                                                                */
/* ------------------------------------------------------------------ */

const targets = [{ file: 'worker.js', banner: [
  '/* ==========================================================================',
  ' * 挪车通知 Worker（EdgeOne 控制台 · 边缘函数 · 单文件版）',
  ' * ' + GENERATED,
  ' *',
  ' * 部署：EdgeOne 控制台 → 边缘函数 → 新建函数',
  ' *       → 把本文件全部内容粘进代码编辑器（覆盖默认示例）',
  ' *       → 「环境变量」里添加 BARK_KEY 等配置并部署',
  ' *       → 配置触发规则（如 /* 或 /move-car/*）',
  ' *',
  ' * 也可以直接改文件顶部 HARD_CODE 里的常量（优先级低于环境变量）。',
  ' * ========================================================================== */',
].join('\n'), footer: SW_FOOTER }];

for (const dir of ['edge-functions', 'functions', 'node-functions']) {
  targets.push(
    { file: dir + '/index.js', banner: '/* 站点首页 / —— ' + GENERATED + ' */', footer: HANDLER_FOOTER },
    { file: dir + '/api/[[default]].js', banner: '/* /api/* （config、notify）—— ' + GENERATED + ' */', footer: HANDLER_FOOTER },
    { file: dir + '/healthz.js', banner: '/* /healthz —— ' + GENERATED + ' */', footer: HANDLER_FOOTER }
  );
}

for (const t of targets) {
  const full = path.join(root, t.file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, t.banner + '\n\n' + body + '\n' + t.footer, 'utf8');
  console.log('[build] ' + t.file + '  ' + fs.statSync(full).size + ' bytes');
}

/* 根目录静态页：保证站点一定「存在」，即使函数没被平台识别也能打开页面 */
const html = renderPage(getConfig(buildEnv));
fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');
console.log('[build] index.html  ' + html.length + ' bytes');
