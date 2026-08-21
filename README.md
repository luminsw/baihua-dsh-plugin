# baihua-dsh-plugin

在 DeepSeek Harness（DSH）上加载的、供百花对接的桥接插件。它复用 DSH 自带的
`webServer`（默认 `127.0.0.1:3080`），对外提供一套 HTTP + WebSocket 接口，
让百花 Web 页面作为客户端驱动 DSH 的 agent 会话，并实时接收执行事件流
（流式 token、工具调用时间线、回合边界）。

## 暴露的接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/dsh-bridge/status` | 健康检查（含活跃会话数，**不鉴权**） |
| GET  | `/dsh-bridge/sessions` | 列出本进程管理过的会话（标题 / cwd / 时间 / 消息数） |
| POST | `/dsh-bridge/chat` | body `{ message, cwd?, sessionId? }` — 新建或续聊会话（非阻塞），返回 `{ ok, sessionId }` |
| GET  | `/dsh-bridge/sessions/{id}/history` | 返回某会话的全部事件（JSON 数组），供回放 |
| WS   | `/dsh-bridge/stream?sessionId=xxx&cwd=&token=` | 订阅会话事件流（每行一个 JSON 事件）；不带 `sessionId` 时由插件新建会话并先回 `{ kind: "session", sessionId }` |

> 除 `/status` 外的所有接口受 `token` 配置保护（见下文「安全」）。

### 事件流格式（每行一个 JSON）

- `turn/start` / `turn/end` / `step/start` / `step/end`：回合 / 步骤边界
- `user/message`：用户消息（`data.text` / `data.source`）
- `assistant/chunk`：流式 token 增量（`data.chunkType` = `text-delta` / `reasoning-delta` / `tool-call-delta`）
- `assistant/message`：完整回复（`data.text` / `data.toolCalls` / `data.usage`）
- `tool/call` / `tool/result`：工具调用开始 / 结束（`data.name` / `data.callId` / `data.isError`）

每个事件都带 `sessionId` / `seq` / `time` / `type`。

### 客户端典型流程（新建会话）

1. `WS /dsh-bridge/stream`（不带 sessionId，带 `cwd`）→ 先收 `{ kind: "session", sessionId }`，再收 `{ kind: "connected", sessionId }`。
2. `POST /dsh-bridge/chat` `{ message, sessionId }` → 立即返回 `{ ok, sessionId }`。
3. WebSocket 持续收到 `assistant/chunk` / `tool/call` / `turn/end` 等事件流，实时渲染。

续聊：`GET .../{id}/history` 拉历史，再 `WS ...?sessionId=id` 订阅，随后 `POST /chat`。

## 安全

桥接接口能让调用方**以本机 DSH 用户的权限驱动 agent**（任意 `cwd` + 全套工具），
属于高权限接口，请遵守：

- **保持 `webServer` 绑定 `127.0.0.1`**（`dsh web` 默认值）。绝不要用 `0.0.0.0`
  直接暴露桥接到局域网/公网。
- 建议配置共享密钥 `token`（在 `cordis.patch.yml` 的插件 `config` 中设置）。
  启用后，除 `/status` 外的所有 HTTP 接口要求 `Authorization: Bearer <token>`
  或查询参数 `?token=<token>`；WebSocket 升级要求 `?token=<token>`。百花侧
  通过 `DshApi:Token` 配置同步填入。
- 本插件**不做**速率限制 / 审计。若需要，请在反向代理层补充。

## 安装与加载

本插件是一个 Cordis 插件包，DSH 会把它装进 web profile 的依赖树。推荐从
GitHub 仓库安装：

```bash
# 1) 进入 web profile 目录，用 DSH 的 plugin 命令安装本包
cd "$HOME\.dsh\profiles\web"
dsh plugin --profile web add github:luminsw/baihua-dsh-plugin
```

> 也可从本地路径安装：`dsh plugin --profile web add link:C:\Users\lumin\source\repos\baihua-dsh-plugin`
> 或用 pnpm 直接：`pnpm add file:C:\Users\lumin\source\repos\baihua-dsh-plugin`。

2) 在用户级补丁 `~/.dsh/cordis.patch.yml` 的 `insert` 列表末尾追加插件
（如需鉴权，在 `config` 中设置 `token`）：

```yaml
- insert:
    # …… 已有的 MCP / 其他插件条目保持不变 ……
    - id: baihua-dsh-plugin
      name: 'baihua-dsh-plugin'
      config:
        token: 'your-shared-secret'   # 可选；不设置则保持开放（仅限回环）
```

3) 启动 DSH（`npx @deepseek-ai/dsh web` 或 `dsh web`），插件随 web profile
   在 webServer 上加载。验证：

```bash
curl http://127.0.0.1:3080/dsh-bridge/status
```

## 百花侧对接

百花 Web（`services/Baihua.Web`，Blazor Server）通过
`Baihua.Web.Services.DshBridgeService` 作为客户端对接本插件，对应页面为
`/dsh`。DSH 服务地址默认 `http://127.0.0.1:3080`，可在
`appsettings.json` 的 `DshApi` 节覆盖（`BaseUrl` / `Token` / `MaxBufferBytes`）。

## 特性 / 限制

- 会话列表默认只展示**本进程运行期间管理过**的会话；点开会话时通过
  `GET .../{id}/history` 补齐元数据。历史会话（本进程重启后）会通过 DSH 的
  `sessionPersistence` 服务读取持久化日志（自动处理项目目录分组与压缩格式）。
- `POST /chat` 是非阻塞的：agent 在后台执行，过程事件走 WebSocket，避免请求
  挂起拖住任务长跑。
- 模型路由默认沿用 DSH 的 `agentDefaultModel`（与 `dsh web` 当前选择一致）。
- `history` 响应受 `maxBufferedText`（默认 1 MB）限制，超出部分截断并返回
  `truncated: true`。

## 环境要求

- DeepSeek Harness ≥ 0.1.0-rc.7（`@deepseek-ai/dsh-agent` / `dsh-session` /
  `dsh-llm` / `dsh-host-webserver` / `cordis`）
- Node.js ≥ 22.19 或 ≥ 24

## License

MIT
