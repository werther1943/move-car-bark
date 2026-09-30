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
| 车主电话 | 明文写在页面 | 默认脱敏显示（`138****8000`），可开关 |
| 附加信息 | 固定一句话 | 时间、来源 IP 与设备（iOS/微信 这类） |
| 多车主 | 多个 UID | 多个 `device_key`，逗号分隔即可 |

## 页面效果

- 顶部显示车牌（配置了 `PLATE` 时出现蓝色车牌条）
- 绿色主按钮「通知车主挪车」，带 loading 与冷却倒计时
- 配置了 `OWNER_PHONE` 时出现「拨打车主电话」按钮
- 移动端优先，适配微信 / 支付宝 / Safari 内置浏览器

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
├── worker.js                 # 单文件版：直接整段粘贴到 EdgeOne 边缘函数编辑器
├── src/app.js                # 源码（页面渲染 + 路由 + Bark 推送 + 限流）
├── functions/[[path]].js     # EdgeOne Pages Functions / Cloudflare Workers 入口
├── scripts/
│   ├── build-worker.js       # src/app.js → worker.js
│   └── dev.js                # 本地预览（Node 内置 http，零依赖）
├── .env.example              # 配置模板
├── package.json
├── LICENSE                   # MIT
└── docs/DEPLOY.md            # 详细部署步骤与排错
```

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

## 快速开始（方式二：EdgeOne Pages）

把仓库推到 GitHub 后，在 EdgeOne Pages 里「导入 Git 仓库」：

- 构建命令留空（纯静态），输出目录填 `.`
- 函数目录默认为 `functions/`，本项目已提供 `functions/[[path]].js`
- 在 Pages 的环境变量里添加 `BARK_KEY` 等配置

由于 Pages 用 ES Module 写法，入口会 `import` `src/app.js`，因此这种方式**不需要** `worker.js`。

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
| `OWNER_PHONE` | 否 | 空 | 车主电话，配置后出现拨号按钮 |
| `PLATE` | 否 | 空 | 页面展示的车牌号 |
| `PAGE_TITLE` | 否 | `通知车主挪车` | 页面标题 |
| `PAGE_TIP` | 否 | 见源码 | 页面副标题 |
| `SHOW_PHONE` | 否 | `0` | `1` 明文显示电话 / `0` 脱敏 |
| `COOLDOWN` | 否 | `60` | 同一 IP 两次推送之间的冷却秒数 |
| `MAX_PER_HOUR` | 否 | `5` | 同一 IP 每小时最多推送次数 |
| `TIMEZONE_OFFSET` | 否 | `8` | 推送时间的时区偏移（中国填 8） |

除了环境变量，也可以直接改 `src/app.js`（或 `worker.js`）顶部的 `HARD_CODE` 常量——**环境变量优先级更高**。

## 本地预览

```bash
cp .env.example .env      # 填入自己的配置
npm run dev               # 打开 http://localhost:8787
```

改完 `src/app.js` 后重新生成单文件版：

```bash
npm run build             # 输出 worker.js
```

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET | 挪车页面 |
| `/api/notify` | POST | 发送 Bark 推送，无需请求体（发 `{}` 即可） |
| `/api/config` | GET | 返回页面需要的非敏感配置 |
| `/healthz` | GET | 健康检查，返回 `{"ok":true,"configured":true}` |

`/api/notify` 的响应：`{"ok":true,"code":"OK","cooldown":60}`；被限流时返回 HTTP 429 与 `{"ok":false,"code":"COOLDOWN","retryAfter":42}`。

## 安全与已知限制

- Bark 的 `device_key` 只保存在环境变量中，页面和接口都不会返回它。
- 限流基于「单个边缘节点的内存」，EdgeOne 会在多节点调度，因此是尽力而为的防护；如果担心被刷，把 `COOLDOWN` 调大即可。
- 电话默认脱敏。即使开启 `SHOW_PHONE`，号码本身对扫码者可见，请自行权衡。
- 页面已加 `noindex` 与同源校验，搜索引擎不会收录，也无法被跨域脚本直接调用。

## License

[MIT](./LICENSE)
