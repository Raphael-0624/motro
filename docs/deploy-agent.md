# 给云服务器 Agent 的部署任务

本次发布只推送源码，不代表已部署云端。下面的任务可以交给已经登录云服务器、拥有部署权限的 Agent。

## 复制给 Agent 的任务

```text
请在这台云服务器部署 Motro，目标是个人 / 受控测试使用，不是公开运营平台。

公开仓库：https://github.com/Raphael-0624/motro
分支：main
部署域名：<填入已经解析到这台服务器的域名>
允许的浏览器扩展 ID：<填入电脑扩展管理页中 Motro 的 ID>

先读取仓库 AGENTS.md、README.md、docs/deployment.md 和本文。
先检查系统、Node 版本、现有服务、80/443/3030 端口、DNS 和防火墙。
不要覆盖现有站点、停止其他业务、重置防火墙或删除已有数据；如有冲突先说明。
如果域名或扩展 ID 尚未提供，先向我询问，不要假造值，也不要把 3030 裸露公网。

执行要求：
1. 以 main 的明确 commit 部署到 /opt/motro，记录 commit 和版本。
2. 使用系统级 Node.js 22+、npm ci，运行 npm run verify。
3. 只运行一个服务实例。手机网页由 Node 服务托管，无需额外前端服务。
4. 参照 deploy/motro.service 配置专用低权限用户和 systemd。
   核实 ExecStart 的系统 Node 路径；不要使用 /root 下的 nvm 路径。
5. Node 只监听 127.0.0.1:3030。设置 PUBLIC_URL=https://实际域名、
   EXTENSION_IDS=实际扩展ID、DATA_DIR=/var/lib/motro。
   环境文件 /etc/motro.env 不能提交到 Git。
6. 配置现有反向代理支持 HTTPS 与 WebSocket /ws，使用合法证书，
   保留原始 Host，请求读取超时至少 75 秒。不要开放公网 3030。
7. 访问控制限定为我授权的测试范围；当前版本不具备公开多用户的完整防滥用能力。
8. 验证 /api/health、/api/version、手机页面，以及 HTTPS/WSS 配对转发。
   运行 MOTRO_EXTENSION_ID=实际ID npm run smoke -- https://实际域名。
   smoke 会增加两次粗略访问计数，不执行真实浏览器操作。
9. 验证重启服务后访问计数继续递增，不要删除或重建 visits.json。
   重启会使当前配对失效，已有用户时先协调维护窗口。
10. 返回部署地址、版本、commit、服务状态、监听端口、证书结果、
    测试输出摘要、更新命令、日志命令和回滚方法。

注意：不要修改插件的固定默认地址或发布插件。
本轮插件仍默认 http://localhost:3030。
部署成功后把 HTTPS 地址返回给我，由本机项目统一修改默认地址、递增版本和发布。
不要把环境文件、令牌、访问计数或浏览器 profile 推送到公开仓库。
```

## 运行约定

- `PUBLIC_URL`：独立域名的 HTTPS 根地址，不带子路径。
- `EXTENSION_IDS`：扩展 ID，多个用逗号分隔。解压加载扩展的 ID 可能因安装路径或电脑不同而变化。
- `DATA_DIR`：持久化目录。计数保存为 `visits.json`，不含访客身份或 IP；更新代码时必须保留，备份也需要包含它。
- `HOST=127.0.0.1`、`PORT=3030`：让 Node 只对本机代理提供服务。

计数是页面加载后调用一次 `POST /api/visits` 得到的序号，刷新会加一，不是独立访客统计。资源请求、心跳、连接重试不加一；部署 smoke 中的两次显式请求也会加一。计数写入失败显示 `no.--`，不会编造数字，也不阻塞配对。

## 更新与回滚

更新前记录旧 commit、版本并备份 `/var/lib/motro/visits.json`。确认工作区没有未提交修改后，拉取已审核的 main 或指定版本，执行 `npm ci`、`npm run verify`，再在维护窗口重启 `motro.service`。不要使用 `git reset --hard` 覆盖服务器自有修改。

更新后执行健康检查和 smoke。回滚时部署先前记录的 commit，重新安装对应 lockfile 的依赖并重启，保留数据目录。出现磁盘或计数文件损坏时先保全现场和备份，不要通过删除计数文件恢复。

常用检查：`systemctl status motro`、`journalctl -u motro -n 100 --no-pager`、`curl https://实际域名/api/version`。

服务端 smoke 不替代真实手机验收：最终仍需在本机更新插件默认地址后，确认扫码 / 复制地址、电脑授权、滚动、惯性、缩放和闲置保持连接。
