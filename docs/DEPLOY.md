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

## 三、EdgeOne Pages 部署

1. 把本仓库 push 到 GitHub（或直接在 Pages 里选「导入 Git 仓库」）。
2. 新建 Pages 项目：
   - 框架预设：无 / Other
   - 构建命令：留空
   - 输出目录：`.`
   - 函数目录：`functions`
3. 在「环境变量」里添加 `BARK_KEY` 等变量。
4. 部署完成后访问分配的 `*.edgeone.app` 域名即可。

`functions/[[path]].js` 是通配路由，会把 `/`、`/api/notify`、`/api/config`、`/healthz` 全部交给同一个函数处理。

## 四、生成二维码

把最终访问链接（建议用自定义域名 + HTTPS）拿到 [草料二维码](https://cli.im/) 生成二维码，打印后贴在挡风玻璃左下角，或买一张挪车贴纸打印。

注意：如果用 `*.workers.dev` / `*.edgeone.app` 这类默认域名，微信扫码可能被提示「已停止访问该网页」，绑定自己的已备案域名最稳妥。

## 五、排错

| 现象 | 原因与处理 |
| --- | --- |
| 页面提示「服务端尚未配置 BARK_KEY」 | 环境变量没加，或加了之后没有点「部署」 |
| 点按钮提示「发送失败」 | 看 `/api/notify` 返回的 `detail`；多半是 `BARK_KEY` 写错，或自建服务地址不通 |
| 手机收不到推送 | Bark App 通知权限是否打开；`BARK_LEVEL` 是否被设为 `passive`；检查 App 内是否对该分组做了免打扰 |
| 一直提示「发送太频繁了」 | 触发了限流，调大 `COOLDOWN`，或等冷却结束（本地倒计时是存在 localStorage 里的，换浏览器无效但服务端仍会拦） |
| 页面能开但按钮点了没反应 | 浏览器禁用了 JS；或触发规则只匹配到静态资源，检查触发规则路径 |
| 拨号按钮不显示 | 没有配置 `OWNER_PHONE` |

## 六、改代码后的流程

```bash
# 1. 改 src/app.js
# 2. 重新生成单文件版
npm run build
# 3. 把 worker.js 内容重新粘贴到 EdgeOne 代码编辑器并部署
```
