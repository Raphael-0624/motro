# 远程部署准备

当前优先本地验收，本文不表示已经部署或达到公开运营标准。

## 哪些内容上云

- `apps/server` 及其生产依赖。
- `apps/mobile`：保持仓库相对目录，由 server 托管。
- 根目录的 `package.json`、`package-lock.json` 和 workspace 清单，以便安装依赖。最简单是上传整个仓库（不含 `node_modules` 和个人配置）。

`apps/extension` 不在服务器执行；用户在电脑浏览器安装它。部署成功返回 HTTPS 地址后，在本机统一修改 `apps/extension/background.js` 的 `DEFAULT_SERVER`、递增版本并重新加载插件。弹窗不提供地址输入；如有调试用 `chrome.storage.local.serverUrl` 覆盖值需要清除。不需要修改手机端 WebSocket 地址，它会自动使用当前页面域名和 `wss:`。

可以将 [部署任务](deploy-agent.md) 交给云服务器上的 Agent。仓库提供 `deploy/motro.service` 模板，使用前核实系统 Node 路径和现有站点。

## 单实例启动示例

```sh
npm ci --omit=dev
HOST=127.0.0.1 PORT=3030 PUBLIC_URL=https://motro.example.com \
DATA_DIR=/var/lib/motro npm start
```

前面配置 HTTPS 反向代理。`PUBLIC_URL` 用于插件展示手机访问地址，并将域名加入 Host 允许列表；请使用独立域名根路径，首版不支持 `/motro/` 子路径部署。

当前不启用扩展 ID 白名单：不要设置 `EXTENSION_IDS`，不同电脑无需登记 ID。如以前已配置，从 systemd / 容器 / 环境文件中移除后重启。服务仍校验浏览器来源，并要求手机配对得到电脑确认，不是取消授权。

Nginx 的核心代理配置（证书配置按实际环境补充）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

同时用 systemd、容器重启策略或现有进程管理器守护进程。部署时应禁用开发 watch 模式。

`DATA_DIR` 必须可写且位于代码更新目录外，保存 `visits.json`。备份和回滚保留它，不要随部署清空序号。单机默认目录是 `data/`，已被 Git 忽略。

## 版本更新

开发交付运行一次 `npm run version:bump`，提交统一版本和 lockfile。服务器 Agent 更新前记录旧 commit / 版本、备份计数，执行 `npm ci`、`npm run verify`，维护窗口内重启服务，再运行 `npm run smoke -- https://实际域名`。smoke 默认使用模拟扩展来源，无需提供真实 ID，会显式增加两次访问序号。

网页随服务部署更新，客户端刷新获取新资源。解压安装的插件不会随服务器自动更新：电脑端拉取相同版本源码，在扩展管理页点击重新加载，再配对。浏览器商店自动分发是后续工作，本次不包含商店发布。

## 公网前必须复核

- HTTPS 证书和 WSS 升级可用，不允许明文公网访问；Node 端口仅向代理开放。
- 设置 `PUBLIC_URL`，不设置扩展 ID 白名单，验证不同电脑及手机均可连通。
- 先小规模试用，不增加逐台电脑登记步骤；四位码加电脑确认不是完整用户认证或防滥用系统。
- 当前服务只按直接连接 IP 限流。在反向代理后，多个用户共享代理 IP，可能互相触发五次配对限制；公开多用户使用前需要实现可信代理 IP 处理及边缘限流，不能盲目信任转发头。
- 补充公网连接配额、跨 IP 猜码防护、异常流量监控、日志脱敏和访问策略。
- 不记录令牌。反向代理、浏览器错误追踪也不能收集敏感消息内容。
- 仅运行一个服务实例；重启或升级会终止所有会话，需要重新配对。
- 运行 `npm run verify`、`npm run test:e2e`，并完成手机真机与公网延迟验收。

健康检查：`GET /api/health`；版本：`GET /api/version`。当前没有数据库或消息队列；仅访问序号落盘，会话不持久化，不支持多副本。
