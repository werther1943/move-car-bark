/* /api/* （config、notify）—— 本文件由 scripts/build-worker.js 自动生成，请勿直接编辑，源码见 src/app.js。 */

/**
 * 挪车通知 · 核心逻辑
 * ------------------------------------------------------------------
 * 目标运行时：腾讯云 EdgeOne 边缘函数（兼容 Cloudflare Workers / EdgeOne Pages Functions）
 *
 * 设计要点：
 *  1. Bark 推送在边缘函数侧完成，device_key 只存在于环境变量中，不暴露给浏览器。
 *  2. 同源校验 + IP 冷却 + 每小时次数上限，防止被恶意刷推送。
 *  3. 所有可配置项均支持「环境变量」或「文件顶部硬编码」两种方式。
 */

/** 文件内硬编码配置（优先级低于环境变量；留空则完全使用环境变量） */
const HARD_CODE = {
  // BARK_KEY: 'xxxxxxxxxxxxxxxxxxxx',   // Bark device_key，多个用英文逗号分隔
  // BARK_SERVER: 'https://api.day.app', // 自建 Bark 服务时改成自己的域名
  // OWNER_PHONE: '13800138000',         // 车主电话，配置后页面出现「拨打车主电话」
  // PLATE: '京A·12345',                 // 展示用的车牌号
};

const DEFAULTS = {
  BARK_SERVER: 'https://api.day.app',
  BARK_LEVEL: 'timeSensitive', // active | timeSensitive | critical | passive
  BARK_GROUP: '挪车提醒',
  BARK_ICON: '',
  BARK_SOUND: '',
  BARK_ARCHIVE: '1',
  OWNER_PHONE: '',
  PLATE: '',
  PAGE_TITLE: '通知车主挪车',
  PAGE_TIP: '车辆挡道？点一下按钮，车主会立即收到 Bark 推送',
  SHOW_PHONE: '0', // 1 = 拨号按钮下方额外显示脱敏号码，0 = 完全不显示号码
  PAGE_TTL: '300', // 页面有效期（秒）；0 = 不限时。过期后需重新访问才能交互
  COOLDOWN: '60', // 同一 IP 两次推送之间的冷却秒数
  MAX_PER_HOUR: '5', // 同一 IP 每小时最多推送次数
  TIMEZONE_OFFSET: '8', // 推送时间使用的时区偏移（小时）
};

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function readEnv(env, key) {
  let v = '';
  if (env && typeof env === 'object') {
    v = typeof env[key] !== 'undefined' && env[key] !== null ? env[key] : '';
  }
  if (v === '' && typeof HARD_CODE !== 'undefined' && HARD_CODE[key]) v = HARD_CODE[key];
  if (v === '' && typeof DEFAULTS !== 'undefined' && DEFAULTS[key]) v = DEFAULTS[key];
  return typeof v === 'string' ? v.trim() : v;
}

function getConfig(env) {
  return {
    barkKey: readEnv(env, 'BARK_KEY'),
    barkServer: readEnv(env, 'BARK_SERVER').replace(/\/+$/, ''),
    barkLevel: readEnv(env, 'BARK_LEVEL'),
    barkGroup: readEnv(env, 'BARK_GROUP'),
    barkIcon: readEnv(env, 'BARK_ICON'),
    barkSound: readEnv(env, 'BARK_SOUND'),
    barkArchive: readEnv(env, 'BARK_ARCHIVE'),
    phone: readEnv(env, 'OWNER_PHONE'),
    plate: readEnv(env, 'PLATE'),
    title: readEnv(env, 'PAGE_TITLE'),
    tip: readEnv(env, 'PAGE_TIP'),
    showPhone: readEnv(env, 'SHOW_PHONE') === '1',
    ttl: Math.max(0, parseInt(readEnv(env, 'PAGE_TTL'), 10) || 0),
    cooldown: Math.max(0, parseInt(readEnv(env, 'COOLDOWN'), 10) || 0),
    maxPerHour: Math.max(0, parseInt(readEnv(env, 'MAX_PER_HOUR'), 10) || 0),
    tzOffset: parseInt(readEnv(env, 'TIMEZONE_OFFSET'), 10) || 0,
  };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function clientIp(request) {
  const h = request.headers;
  const xff = h.get('X-Forwarded-For') || '';
  return (
    h.get('EO-Client-IP') ||
    h.get('eo-client-ip') ||
    h.get('X-Real-IP') ||
    (xff.split(',')[0] || '').trim() ||
    (request.eo && request.eo.clientIp) ||
    'unknown'
  );
}

function maskPhone(p) {
  const s = String(p || '');
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-4);
  return s;
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function stamp(offsetHours) {
  const d = new Date(Date.now() + (offsetHours || 0) * 3600 * 1000);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    ' ' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ':' +
    pad(d.getUTCSeconds()) +
    ' ' +
    week
  );
}

function shortUa(ua) {
  const s = String(ua || '');
  let os = '未知设备';
  if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Macintosh/i.test(s)) os = 'macOS';
  let browser = '';
  if (/MicroMessenger/i.test(s)) browser = '微信';
  else if (/Alipay/i.test(s)) browser = '支付宝';
  else if (/Weibo/i.test(s)) browser = '微博';
  else if (/QQ\//i.test(s)) browser = 'QQ';
  else if (/Edg/i.test(s)) browser = 'Edge';
  else if (/Chrome/i.test(s)) browser = 'Chrome';
  else if (/Safari/i.test(s)) browser = 'Safari';
  return browser ? os + ' · ' + browser : os;
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 限流（单边缘节点内存级，尽力而为）                                   */
/* ------------------------------------------------------------------ */

const RATE = new Map();
const HOUR = 3600 * 1000;

function rateCheck(ip, cfg) {
  const now = Date.now();
  if (RATE.size > 5000) RATE.clear();
  for (const k of RATE.keys()) {
    const rec = RATE.get(k);
    if (now - rec.last > HOUR) RATE.delete(k);
  }
  const rec = RATE.get(ip);
  if (!rec) return { ok: true, retryAfter: 0 };
  if (cfg.cooldown > 0 && now - rec.last < cfg.cooldown * 1000) {
    return { ok: false, reason: 'COOLDOWN', retryAfter: Math.ceil((cfg.cooldown * 1000 - (now - rec.last)) / 1000) };
  }
  if (cfg.maxPerHour > 0 && rec.count >= cfg.maxPerHour && now - rec.first < HOUR) {
    return { ok: false, reason: 'LIMIT', retryAfter: Math.ceil((HOUR - (now - rec.first)) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

function rateHit(ip) {
  const now = Date.now();
  const rec = RATE.get(ip);
  if (!rec || now - rec.first > HOUR) {
    RATE.set(ip, { first: now, last: now, count: 1 });
  } else {
    rec.last = now;
    rec.count += 1;
    RATE.set(ip, rec);
  }
}

/* ------------------------------------------------------------------ */
/* Bark 推送                                                           */
/* ------------------------------------------------------------------ */

function barkKeys(cfg) {
  return String(cfg.barkKey || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function barkPayload(cfg, deviceKey, title, body) {
  const p = { device_key: deviceKey, title: title, body: body };
  if (cfg.barkLevel) p.level = cfg.barkLevel;
  if (cfg.barkGroup) p.group = cfg.barkGroup;
  if (cfg.barkIcon) p.icon = cfg.barkIcon;
  if (cfg.barkSound) p.sound = cfg.barkSound;
  p.isArchive = cfg.barkArchive === '0' ? 0 : 1;
  p.badge = 1;
  return p;
}

async function barkGet(server, key, cfg, title, body) {
  const q = [];
  if (cfg.barkLevel) q.push('level=' + encodeURIComponent(cfg.barkLevel));
  if (cfg.barkGroup) q.push('group=' + encodeURIComponent(cfg.barkGroup));
  if (cfg.barkIcon) q.push('icon=' + encodeURIComponent(cfg.barkIcon));
  if (cfg.barkSound) q.push('sound=' + encodeURIComponent(cfg.barkSound));
  q.push('isArchive=' + (cfg.barkArchive === '0' ? 0 : 1));
  const url =
    server +
    '/' +
    encodeURIComponent(key) +
    '/' +
    encodeURIComponent(title) +
    '/' +
    encodeURIComponent(body) +
    (q.length ? '?' + q.join('&') : '');
  return fetch(url, { method: 'GET' });
}

async function sendBark(cfg, title, body) {
  const keys = barkKeys(cfg);
  if (!keys.length) return { ok: false, code: 'NO_KEY', message: '未配置 BARK_KEY' };
  if (!cfg.barkServer) return { ok: false, code: 'NO_SERVER', message: '未配置 BARK_SERVER' };

  const results = [];
  for (const key of keys) {
    let ok = false;
    let detail = '';
    try {
      let res = await fetch(cfg.barkServer + '/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(barkPayload(cfg, key, title, body)),
      });
      let text = await res.text();
      if (!res.ok) {
        // 部分自建 / 老版本 Bark 服务不支持 /push，降级为 GET 路径形式
        res = await barkGet(cfg.barkServer, key, cfg, title, body);
        text = await res.text();
      }
      ok = res.ok;
      detail = res.status + ' ' + String(text).slice(0, 200);
    } catch (e) {
      // 网络异常时同样降级一次
      try {
        const res = await barkGet(cfg.barkServer, key, cfg, title, body);
        const text = await res.text();
        ok = res.ok;
        detail = 'fallback ' + res.status + ' ' + String(text).slice(0, 200);
      } catch (e2) {
        ok = false;
        detail = String((e2 && e2.message) || e2);
      }
    }
    results.push({ key: key.slice(0, 6) + '***', ok: ok, detail: detail });
  }
  const ok = results.some((r) => r.ok);
  return { ok: ok, code: ok ? 'OK' : 'BARK_FAILED', results: results };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleNotify(request, cfg, ip) {
  if (request.method !== 'POST') return jsonResponse({ ok: false, code: 'METHOD' }, 405);
  if (!sameOrigin(request)) return jsonResponse({ ok: false, code: 'ORIGIN' }, 403);
  if (!barkKeys(cfg).length) {
    return jsonResponse({ ok: false, code: 'NO_KEY', message: '服务端未配置 BARK_KEY' }, 500);
  }

  const limit = rateCheck(ip, cfg);
  if (!limit.ok) {
    return jsonResponse(
      {
        ok: false,
        code: limit.reason,
        retryAfter: limit.retryAfter,
        message: limit.reason === 'COOLDOWN' ? '通知已发出，请稍后再试' : '通知次数过多，请稍后再试',
      },
      429
    );
  }

  const title = cfg.plate ? '挪车提醒 · ' + cfg.plate : '挪车提醒';
  const lines = ['有朋友需要您挪车，请尽快处理。'];
  if (cfg.plate) lines.push('您的车辆：' + cfg.plate);
  lines.push('时间：' + stamp(cfg.tzOffset));
  lines.push('来源：' + ip + ' · ' + shortUa(request.headers.get('User-Agent')));

  const r = await sendBark(cfg, title, lines.join('\n'));
  if (!r.ok) {
    return jsonResponse({ ok: false, code: r.code, message: '推送失败，请稍后再试', detail: r.results }, 502);
  }
  rateHit(ip);
  return jsonResponse({ ok: true, code: 'OK', cooldown: cfg.cooldown });
}

function publicConfig(cfg) {
  return {
    ok: true,
    plate: cfg.plate,
    title: cfg.title,
    tip: cfg.tip,
    hasPhone: !!cfg.phone,
    showPhone: cfg.showPhone,
    phone: cfg.phone ? maskPhone(cfg.phone) : '',
    rawPhone: cfg.phone || '',
    cooldown: cfg.cooldown,
    ttl: cfg.ttl,
    serverNow: Date.now(),
    configured: barkKeys(cfg).length > 0,
  };
}

async function handleRequest(request, env) {
  const cfg = getConfig(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/healthz') {
    return jsonResponse({ ok: true, ts: Date.now(), configured: barkKeys(cfg).length > 0 });
  }
  if (path === '/api/config') {
    return jsonResponse(publicConfig(cfg));
  }
  if (path === '/api/notify') {
    return handleNotify(request, cfg, clientIp(request));
  }
  if (path === '/' || path === '/index.html') {
    return new Response(renderPage(cfg), {
      headers: {
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }
  return jsonResponse({ ok: false, code: 'NOT_FOUND' }, 404);
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

/**
 * 页面骨架。
 *
 * 这里刻意只输出「骨架 + 内联配置」，具体内容交给 CLIENT_JS 渲染，原因是：
 *   1. 服务端渲染（functions/index.js）时内联配置已带真实值，首屏无闪烁；
 *   2. 纯静态部署（根目录 index.html）时内联配置是构建期烘焙的默认值，
 *      客户端会再拉一次 /api/config 校正 —— 同一份代码因此可以在
 *      「有边缘函数」和「只有静态托管」两种环境下都正常工作。
 */
/**
 * 页面骨架。
 *
 * 这里刻意只输出「骨架 + 内联配置」，具体内容交给 CLIENT_JS 渲染，原因是：
 *   1. 服务端渲染（functions/index.js）时内联配置已带真实值，首屏无闪烁；
 *   2. 纯静态部署（根目录 index.html）时内联配置是构建期烘焙的默认值，
 *      客户端会再拉一次 /api/config 校正 —— 同一份代码因此可以在
 *      「有边缘函数」和「只有静态托管」两种环境下都正常工作。
 */
function renderPage(cfg) {
  const ready = barkKeys(cfg).length > 0;

  const inlineCfg = JSON.stringify({
    title: cfg.title,
    tip: cfg.tip,
    plate: cfg.plate,
    phone: cfg.phone,
    phoneDisplay: cfg.phone ? maskPhone(cfg.phone) : '',
    showPhone: cfg.showPhone,
    cooldown: cfg.cooldown,
    ttl: cfg.ttl,
    ready: ready,
  }).replace(/</g, '\\u003c');

  return (
    '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<meta name="theme-color" content="#f4f6fb" media="(prefers-color-scheme: light)">\n' +
    '<meta name="theme-color" content="#0f1420" media="(prefers-color-scheme: dark)">\n' +
    '<meta name="format-detection" content="telephone=no">\n' +
    '<title>' +
    escapeHtml(cfg.title) +
    '</title>\n' +
    '<style>' +
    CSS +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<main class="card">\n' +
    '  <div class="brand"><span class="brand-icon">' +
    CAR_SVG +
    '</span><h1 class="brand-text" id="mcTitle">' +
    escapeHtml(cfg.title) +
    '</h1></div>\n' +
    '  <div id="mcPlate"></div>\n' +
    '  <p class="tip" id="mcTip">' +
    escapeHtml(cfg.tip) +
    '</p>\n' +
    '  <div id="mcWarn"></div>\n' +
    '  <div class="actions">\n' +
    '    <button id="btnNotify" class="btn btn-primary" type="button">\n' +
    '      <span class="spinner" aria-hidden="true"></span>\n' +
    '      <span id="btnText">通知车主挪车</span>\n' +
    '    </button>\n' +
    '    <div id="mcCall"></div>\n' +
    '  </div>\n' +
    '  <div id="status" class="status" role="status" aria-live="polite"></div>\n' +
    '  <p class="ttl" id="mcTtl" hidden></p>\n' +
    '  <p class="foot">通知将以 Bark 推送直达车主手机 · 不会透露您的联系方式</p>\n' +
    '</main>\n' +
    '<script id="mc-cfg" type="application/json">' +
    inlineCfg +
    '</script>\n' +
    '<script>' +
    CLIENT_JS +
    '</script>\n' +
    '</body>\n' +
    '</html>'
  );
}

const CAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>';

const CSS = [
  '*,*::before,*::after{box-sizing:border-box}',
  ':root{--bg1:#eef2fb;--bg2:#f7f8fc;--bg3:#eaf1ff;--card:#fff;--text:#141a26;--muted:#667085;',
  '--line:#e6eaf2;--ghost:#f2f5fb;--brand:#1f6feb;--ok:#16a34a;--err:#dc2626;--code:rgba(0,0,0,.06);',
  '--warn-bg:#fff7ed;--warn-line:#fed7aa;--warn-text:#92400e;',
  '--shadow:0 12px 32px rgba(20,26,38,.10),0 2px 6px rgba(20,26,38,.05)}',
  '@media (prefers-color-scheme:dark){:root{--bg1:#0f1420;--bg2:#131a28;--bg3:#101827;--card:#171f2e;',
  '--text:#e9edf6;--muted:#98a2b3;--line:#27324a;--ghost:#1e2739;--brand:#5b9bff;--ok:#22c55e;--err:#f87171;',
  '--code:rgba(255,255,255,.1);--warn-bg:#3a2a13;--warn-line:#5c441f;--warn-text:#f3c98b;',
  '--shadow:0 12px 32px rgba(0,0,0,.35)}}',
  'html{-webkit-text-size-adjust:100%;color-scheme:light dark}',
  'body{margin:0;padding:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;',
  'padding:clamp(16px,5vw,40px) clamp(14px,4.5vw,24px) calc(clamp(16px,5vw,40px) + env(safe-area-inset-bottom));',
  'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;',
  'color:var(--text);background:linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 45%,var(--bg3) 100%);',
  '-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}',
  '.card{width:100%;max-width:min(420px,100%);background:var(--card);border-radius:clamp(16px,4.5vw,22px);',
  'padding:clamp(22px,6.5vw,34px) clamp(18px,5.5vw,28px) clamp(18px,5vw,26px);box-shadow:var(--shadow);',
  'animation:rise .36s cubic-bezier(.2,.7,.3,1) both}',
  '@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
  '.brand{display:flex;align-items:center;justify-content:center;gap:10px;text-align:center}',
  '.brand-icon{display:flex;flex:none}',
  '.brand-icon svg{width:clamp(24px,7vw,30px);height:clamp(24px,7vw,30px);fill:var(--brand)}',
  '.brand-text{margin:0;font-size:clamp(18px,5.4vw,22px);font-weight:700;letter-spacing:.5px;line-height:1.35}',
  '.plate{margin-top:clamp(14px,4vw,18px);display:flex;align-items:center;justify-content:center;gap:10px;',
  'background:linear-gradient(135deg,var(--brand),#3b82f6);border-radius:14px;',
  'padding:clamp(10px,3vw,14px) clamp(14px,4vw,18px);color:#fff}',
  '.plate-tag{font-size:clamp(11px,3vw,12.5px);opacity:.88;background:rgba(255,255,255,.2);border-radius:6px;padding:3px 8px}',
  '.plate-no{font-size:clamp(17px,5vw,20px);font-weight:700;letter-spacing:2px}',
  '.tip{margin:clamp(12px,3.5vw,16px) 0 0;font-size:clamp(13px,3.7vw,15px);line-height:1.65;color:var(--muted);text-align:center}',
  '.warn{margin-top:14px;font-size:clamp(12px,3.4vw,13.5px);line-height:1.6;color:var(--warn-text);',
  'background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:12px;padding:10px 12px;text-align:left}',
  '.warn code{background:var(--code);border-radius:4px;padding:1px 5px;font-size:.92em}',
  '.actions{margin-top:clamp(18px,5vw,24px)}',
  '.btn{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;width:100%;',
  'min-height:clamp(48px,13vw,56px);border:0;border-radius:14px;padding:10px 16px;font-family:inherit;',
  'font-size:clamp(15px,4.3vw,17px);font-weight:700;color:#fff;text-decoration:none;cursor:pointer;',
  'transition:transform .14s ease,opacity .2s ease,background-color .2s ease,box-shadow .2s ease;touch-action:manipulation}',
  '.btn+.btn{margin-top:12px}',
  '.btn svg{width:clamp(18px,5vw,20px);height:clamp(18px,5vw,20px);fill:currentColor;flex:none}',
  '.btn small{flex-basis:100%;font-size:clamp(10.5px,3vw,12px);font-weight:400;opacity:.78;letter-spacing:.3px}',
  '.btn-primary{background:linear-gradient(135deg,#22c55e,#16a34a);box-shadow:0 8px 20px rgba(22,163,74,.26)}',
  '.btn-ghost{background:var(--ghost);color:var(--brand);box-shadow:none}',
  '.btn:focus-visible{outline:3px solid rgba(31,111,235,.45);outline-offset:2px}',
  '.btn:active:not([disabled]):not(.is-disabled){transform:scale(.975)}',
  '.btn[disabled],.btn.is-disabled{opacity:.5;cursor:not-allowed;pointer-events:none}',
  '.spinner{display:none;width:16px;height:16px;flex:none;border:2px solid rgba(255,255,255,.45);',
  'border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}',
  '.is-loading .spinner{display:block}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '.status{margin-top:clamp(12px,3.5vw,16px);min-height:1.4em;font-size:clamp(13px,3.6vw,14.5px);',
  'line-height:1.6;text-align:center;color:var(--muted);transition:color .2s ease}',
  '.status.ok{color:var(--ok)}',
  '.status.err{color:var(--err)}',
  '.ttl{display:flex;align-items:center;justify-content:center;gap:7px;margin:clamp(14px,4vw,18px) 0 0;',
  'font-size:clamp(11.5px,3.3vw,13px);color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.2px}',
  '.ttl-dot{width:6px;height:6px;border-radius:50%;background:var(--ok);flex:none;animation:pulse 2s ease-in-out infinite}',
  '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '.ttl.is-urgent{color:#b45309}',
  '.ttl.is-urgent .ttl-dot{background:#f59e0b}',
  '.ttl.is-expired{color:var(--err)}',
  '.ttl.is-expired .ttl-dot{background:var(--err);animation:none}',
  '.foot{margin:clamp(14px,4vw,18px) 0 0;font-size:clamp(11px,3.1vw,12.5px);color:var(--muted);opacity:.85;',
  'text-align:center;line-height:1.6}',
  '@media (max-width:360px){.card{padding:20px 14px 16px}}',
  '@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}',
].join('');

const CLIENT_JS = [
  '(function(){',
  'function el(id){return document.getElementById(id)||{style:{},classList:{add:function(){},remove:function(){}}};}',
  'function esc(s){return String(s==null?"":""+s).replace(/[&<>]/g,function(c){return c==="&"?"&amp;":(c==="<"?"&lt;":"&gt;");});}',
  'function tickMs(){return (window.performance&&performance.now)?performance.now():Date.now();}',
  'var cfg={title:"",tip:"",plate:"",phone:"",phoneDisplay:"",showPhone:false,cooldown:60,ttl:300,ready:true};',
  'try{var rawEl=document.getElementById("mc-cfg");var raw=JSON.parse((rawEl&&rawEl.textContent)||"{}");for(var k in raw){if(Object.prototype.hasOwnProperty.call(raw,k))cfg[k]=raw[k];}}catch(e){}',
  'var PHONE_SVG=\'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8c1.2 2.4 3.2 4.4 5.6 5.6l2.1-2.1c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1l-2.3 2.1z"/></svg>\';',
  'var btn=el("btnNotify"),btnText=el("btnText"),statusEl=el("status"),ttlEl=el("mcTtl");',
  'var STORE="mc_notify_until",timer=null,ttlTimer=null,apiState="pending",expired=false;',
  // 用 performance.now() 单调计时，避免用户改系统时间绕过有效期
  'var T0=tickMs();',
  'function setStatus(t,c){statusEl.textContent=t||"";statusEl.className="status"+(c?" "+c:"");}',
  'function until(){try{return parseInt(localStorage.getItem(STORE)||"0",10);}catch(e){return 0;}}',
  'function lock(sec){try{localStorage.setItem(STORE,String(Date.now()+sec*1000));}catch(e){}startTick();}',
  'function startTick(){',
  '  if(timer){clearInterval(timer);timer=null;}',
  '  var check=function(){',
  '    var left=Math.ceil((until()-Date.now())/1000);',
  '    if(left<=0){if(timer){clearInterval(timer);timer=null;}if(!expired){btn.disabled=false;btn.classList.remove("is-loading");btnText.textContent="通知车主挪车";if(!statusEl.textContent)setStatus("");}return false;}',
  '    btn.disabled=true;btn.classList.remove("is-loading");btnText.textContent="请等待 "+left+" 秒";return true;',
  '  };',
  '  if(check()){timer=setInterval(check,1000);}',
  '}',
  'function leftSec(){if(!cfg.ttl)return -1;return Math.max(0,Math.ceil((cfg.ttl-(tickMs()-T0)/1000)));}',
  'function expire(){',
  '  if(expired)return;',
  '  expired=true;',
  '  if(ttlTimer){clearInterval(ttlTimer);ttlTimer=null;}',
  '  if(timer){clearInterval(timer);timer=null;}',
  '  btn.disabled=true;btn.classList.remove("is-loading");btnText.textContent="通知车主挪车";',
  '  var a=document.querySelector("#mcCall a");if(a){a.classList.add("is-disabled");a.removeAttribute("href");}',
  '  setStatus("页面已超过有效时间，请重新扫码访问","err");',
  '  ttlEl.hidden=false;ttlEl.className="ttl is-expired";ttlEl.innerHTML=\'<span class="ttl-dot"></span>链接已失效 · 请重新扫码打开\';',
  '}',
  'function renderTtl(){',
  '  if(expired)return;',
  '  if(!cfg.ttl){ttlEl.hidden=true;if(ttlTimer){clearInterval(ttlTimer);ttlTimer=null;}return;}',
  '  var s=leftSec();',
  '  if(s<=0){expire();return;}',
  '  ttlEl.hidden=false;',
  '  var m=Math.floor(s/60),r=s%60;',
  '  var txt=m>0?(m+" 分 "+r+" 秒"):(r+" 秒");',
  '  ttlEl.className="ttl"+(s<=60?" is-urgent":"");',
  '  ttlEl.innerHTML=\'<span class="ttl-dot"></span>页面有效时间剩余 \'+txt;',
  '}',
  'function startTtl(){',
  '  if(ttlTimer){clearInterval(ttlTimer);ttlTimer=null;}',
  '  renderTtl();',
  '  if(!expired&&cfg.ttl){ttlTimer=setInterval(renderTtl,1000);}',
  '}',
  'function render(){',
  '  var t=cfg.title||"通知车主挪车";',
  '  document.title=t;',
  '  el("mcTitle").textContent=t;',
  '  el("mcTip").textContent=cfg.tip||"";',
  '  el("mcPlate").innerHTML=cfg.plate?\'<div class="plate"><span class="plate-tag">车辆</span><span class="plate-no">\'+esc(cfg.plate)+"</span></div>":"";',
  // 拨号按钮只写「拨打车主电话」，不显示号码；SHOW_PHONE=1 时才以小字附脱敏号码
  '  el("mcCall").innerHTML=cfg.phone?\'<a class="btn btn-ghost" href="tel:\'+esc(cfg.phone)+\'">\'+PHONE_SVG+"<span>拨打车主电话</span>"+(cfg.showPhone?"<small>"+esc(cfg.phoneDisplay||cfg.phone)+"</small>":"")+"</a>":"";',
  '  var w="";',
  '  if(apiState==="fail"){w=\'<div class="warn">未检测到服务端接口 <code>/api/config</code>。推送需要随站点一起部署边缘函数（<code>edge-functions/</code> 或 <code>functions/</code> 目录）。</div>\';}',
  '  else if(apiState==="ok"&&!cfg.ready){w=\'<div class="warn">服务端尚未配置 <code>BARK_KEY</code>，推送功能不可用。请在 EdgeOne 控制台「环境变量」中添加后重新部署。</div>\';}',
  '  el("mcWarn").innerHTML=w;',
  '}',
  'function applyCfg(d){',
  '  if(typeof d.plate==="string")cfg.plate=d.plate;',
  '  if(d.title)cfg.title=d.title;',
  '  if(d.tip)cfg.tip=d.tip;',
  '  if(d.rawPhone)cfg.phone=d.rawPhone;',
  '  if(d.phone)cfg.phoneDisplay=d.phone;',
  '  if(typeof d.showPhone==="boolean")cfg.showPhone=d.showPhone;',
  '  if(d.cooldown!==undefined&&d.cooldown!==null)cfg.cooldown=parseInt(d.cooldown,10)||0;',
  '  if(d.ttl!==undefined&&d.ttl!==null)cfg.ttl=parseInt(d.ttl,10)||0;',
  '  cfg.ready=d.configured!==false;',
  '}',
  'function buzz(ms){try{if(navigator&&navigator.vibrate)navigator.vibrate(ms);}catch(e){}}',
  'btn.addEventListener("click",function(){',
  '  if(expired){setStatus("页面已超过有效时间，请重新扫码访问","err");return;}',
  '  if(btn.disabled)return;',
  '  btn.disabled=true;btn.classList.add("is-loading");btnText.textContent="正在发送…";setStatus("");',
  '  fetch("/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})',
  '  .then(function(r){var ct=(r.headers.get("content-type")||"").toLowerCase();if(ct.indexOf("json")<0){var e=new Error("NO_API");e.noapi=true;throw e;}return r.json().then(function(d){return {status:r.status,data:d||{}};});})',
  '  .then(function(res){',
  '    var d=res.data,cd=parseInt(d.cooldown||cfg.cooldown||60,10);',
  '    if(d.ok){setStatus("已通知车主，请稍等片刻","ok");buzz(14);lock(cd);return;}',
  '    btn.classList.remove("is-loading");btn.disabled=false;btnText.textContent="通知车主挪车";buzz(28);',
  '    if(d.code==="COOLDOWN"||d.code==="LIMIT"){setStatus("发送太频繁了，"+(d.retryAfter||60)+" 秒后再试","err");lock(d.retryAfter||cd);}',
  '    else{setStatus("发送失败："+(d.message||("错误 "+(d.code||res.status))),"err");}',
  '  })',
  '  .catch(function(err){btn.classList.remove("is-loading");btn.disabled=false;btnText.textContent="通知车主挪车";buzz(28);setStatus(err&&err.noapi?"推送接口未部署或不可用，请检查边缘函数是否随站点部署":"网络异常，请稍后重试","err");});',
  '});',
  'fetch("/api/config",{headers:{"Accept":"application/json"}})',
  '  .then(function(r){var ct=(r.headers.get("content-type")||"").toLowerCase();if(!r.ok||ct.indexOf("json")<0)throw new Error("NO_API");return r.json();})',
  '  .then(function(d){if(!d||d.ok!==true)throw new Error("BAD");applyCfg(d);apiState="ok";render();})',
  '  .catch(function(){apiState="fail";render();});',
  'render();',
  'startTick();',
  'startTtl();',
  'document.addEventListener("visibilitychange",function(){if(!document.hidden)renderTtl();});',
  '})();',
].join('\n');

/* 导出（打包脚本会剥离 export，生成 EdgeOne 单文件版本） */

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
