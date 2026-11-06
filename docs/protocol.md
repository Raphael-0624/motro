# WebSocket 协议 v1

入口：`ws://HOST:PORT/ws`，HTTPS 部署后为 `wss://DOMAIN/ws`。消息为 JSON 对象，必须带 `type`。最大帧 4096 字节，服务忽略未知字段，只转发白名单字段。不要把令牌写进 URL、日志或分析系统。

## HTTP 与扫码入口

- `GET /api/health`：`{ "ok": true, "name": "motro", "version": "0.1.6" }`。
- `GET /api/version`：`{ "version": "0.1.6", "server": "0.1.6", "mobile": "0.1.6", "extension": "0.1.6" }`。
- `POST /api/visits`：原子递增并返回 `{ "count": 1, "version": "0.1.6" }`，网页每次文档加载仅调用一次，不重试；检查同源浏览器 Origin。非身份 / 独立访客统计接口。
- `GET /` 和白名单静态资源：手机网页，不增加访问序号；页面随后显式调用 visits。

二维码地址形如 `http://局域网IP:3030/#code=5829`。fragment 不发送给 HTTP 服务；网页读取有效四位码后移除 fragment 并自动提交 `mobile.join`，仍走下方授权流程。连接码不是令牌；过期或已使用时回到输入页。

## 连接与授权

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| 扩展 → 服务 | `{ "type": "host.open", "token": "可选旧令牌" }` | 不带令牌创建会话；带令牌恢复会话，失效时必须明确创建新会话 |
| 服务 → 扩展 | `{ "type": "host.state", "token": "host-token", "code": "5829", "expiresAt": 0, "mobileUrls": [], "paired": false, "connected": false, "pending": null }` | 当前状态；`expiresAt` 为 Unix 毫秒时间戳，`connected` 指手机是否在线 |
| 手机 → 服务 | `{ "type": "mobile.join", "code": "5829" }` | code 必须是四位数字字符串，保留前导零 |
| 服务 → 手机 | `{ "type": "mobile.pending" }` | 等待电脑确认，尚未授权 |
| 服务 → 扩展 | `host.state`，其中 `pending` 为 `{ "id": "request-id" }` | 提示用户处理请求 |
| 扩展 → 服务 | `{ "type": "host.approve", "id": "request-id", "allow": true }` | 允许或拒绝待确认请求 |
| 服务 → 手机 | `{ "type": "mobile.ready", "token": "mobile-token", "hostConnected": true }` | 授权成功，允许发送控制 |
| 手机 → 服务 | `{ "type": "mobile.resume", "token": "mobile-token" }` | 恢复配对，成功返回 `mobile.ready` |
| 服务 → 手机 | `{ "type": "host.status", "connected": false }` | 电脑离线/恢复 |

host token 和 mobile token 是独立的随机值，不可混用。只有扩展浏览器来源（或无 Origin 的原生客户端）可以创建 host 会话；来源检查不能代替授权或生产级防滥用。

当前部署不启用扩展 ID 白名单，不设置 `EXTENSION_IDS`；不同 ID 的扩展可独立创建会话，无需逐台电脑登记。保留扩展来源格式与普通网页同源检查，每个会话仍须对应电脑确认授权。

## 控制

```json
{ "type": "control", "action": "scroll", "dx": 0, "dy": 120 }
```

`dx/dy` 是以目标网页 CSS 像素为单位的滚轮增量，正 `dx` 向右、正 `dy` 向下浏览。必须是有限数字，每次转发限制在 `[-1500, 1500]`。0.1.6 手机按「上下 / 左右」模式只发送对应轴；扩展按轴独立滚动视口中心的 DOM 容器，不再发送原生鼠标滚轮。协议消息不变，兼容旧网页同时发送两轴。

```json
{ "type": "control", "action": "zoom", "factor": 1.08 }
```

相对缩放倍率，必须是 `[0.5, 2]` 范围内的有限数字。扩展根据当前缩放计算目标，限制最终页面缩放为 `[0.25, 3]`。

```json
{ "type": "control", "action": "resetZoom" }
```

以上消息只有已批准手机可以发送，原样白名单转发给对应扩展，不广播给其他会话。扩展失败时可返回：

```json
{ "type": "host.feedback", "message": "请切换到普通网站。" }
```

服务向手机转发同类型消息，文本最多 200 字符。

## 生命周期

| 消息 | 说明 |
| --- | --- |
| `{ "type": "host.refresh" }` | 仅 host、无待确认或已配对手机时可刷新码，返回 `host.state` |
| `{ "type": "host.end" }` | 仅 host，撤销整个会话 |
| `{ "type": "mobile.leave" }` | 仅已配对手机，撤销手机令牌，host 保留并获得新码 |
| `{ "type": "session.ended", "message": "..." }` | 服务告知手机会话结束，客户端清除令牌 |
| `{ "type": "ping" }` / `{ "type": "pong" }` | 应用层心跳；服务另有 WebSocket ping/pong 活性检测 |

正常配对没有闲置超时。未配对码五分钟有效，扩展每 20 秒心跳时检查并在临近到期时发送 `host.refresh`。待授权请求最多等待一分钟；电脑离线会话保留两分钟。服务重启清空会话，手机和扩展均需重新配对。轻量惯性复用普通滚动消息，不改变协议。

## 错误

```json
{ "type": "error", "code": "INVALID_CODE", "message": "Code is invalid, expired, or already used" }
```

主要错误码：`INVALID_MESSAGE`、`INVALID_CODE`、`RATE_LIMITED`、`PAIRING_BUSY`、`SESSION_EXPIRED`、`HOST_BUSY`、`MOBILE_BUSY`、`HOST_OFFLINE`、`NOT_PAIRED`、`FORBIDDEN`、`INVALID_CONTROL`、`NO_REQUEST`、`ALREADY_CONNECTED`、`SERVER_FULL`。

限流：每直接连接 IP 每分钟最多五次 `mobile.join`；每 WebSocket 每秒最多 180 条消息。默认不信任转发 IP 请求头，所以反向代理后的用户可能共享同一 IP 配额。公网前需要配置可信代理方案或边缘限流，而不是直接信任任意 `X-Forwarded-For`。
