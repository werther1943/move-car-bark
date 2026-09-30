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
  SHOW_PHONE: '0', // 1 = 页面上明文显示电话号码，0 = 脱敏显示
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

  let payload = {};
  try {
    payload = await request.json();
  } catch (e) {
    payload = {};
  }

  const visitorPlate = String(payload.plate || '').slice(0, 16).trim();
  const message = String(payload.msg || '').slice(0, 60).trim();

  const title = cfg.plate ? '挪车提醒 · ' + cfg.plate : '挪车提醒';
  const lines = ['有朋友需要您挪车，请尽快处理。'];
  if (cfg.plate) lines.push('您的车辆：' + cfg.plate);
  if (visitorPlate) lines.push('对方车牌：' + visitorPlate);
  if (message) lines.push('对方留言：' + message);
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
    phone: cfg.phone ? (cfg.showPhone ? cfg.phone : maskPhone(cfg.phone)) : '',
    rawPhone: cfg.showPhone && cfg.phone ? cfg.phone : '',
    cooldown: cfg.cooldown,
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

function renderPage(cfg) {
  const ready = barkKeys(cfg).length > 0;
  const phoneHref = cfg.phone ? 'tel:' + cfg.phone : '';
  const phoneText = cfg.phone ? (cfg.showPhone ? cfg.phone : maskPhone(cfg.phone)) : '';

  const plateBlock = cfg.plate
    ? '<div class="plate"><span class="plate-tag">车辆</span><span class="plate-no">' +
      escapeHtml(cfg.plate) +
      '</span></div>'
    : '';

  const callBlock = cfg.phone
    ? '<a class="btn btn-ghost" href="' +
      escapeHtml(phoneHref) +
      '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8c1.2 2.4 3.2 4.4 5.6 5.6l2.1-2.1c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1l-2.3 2.1z"/></svg><span>拨打车主电话 ' +
      escapeHtml(phoneText) +
      '</span></a>'
    : '';

  const warnBlock = ready
    ? ''
    : '<div class="warn">服务端尚未配置 <code>BARK_KEY</code>，推送功能不可用。请在 EdgeOne 控制台的「环境变量」中添加后重新部署。</div>';

  const inlineCfg = JSON.stringify({
    plate: cfg.plate,
    hasPhone: !!cfg.phone,
    cooldown: cfg.cooldown,
    ready: ready,
  }).replace(/</g, '\\u003c');

  return (
    '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<meta name="theme-color" content="#f4f6fb">\n' +
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
    '  <div class="brand"><span class="brand-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg></span>' +
    escapeHtml(cfg.title) +
    '</div>\n' +
    plateBlock +
    '  <p class="tip">' +
    escapeHtml(cfg.tip) +
    '</p>\n' +
    warnBlock +
    '  <div class="field">\n' +
    '    <label for="vPlate">您的车牌号<span>选填</span></label>\n' +
    '    <input id="vPlate" type="text" maxlength="12" autocomplete="off" placeholder="如：粤B12345">\n' +
    '  </div>\n' +
    '  <div class="field">\n' +
    '    <label for="vMsg">留言<span>选填</span></label>\n' +
    '    <input id="vMsg" type="text" maxlength="40" autocomplete="off" placeholder="如：您的车挡住车库出口了">\n' +
    '  </div>\n' +
    '  <button id="btnNotify" class="btn btn-primary" type="button">\n' +
    '    <span class="spinner" aria-hidden="true"></span>\n' +
    '    <span id="btnText">通知车主挪车</span>\n' +
    '  </button>\n' +
    callBlock +
    '  <div id="status" class="status" role="status" aria-live="polite"></div>\n' +
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

const CSS = [
  '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}',
  'html,body{min-height:100%}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
  'background:linear-gradient(160deg,#eef2fb 0%,#f7f8fc 45%,#eaf1ff 100%);color:#1c2333;',
  'display:flex;align-items:center;justify-content:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}',
  '.card{width:100%;max-width:400px;background:#fff;border-radius:20px;padding:28px 22px 22px;',
  'box-shadow:0 10px 30px rgba(28,35,51,.08),0 2px 6px rgba(28,35,51,.04)}',
  '.brand{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:700;letter-spacing:.5px}',
  '.brand-icon{display:flex;align-items:center}',
  '.brand-icon svg{width:28px;height:28px;fill:#1f6feb}',
  '.plate{margin-top:16px;display:flex;align-items:center;gap:10px;background:linear-gradient(135deg,#1f6feb,#3b82f6);',
  'border-radius:14px;padding:12px 16px;color:#fff}',
  '.plate-tag{font-size:12px;opacity:.85;background:rgba(255,255,255,.18);border-radius:6px;padding:3px 8px}',
  '.plate-no{font-size:19px;font-weight:700;letter-spacing:2px}',
  '.tip{margin-top:12px;font-size:14px;line-height:1.6;color:#667085}',
  '.warn{margin-top:14px;font-size:13px;line-height:1.6;color:#92400e;background:#fff7ed;border:1px solid #fed7aa;',
  'border-radius:10px;padding:10px 12px}',
  '.warn code{background:#feebc8;border-radius:4px;padding:1px 5px;font-size:12px}',
  '.field{margin-top:16px}',
  '.field label{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:#475467;margin-bottom:7px;font-weight:600}',
  '.field label span{font-weight:400;color:#98a2b3;font-size:12px}',
  '.field input{width:100%;height:46px;border:1px solid #dfe3ec;border-radius:12px;padding:0 14px;font-size:16px;',
  'color:#1c2333;background:#fbfcfe;outline:none;transition:border-color .2s,box-shadow .2s}',
  '.field input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.14);background:#fff}',
  '.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:52px;margin-top:14px;',
  'border:none;border-radius:14px;font-size:17px;font-weight:700;cursor:pointer;',
  'transition:transform .12s,background .2s,box-shadow .2s;text-decoration:none}',
  '.btn:active{transform:scale(.985)}',
  '.btn-primary{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 6px 16px rgba(22,163,74,.28)}',
  '.btn-primary:hover{background:linear-gradient(135deg,#16a34a,#15803d)}',
  '.btn-primary[disabled]{background:#c8cdd8;box-shadow:none;cursor:not-allowed}',
  '.btn-ghost{background:#f2f5fb;color:#1f6feb}',
  '.btn-ghost:hover{background:#e8eefb}',
  '.btn svg{width:20px;height:20px;fill:currentColor}',
  '.spinner{display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;',
  'border-radius:50%;animation:spin .7s linear infinite}',
  '.is-loading .spinner{display:block}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '.status{margin-top:14px;min-height:20px;font-size:14px;line-height:1.6;text-align:center;color:#667085}',
  '.status.ok{color:#15803d}.status.err{color:#dc2626}',
  '.foot{margin-top:18px;font-size:12px;color:#98a2b3;text-align:center;line-height:1.6}',
  '@media (max-width:360px){.card{padding:22px 16px 18px}}',
].join('');

const CLIENT_JS = [
  "(function(){",
  "var cfg={plate:'',hasPhone:false,cooldown:60,ready:true};",
  "try{cfg=JSON.parse(document.getElementById('mc-cfg').textContent||'{}')}catch(e){}",
  "var btn=document.getElementById('btnNotify');",
  "var btnText=document.getElementById('btnText');",
  "var statusEl=document.getElementById('status');",
  "var plateEl=document.getElementById('vPlate');",
  "var msgEl=document.getElementById('vMsg');",
  "var STORE='mc_notify_until';",
  "var timer=null;",
  "function setStatus(text,cls){statusEl.textContent=text||'';statusEl.className='status'+(cls?' '+cls:'');}",
  "function until(){try{return parseInt(localStorage.getItem(STORE)||'0',10)}catch(e){return 0}}",
  "function lock(sec){try{localStorage.setItem(STORE,String(Date.now()+sec*1000))}catch(e){}startTick();}",
  "function startTick(){",
  "  if(timer)clearInterval(timer);",
  "  timer=setInterval(function(){",
  "    var left=Math.ceil((until()-Date.now())/1000);",
  "    if(left<=0){clearInterval(timer);timer=null;btn.disabled=false;btn.classList.remove('is-loading');btnText.textContent='通知车主挪车';setStatus('');return;}",
  "    btn.disabled=true;btnText.textContent='请等待 '+left+' 秒';",
  "  },1000);",
  "  var left0=Math.ceil((until()-Date.now())/1000);",
  "  if(left0>0){btn.disabled=true;btnText.textContent='请等待 '+left0+' 秒';}",
  "}",
  "btn.addEventListener('click',function(){",
  "  if(!cfg.ready){setStatus('服务未配置 Bark 推送，请联系车主','err');return;}",
  "  if(btn.disabled)return;",
  "  btn.disabled=true;btn.classList.add('is-loading');btnText.textContent='正在发送…';setStatus('');",
  "  fetch('/api/notify',{method:'POST',headers:{'Content-Type':'application/json'},",
  "    body:JSON.stringify({plate:plateEl.value,msg:msgEl.value})})",
  "  .then(function(r){return r.json().then(function(d){return {status:r.status,data:d}})})",
  "  .then(function(res){",
  "    var d=res.data||{};var cd=parseInt(d.cooldown||cfg.cooldown||60,10);",
  "    if(d.ok){setStatus('\u5df2\u901a\u77e5\u8f66\u4e3b\uff0c\u8bf7\u7a0d\u7b49\u7247\u523b','ok');lock(cd);}",
  "    else{btn.classList.remove('is-loading');btn.disabled=false;btnText.textContent='通知车主挪车';",
  "      var t=(d.code==='COOLDOWN'||d.code==='LIMIT')?('发送太频繁了，'+ (d.retryAfter||60) +' 秒后再试'):('发送失败：'+(d.message||'请稍后重试'));",
  "      setStatus(t,'err');if(d.code==='COOLDOWN'||d.code==='LIMIT')lock(d.retryAfter||cd);}",
  "  })",
  "  .catch(function(){btn.classList.remove('is-loading');btn.disabled=false;btnText.textContent='通知车主挪车';setStatus('网络异常，请稍后重试','err');});",
  "});",
  "startTick();",
  "})();",
].join('\n');

/* 导出（打包脚本会剥离 export，生成 EdgeOne 单文件版本） */
export { handleRequest, getConfig, sendBark, renderPage };
