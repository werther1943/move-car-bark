/**
 * EdgeOne Pages Functions / Cloudflare Workers 入口（ES Module 写法）
 *
 * 目录约定：functions/[[path]].js 会捕获站点的所有路径，
 * 因此 /、/api/notify、/api/config、/healthz 均由本项目同一个函数处理。
 */
import { handleRequest } from '../src/app.js';

export default {
  async fetch(request, env) {
    return handleRequest(request, env || {});
  },
};
