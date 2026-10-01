# move-car-bark

把「挪车二维码」做成一个跑在**腾讯云 EdgeOne 边缘函数**上的单文件 Worker：扫码打开一个 H5 页面，访客点一下按钮，车主的 iPhone 就会收到 **Bark 推送**，也可以直接一键拨打车主电话。全程不需要服务器、不需要域名备案以外的额外资源。

原型来自吾爱破解的[《自用挪车二维码，免服务器，可微信通知，可拨打电话》](https://www.52pojie.cn/forum.php?mod=viewthread&tid=1979717)，本仓库在其基础上做了重写与增强。

## 和原版的区别

| 项目 | 原版（WxPusher） | 本项目（Bark） |
| --- | --- | --- |
| 推送通道 | WxPusher 微信公众号 | Bark（iPhone 原生推送，秒达、可穿透专注模式） |
| 密钥位置 | 写在前端 JS 里，查看源码即可拿到 | 只存在于边缘函数环境变量，浏览器拿不到 |
| 推送发起方 | 浏览器直连第三方 API | 边缘函数代理（`/api/notify`） |
| 防刷 | 无 | 同源校验 + IP 冷却 + 每小时次数上限（双层，前端也做倒计时） |
| 车主电话 | 明文写在页面 | 拨号按钮只写「拨打车主电话」，不显示号码 |
| 页面时效 | 无 | 默认 5 分钟有效，到期按钮失效需重新扫码 |
| 附加信息 | 固定一句话 | 时间、来源 IP 与设备（iOS/微信 这类） |
| 多车主 | 多个 UID | 多个 `device_key`，逗号分隔即可 |

## 页面效果

- **响应式**：卡片宽度 `min(420px, 100%)`，字号、间距、圆角全部用 `clamp()` 随视口平滑缩放，从 iPhone SE 到平板都不会溢出
- **居中布局**：内容居中，底部预留 `env(safe-area-inset-bottom)`，避免被 iPhone 手势条遮挡
- 深色模式自动适配（`prefers-color-scheme`），并遵循 `prefers-reduced-motion` 关闭动画
- 顶部显示车牌（配置了 `PLATE` 时出现蓝色车牌条）
- 绿色主按钮「通知车主挪车」，带 loading 态、按压反馈与冷却倒计时
- 配置了 `OWNER_PHONE` 时出现「拨打车主电话」按钮，**按钮上不显示号码**
- 页面底部有**有效时间倒计时**（默认 5 分钟），最后 1 分钟变橙，归零后按钮与拨号链接一起失效并提示重新扫码
- 适配微信 / 支付宝 / Safari 内置浏览器

推送到 Bark 的内容示例：

```
标题：挪车提醒 · 京A·12345
正文：有朋友需要您挪车，请尽快处理。
      您的车辆：京A·12345
      时间：2026-09-30 22:57:07 周三
      来源：223.104.x.x · iOS · 微信
```

## 目录结构

```
move-car-bark/
├── index.html                    # 根目录静态页 —— 保证站点「存在」，任何托管都能打开
├── worker.js                     # 单文件版：整段粘贴到 EdgeOne「边缘函数」编辑器
├── src/app.js                    # 源码（页面渲染 + 路由 + Bark 推送 + 限流）
├── edge-functions/               # EdgeOne Makers（*.edgeone.dev）
│   ├── index.js                  #   → /
│   ├── api/[[default]].js        #   → /api/notify、/api/config
│   └── healthz.js                #   → /healthz
├── functions/                    # EdgeOne Pages Functions（国际站）
├── node-functions/               # EdgeOne Pages Node Functions（国内站）
├── scripts/
│   ├── build-worker.js           # src/app.js → 上面所有产物
│   └── dev.js                    # 本地预览（Node 内置 http，零依赖）
├── .env.example                  # 配置模板
├── package.json
├── LICENSE                       # MIT
└── docs/DEPLOY.md                # 详细部署步骤与排错
```

三个函数目录内容完全一样，平台只认自己那一个（Makers 读 `edge-functions/`、Pages 国际站读 `functions/`、Pages 国内站读 `node-functions/`），用不到的可以直接删掉。

所有产物都是**自包含**的（核心逻辑已内联），不存在跨文件 import，避免 Pages 构建时打包失败。改代码只改 `src/app.js`，然后 `npm run build` 重新生成。

> 重要：EdgeOne Pages / Makers 的边缘函数**不支持 `addEventListener('fetch')`**（那是「边缘函数」独立产品 / Cloudflare 的写法），必须用 `export async function onRequest(context)`。本项目的产物已按官方 Function Handlers 规范生成。

## 快速开始（方式一：EdgeOne 边缘函数，推荐）

1. 手机上安装 **Bark**（App Store），打开 App 首页复制 **device_key**（形如 `AbCdEfGhIjKlMnOp`）。
2. 打开 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) → **边缘函数** → 新建函数，随便起个名字（如 `move-car`），直接部署默认模板。
3. 进入函数 → **代码编辑器**，把默认代码全部删掉，粘贴本仓库 [`worker.js`](./worker.js) 的全部内容。
4. 切到 **环境变量** 页签，新增变量：
   - `BARK_KEY` = 第 1 步复制的 key（多个车主用英文逗号分隔）
   - `OWNER_PHONE` = 车主手机号（可选，加了才有拨号按钮）
   - `PLATE` = 车牌号（可选，如 `京A·12345`）
   其余变量都有默认值，需要时再覆盖。
5. 点 **部署**，然后在 **触发规则** 里配一条匹配规则（例如 `/*` 或 `/move-car/*`），用绑定的域名访问即可看到页面。
6. 把访问地址用草料二维码等工具生成二维码，打印贴在挡风玻璃上。

> 域名建议用已备案且开启 HTTPS 的域名，否则微信扫码可能会被拦截。

## 快速开始（方式二：EdgeOne Pages / Makers）

把仓库推到 GitHub 后，在 EdgeOne Pages 里「导入 Git 仓库」（或直接上传整个文件夹）：

- 框架预设：无 / Other
- 构建命令：留空
- 输出目录：`.`（根目录，里面有 `index.html`）
- 环境变量里添加 `BARK_KEY` 等配置，然后部署

平台会按函数目录结构自动生成路由：

| 文件 | 路由 |
| --- | --- |
| `*/index.js` | `/` |
| `*/api/[[default]].js` | `/api/notify`、`/api/config` |
| `*/healthz.js` | `/healthz` |

根目录的 `index.html` 是纯静态页，作用是**保证站点一定存在**——即使函数没被平台识别，扫码也能打开页面（此时页面顶部会提示接口未部署）。页面加载后会请求 `/api/config` 拿到车牌与电话，点按钮走 `/api/notify` 由边缘函数发推送。

这种方式不需要 `worker.js`。

> 注意：`*.edgeone.dev` 这类默认域名属于**预览链接**，带访问鉴权（`?eo_token=`）且会过期，链接过期后访问会返回 401 `Authentication Expired`；项目不存在或未部署成功时返回 404 `The site does not exist`。正式使用请绑定自己的已备案域名。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `BARK_KEY` | 是 | — | Bark device_key，多个用英文逗号分隔 |
| `BARK_SERVER` | 否 | `https://api.day.app` | 自建 Bark 服务时填自己的域名 |
| `BARK_LEVEL` | 否 | `timeSensitive` | `active` / `timeSensitive` / `critical` / `passive` |
| `BARK_GROUP` | 否 | `挪车提醒` | Bark App 内的分组 |
| `BARK_ICON` | 否 | 空 | 推送图标的 https 图片地址 |
| `BARK_SOUND` | 否 | 空 | 提示音，如 `alarm`、`bell` |
| `BARK_ARCHIVE` | 否 | `1` | `1` 存档 / `0` 不存档 |
| `OWNER_PHONE` | 否 | 空 | 车主电话，配置后出现拨号按钮（按钮上不显示号码） |
| `PLATE` | 否 | 空 | 页面展示的车牌号 |
| `PAGE_TITLE` | 否 | `通知车主挪车` | 页面标题 |
| `PAGE_TIP` | 否 | 见源码 | 页面副标题 |
| `SHOW_PHONE` | 否 | `0` | `1` = 拨号按钮下方以小字附一行脱敏号码，`0` = 完全不显示 |
| `PAGE_TTL` | 否 | `300` | 页面有效时间（秒），`0` = 不限时 |
| `COOLDOWN` | 否 | `60` | 同一 IP 两次推送之间的冷却秒数 |
| `MAX_PER_HOUR` | 否 | `5` | 同一 IP 每小时最多推送次数 |
| `TIMEZONE_OFFSET` | 否 | `8` | 推送时间的时区偏移（中国填 8） |

除了环境变量，也可以直接改 `src/app.js`（或 `worker.js`）顶部的 `HARD_CODE` 常量——**环境变量优先级更高**。

## 本地预览

```bash
cp .env.example .env      # 填入自己的配置
npm run dev               # 打开 http://localhost:8787
```

本地预览刻意复刻线上形态：`/` 返回根目录静态 `index.html`，`/api/*` 走边缘函数；想看服务端渲染版访问 `/ssr`。

改完 `src/app.js` 后重新生成全部产物：

```bash
npm run build                    # 生成 worker.js + 三个函数目录 + index.html
BAKE_CONFIG=1 npm run build      # 额外把 .env 里的车牌/电话烘焙进 index.html
```

`index.html` 默认不含任何个人信息；如果你做的是**纯静态部署**（完全没有边缘函数），才需要用 `BAKE_CONFIG=1` 把车牌和电话写进去。

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET | 挪车页面 |
| `/api/notify` | POST | 发送 Bark 推送，无需请求体（发 `{}` 即可） |
| `/api/config` | GET | 返回页面需要的非敏感配置（`plate`、`phone`、`ttl`、`serverNow` 等） |
| `/healthz` | GET | 健康检查，返回 `{"ok":true,"configured":true}` |

`/api/notify` 的响应：`{"ok":true,"code":"OK","cooldown":60}`；被限流时返回 HTTP 429 与 `{"ok":false,"code":"COOLDOWN","retryAfter":42}`。

### 关于页面有效时间（`PAGE_TTL`）

- 计时从**页面打开**那一刻开始，用 `performance.now()` 单调递增计时，用户改手机系统时间绕不过去。
- 到期后推送按钮和拨号链接一起失效，页面提示「请重新扫码打开」——重新访问（刷新 / 重新扫码）会重新计时。
- 这是**客户端**层面的限制，用来避免二维码被拍照传播后被反复触发；真正的防刷仍然依赖服务端的 IP 冷却与每小时上限。
- 想要服务端强制校验就得给链接加签名（例如 `?t=<签发时间戳>&sig=<HMAC>`），有需要可以再扩展。

## 安全与已知限制

- Bark 的 `device_key` 只保存在环境变量中，页面和接口都不会返回它。
- 限流基于「单个边缘节点的内存」，EdgeOne 会在多节点调度，因此是尽力而为的防护；如果担心被刷，把 `COOLDOWN` 调大即可。
- 拨号按钮不显示号码。但 `tel:` 链接里必须带完整号码（否则无法拨号），查看页面源码仍能拿到——这是 HTML 的固有特性，介意的话不要配置 `OWNER_PHONE`。
- 页面有效时间是客户端计时，用于避免二维码被拍照后反复触发；服务端仍靠 IP 冷却与每小时上限兜底。
- 页面已加 `noindex` 与同源校验，搜索引擎不会收录，也无法被跨域脚本直接调用。

## License

[MIT](./LICENSE)
