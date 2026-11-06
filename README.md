# Motro

把手机变成电脑浏览器的无线触控板：单指滑动滚动网页，轻量惯性续滑，双指捏合调整浏览器原生缩放。

手机不需要安装 App，也不需要网页相机权限。电脑安装 Chrome/Edge 扩展；手机打开网页输入四位连接码，或用系统相机扫码跳过输入；两种方式都需要电脑确认授权。

当前版本 **0.1.4**。默认服务地址：[https://motro.rafa.love](https://motro.rafa.love)。手机和电脑均能联网即可，不必处于同一局域网。

## 项目结构

```text
apps/
  extension/     Chrome/Edge Manifest V3 扩展，直接加载，无需构建
  mobile/        手机网页，原生 HTML / CSS / JavaScript
  server/        Node.js 静态服务、WebSocket 配对和指令转发
assets/brand/    原始品牌图标
scripts/         检查、版本、资源生成与部署 smoke
tests/e2e/      真实扩展的浏览器端到端测试
docs/           架构、协议、本地开发和部署指南
deploy/         systemd 模板
```

三个逻辑模块，**只启动一个服务进程**。手机网页由服务端托管；云端也只运行这一进程，插件留在电脑上。

## 快速使用

环境：Chrome 116+ 或近期版本的 Edge。普通使用无需在电脑安装 Node.js 或启动本地服务。

```sh
git clone https://github.com/Raphael-0624/motro.git
cd motro
```

### 1. 加载插件

1. Chrome 打开 `chrome://extensions`（Edge 使用 `edge://extensions`）。
2. 开启「开发者模式」，点击「加载已解压的扩展程序」。
3. 选择仓库中的 `apps/extension`，建议固定到工具栏。

### 2. 配对手机

1. 打开插件，点击「启动」。固定默认服务为 `https://motro.rafa.love`，无需输入地址。
2. 手机用系统相机扫描插件二维码，直接进入「在电脑上确认授权」。
3. 打开电脑插件，点击「确认授权」。拒绝则不会开放控制。
4. 电脑切换到普通网页；手机在大触控板上滑动或双指捏合。

二维码携带短期连接码，**跳过输入，不跳过授权**。刷新码后旧二维码失效。网页本身不调用相机。

插件仅展示二维码作为手机入口，不展示网址或复制按钮；保留居中连接码、刷新和结束按钮。

手机也可以直接打开 `https://motro.rafa.love` 并输入连接码。云端不可用时插件会重试，不会悄悄切回本地服务。

## 本地开发

需要 Node.js 22+ 和 npm：

```sh
npm ci
npm run dev
```

服务默认端口为 `3030`，终端显示本机及局域网访问地址。插件在 service worker 控制台执行 `chrome.storage.local.set({ serverUrlOverride: 'http://localhost:3030' })`，再点击「启动」切到本地。恢复云端执行 `chrome.storage.local.remove('serverUrlOverride')` 后结束并重新启动连接。

本地模式下手机与电脑需处于可互通的局域网，可扫描插件二维码，或使用服务终端打印的局域网地址，不使用 `localhost`（手机的 localhost 指向手机自己）。多个网卡存在时注意 VPN 地址不一定可达。

## 操作与状态

- 插件仅展示当前状态：启动 → 连接码 / 二维码 → 确认授权 / 拒绝 → 连接中 / 结束连接。
- 手机仅展示：输入连接码 → 等待电脑授权 → 触控板。整体固定一屏，适配小屏、横屏及平板。
- 快速滑动松手后轻量惯性续滑，再次触摸立即停止续发惯性；浏览器已接收的原生滚动动画可能短暂收尾。慢速拖动或松手前停顿不续滑。
- 单指上滑向下浏览、左滑向右浏览，反方向滑动则反向浏览；支持双指缩放、缩放按钮、重置和速度调节。
- 电脑切换标签页后控制当前标签页；关闭插件弹窗、正常闲置不会主动结束配对。
- 两端定期心跳、断线自动重试；系统休眠或手机锁屏可能暂停网络，恢复后尝试重连。电脑离线超过两分钟或服务重启需要重新配对。

### 页面中心的原生滚轮输入

从 0.1.4 起不再查找 DOM 滚动容器：通过 Chrome `debugger` 接口在当前网页视口中心模拟浏览器级鼠标滚轮，支持横向和纵向输入。普通超宽页面由浏览器滚动，Canvas 应用由自身的滚轮处理器响应；不是 `dispatchEvent` 合成事件，也不移动系统鼠标。

插件新增 `debugger` 权限，更新后可能需要重新确认权限；滚动期间浏览器会显示调试提示。不要同时对目标标签页打开开发者工具或使用另一个调试插件。结束连接、断线、切换标签页 / 窗口时释放调试连接，下次滑动按需重新连接；主动取消调试后请结束并重新连接。

已测试只响应可信滚轮事件的 Canvas 和普通横向容器，但未验证登录后的飞书实际文档。只有该应用自身支持中心位置的滚轮交互才会响应；只支持拖拽、不处理滚轮的应用不能保证。页面中心若被弹窗或浮层遮挡，输入会落到该浮层。

## 版本与访问序号

插件页头、手机配对页底部、`/api/health` 和 `/api/version` 提供版本。每次交付统一执行一次 `npm run version:bump`，同时递增服务、手机网页、扩展及 lockfile 的版本。

手机配对页底部显示 `no.N`：每次页面加载请求一次计数，刷新加一，不是独立访客统计。计数保存在 `DATA_DIR/visits.json`，默认 `data/visits.json`；服务重启保留，更新不要删除。资源请求、手势和心跳不计数。写入失败显示 `no.--`，不影响配对。

## 常用命令

```sh
npm run dev          # 开发监听，服务重启会清空配对
npm start            # 普通启动
npm run verify       # 语法 / JSON / 统一版本检查 + Node 测试
npm run version:bump # 每次交付统一递增 patch；也支持 -- minor / major
npx playwright install chromium
npm run test:e2e     # 真实扩展 + 移动视口 + 触摸 / 惯性 / 缩放
npm run smoke -- https://实际域名 # 无需提供扩展 ID
```

## 配置与部署

`.env.example` 是环境变量说明，不自动加载。可使用 shell 环境变量，或 `node --env-file=.env apps/server/src/index.js`。

固定插件地址配置在 `apps/extension/background.js` 的 `DEFAULT_SERVER`，当前为 `https://motro.rafa.love`。弹窗不增加设置表单；只有显式的 `serverUrlOverride` 用于本地调试。旧版本保存的 `serverUrl` 自动移除，不再覆盖新默认。切换服务会清除旧会话，需要重新配对；同一服务的后台恢复仍保留会话。

云端只需 Node 服务、HTTPS/WSS 反向代理和持久化数据目录，参见 [给服务器 Agent 的部署任务](docs/deploy-agent.md)。插件更新需要电脑端更新本地源码并在扩展管理页重新加载；自托管服务器不能自动替用户更新解压安装的扩展。

当前不启用扩展 ID 白名单：部署不要设置 `EXTENSION_IDS`，也不用收集其他电脑的 ID。每台电脑独立生成连接码、独立确认授权，不影响其他电脑的会话。若之前设置过该环境变量，需要移除后重启服务。

## 图标

使用提供的牛角包与咖啡杯图案，原图保存在 `assets/brand/icon.png`。插件工具栏、管理页、弹窗及手机页头、favicon、Apple 主屏幕图标已接入。

资源随仓库分发，无需生成。替换原图后可在 macOS 使用 `npm run icons`（系统 `sips`）生成尺寸资源；二维码库在本地生成，不依赖 CDN 或第三方二维码接口。

## 当前边界

- 支持大多数普通 HTTP/HTTPS 网站；浏览器设置页、扩展商店、内嵌 PDF、跨域 iframe、Shadow DOM 和复杂编辑器不保证可控。
- 滚轮固定发送到网页视口中心，不跟随实际鼠标，不搜索滚动容器；目标由浏览器 / 应用的原生滚轮行为决定。
- 缩放是浏览器页面缩放（25%–300%），不是画面镜像或操作系统控制。
- 一个会话配对一部手机。未配对码五分钟过期，插件在线时临近到期自动刷新；已授权会话不因码过期而断开。
- 本地 HTTP/WS 仅用于可信局域网；公网必须 HTTPS/WSS，保留浏览器来源检查及电脑授权，不启用扩展 ID 白名单。当前不具备公开多用户的完整防滥用能力，大规模推广前仍需改进限流和容量。
- 会话保存在内存，仅支持单实例；访问序号单独落盘。服务重启需要重新配对。
- Chromium 自动化不等同 iPhone/Android 真机验收，休眠恢复与真实 Wi-Fi 手感仍需验证。

## 开发文档

- [本地开发与验收](docs/development.md)
- [架构与技术决策](docs/architecture.md)
- [协议与 HTTP 接口](docs/protocol.md)
- [部署配置](docs/deployment.md)
- [云服务器 Agent 任务](docs/deploy-agent.md)
- [阶段路线图](docs/roadmap.md)
- [更新记录](CHANGELOG.md)

仓库公开可查看，但暂未授予项目开源许可（`UNLICENSED`）。第三方二维码库的 MIT 许可见 `apps/extension/vendor/THIRD_PARTY_LICENSES.txt`。
