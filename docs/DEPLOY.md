# 部署到腾讯云 EdgeOne

## 一、准备 Bark

1. iPhone 安装 Bark（App Store 搜索 "Bark"）。
2. 打开 App，首页中部的地址形如 `https://api.day.app/AbCdEfGhIjKlMnOp`，其中最后一段就是 **device_key**。
3. 点右上角的复制按钮即可复制。家里有多个人能开车，就各自安装并复制，配置时用英文逗号拼起来。

> 想用自建服务：自己部署 [Bark Server](https://github.com/Finb/bark-server) 后，把 `BARK_SERVER` 改成自己的域名即可，代码会优先用 `POST {服务器}/push`，失败时自动降级到 `GET {服务器}/{key}/{标题}/{正文}` 的老接口形式。

## 二、EdgeOne 边缘函数部署（逐步）

1. 登录 [EdgeOne 控制台](https://console.cloud.tencent.com/edgeone)，进入已接入的站点。
2. 左侧菜单 **边缘函数** → **新建函数**：
   - 函数名称：`move-car`
   - 描述随意
   - 直接点「创建并部署」，用默认示例代码即可。
3. 进入函数详情 → **代码** 页签 → 点右上角「编辑代码」：
   - 全选删除默认代码
   - 粘贴本仓库 `worker.js` 的全部内容
   - 点「保存」
4. **环境变量** 页签 → 新建变量：

   | 名称 | 类型 | 值 |
   | --- | --- | --- |
   | `BARK_KEY` | String | 你的 device_key |
   | `OWNER_PHONE` | String | 车主手机号（可选） |
   | `PLATE` | String | 京A·12345（可选） |

   加完必须点 **部署**，变量才会生效（EdgeOne 需要单独部署一次变量）。
5. 回到 **代码** 页签点 **部署**。
6. **触发规则** → 新增规则：
   - 匹配类型选「URL 路径」或「前缀匹配」
   - 规则内容填 `/move-car` 或 `/*`
   - 保存并部署
7. 访问 `https://你的域名/move-car`（或对应路径）看到页面即成功。访问 `/healthz` 应返回 `{"ok":true,"configured":true}`。

## 三、EdgeOne Pages / Makers 部署

1. 把本仓库 push 到 GitHub（或在 Pages / Makers 里选「导入 Git 仓库」「直接上传文件夹」）。
2. 新建项目：
   - 框架预设：无 / Other
   - 构建命令：留空
   - 输出目录：`.`（根目录，里面有 `index.html`）
   - 函数目录：保持默认即可
3. 在「环境变量」里添加 `BARK_KEY` 等变量。
4. 部署完成后访问分配的域名即可。

### 函数目录对照表

不同产品读的目录不一样，本仓库三个都生成了，平台只认自己那一个：

| 平台 / 域名形态 | 目录 | 入口写法 |
| --- | --- | --- |
| EdgeOne Makers（`*.edgeone.dev`） | `edge-functions/` | `export async function onRequest(context)` |
| EdgeOne Pages 国际站（`*.edgeone.app` / `*.edgeone.cool`） | `functions/` | 同上 |
| EdgeOne Pages 国内站 | `node-functions/` | 同上 |
| EdgeOne 控制台「边缘函数」 | 无目录，粘贴 `worker.js` | `addEventListener('fetch', …)` |

> 关键坑：Pages / Makers **不支持** `addEventListener`。官方文档原话是「Pages Functions cannot be used with addEventListener，请基于 Function Handlers 监听客户端请求」。如果沿用 Cloudflare Worker 的写法，函数不会被执行，表现就是整站 404。

路由映射：

| 文件 | 路由 |
| --- | --- |
| `*/index.js` | `/` |
| `*/api/[[default]].js` | `/api/config`、`/api/notify` |
| `*/healthz.js` | `/healthz` |

根目录的 `index.html` 是纯静态兜底页：只要它被部署上去，站点就一定打得开；页面会再拉 `/api/config` 补齐车牌和电话，按钮走 `/api/notify`。Makers 下静态资源优先级高于函数，所以 `/` 会命中 `index.html`，这是预期行为。

## 四、生成二维码

把最终访问链接（建议用自定义域名 + HTTPS）拿到 [草料二维码](https://cli.im/) 生成二维码，打印后贴在挡风玻璃左下角，或买一张挪车贴纸打印。

注意：如果用 `*.workers.dev` / `*.edgeone.app` 这类默认域名，微信扫码可能被提示「已停止访问该网页」，绑定自己的已备案域名最稳妥。

## 五、排错

| 现象 | 原因与处理 |
| --- | --- |
| 整站 404 且页面写着 `The site does not exist` | 部署没有产出任何站点内容。检查：① 上传/构建的根目录里有没有 `index.html`；② 构建日志里有没有 `Output directory xxx does not exist`；③ 项目是否处于「草稿 / 构建失败」状态。 |
| 401 `Authentication Expired` | 访问的是带 `?eo_token=` 的预览链接且已过期，或域名未备案被限制。到控制台重新生成预览链接，正式使用请绑定自己的已备案域名。 |
| 页面能开，顶部黄条提示「未检测到服务端接口 /api/config」 | 静态页部署成功但边缘函数没被识别。确认函数目录（`edge-functions/` / `functions/` / `node-functions/`）随仓库一起上传，且入口用的是 `onRequest`。 |
| 页面提示「服务端尚未配置 BARK_KEY」 | 环境变量没加，或加了之后没有重新部署一次 |
| 点按钮提示「推送接口未部署或不可用」 | `/api/notify` 返回了 HTML（被静态资源或 404 页接管），同上检查函数路由 |
| 点按钮提示「发送失败」 | 看 `/api/notify` 返回的 `detail`；多半是 `BARK_KEY` 写错，或自建服务地址不通 |
| 手机收不到推送 | Bark App 通知权限是否打开；`BARK_LEVEL` 是否被设为 `passive`；检查 App 内是否对该分组做了免打扰 |
| 一直提示「发送太频繁了」 | 触发了限流，调大 `COOLDOWN`，或等冷却结束（本地倒计时存在 localStorage，换浏览器无效但服务端仍会拦） |
| 页面能开但按钮点了没反应 | 浏览器禁用了 JS；走边缘函数部署时检查触发规则路径 |
| 拨号按钮不显示 | 没有配置 `OWNER_PHONE` |

### 快速自检

部署后依次访问这三个地址，能确认问题出在哪一层：

```bash
curl -s https://你的域名/healthz        # 期望 {"ok":true,"configured":true}
curl -s https://你的域名/api/config      # 期望返回 plate / phone / configured
curl -s -X POST https://你的域名/api/notify -H 'Content-Type: application/json' -d '{}'
```

- `/healthz` 就 404 → 函数根本没部署上
- `/healthz` 正常但 `/` 不是我们的页面 → 静态资源路径不对
- 三个都正常 → 部署没问题，去查 Bark Key

## 六、改代码后的流程

```bash
# 1. 改 src/app.js
# 2. 重新生成全部产物
npm run build
# 3a. 边缘函数方式：把 worker.js 内容重新粘贴到 EdgeOne 代码编辑器并部署
# 3b. Pages / Makers 方式：push 到 GitHub，等平台自动重新构建
```
