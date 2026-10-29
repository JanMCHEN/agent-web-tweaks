# 本地桥协议

```
┌──────────────┐   GET /events (SSE，扩展主动连)   ┌────────────────┐
│  Chrome 扩展  │ ◀──────────────────────────────── │  bridge.mjs    │
│              │   POST /result (回传执行结果)      │ 127.0.0.1:8787 │
└──────────────┘ ─────────────────────────────────▶ └────────────────┘
                                                            ▲
                                          POST /call        │
                                          GET  /tools       │  agent / MCP / curl
                                          GET  /health      │
```

- 扩展永远是客户端：浏览器里的 service worker 主动建立 SSE 长连接，不需要在扩展里监听端口
- 一次调用 = 服务端下发一条 `call` 事件，扩展执行完 `POST /result`
- 多个扩展同时连接时，桥只把命令发给**最新连接**的那个

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/events` | 扩展订阅命令（`text/event-stream`）；每 15s 一个 `: ping` 注释保活 |
| POST | `/result` | 扩展回传：`{ id, ok, result?, error? }` |
| POST | `/call` | agent 调用：`{ tool, args?, timeoutMs? }` → `{ ok, tool, result }` 或 `{ ok:false, error }` |
| GET | `/tools` | 转发扩展的 `meta.tools`；扩展离线时返回空列表 + 错误 |
| GET | `/health` | `{ ok, clients, pending, client:{version,tabs,...} }` |
| POST | `/hello` | 扩展连接后上报自身信息（版本、标签页数、扩展 id） |

## 事件格式

服务端 → 扩展：

```
event: call
data: {"id":"c1-a1b2c3","tool":"rules.list","args":{"url":"https://example.com"}}
```

扩展 → 服务端：

```json
{ "id": "c1-a1b2c3", "ok": true, "result": { "rules": [] } }
```

超时（默认 120s，可在 `/call` 里用 `timeoutMs` 覆盖）由桥负责 reject；
扩展断开时，挂在该连接上的所有 pending 调用会立刻失败。

## 鉴权

启动时给 `--token xxx`（或环境变量 `AWT_TOKEN`），扩展在工作台里填同一个 token。
`/events` 支持 `?token=`，其余端点支持 `x-awt-token` 头。

## MCP

`bridge/mcp.mjs` 把同一批工具包装成 MCP server（stdio，JSON-RPC 2.0，按行分隔）：

- `initialize` → `protocolVersion` 回显客户端值，`tools` capability
- `tools/list` → `src/shared/tools.js` 里的 `TOOL_DEFS`
- `tools/call` → 转发到 `/call`
- 截图类结果会转成 MCP 的 `image` content block，其余是 `text`（JSON 美化）

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AWT_BRIDGE` | `http://127.0.0.1:8787` | 桥地址 |
| `AWT_TOKEN` | 空 | 与桥一致 |
| `AWT_MCP_TIMEOUT` | `180000` | 单次工具调用超时（ms） |

## 扩展 → 页面 的内部消息

这些只在扩展内部使用，agent 一般用不到：

| 消息 | 方向 | 用途 |
| --- | --- | --- |
| `awt:page-state` | bg → content | 读取页面已应用规则 / 错误 |
| `awt:page-apply` | bg → content | 立即应用一批规则 |
| `awt:page-remove` | bg → content | 撤掉规则 |
| `awt:applied` | content → bg | 上报应用结果（更新 badge、转给 UI） |
| `awt:picked` | picker → bg | 拾取结果 |
| `awt:exec` | content → bg | inline eval 被 CSP 拦时的回退执行 |
