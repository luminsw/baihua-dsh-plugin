/**
 * baihua-dsh-plugin — 在 DeepSeek Harness 的 webServer 上暴露 HTTP + WebSocket 接口，
 * 让百花（Baihua.Web，Blazor）作为客户端驱动 DSH 的 agent 会话，
 * 并把 `session/event` 事件流实时推回给百花渲染（流式 token / 工具调用时间线）。
 *
 * 依赖 DSH 核心服务：agents / sessions / agentDefaultModel / webServer / sessionPersistence。
 * 安装到 DSH web profile 并挂到 `~/.dsh/cordis.patch.yml` 的 insert 列表即可加载。
 *
 * 安全：默认仅信任回环访问。请保持 webServer 绑定 127.0.0.1，并建议通过 `token`
 * 配置为除 /status 外的所有接口开启 Bearer 鉴权（HTTP `Authorization: Bearer <token>`
 * 或查询参数 `?token=`；WebSocket 使用 `?token=`）。
 * 若需要让局域网内的百花（如 k8s 容器里的百花 Web）访问桥接接口，配置 `lanListen`
 * （如 "0.0.0.0:3081"）：插件会起一个只暴露 /dsh-bridge/* 的小服务（同样带 token 鉴权），
 * DSH 核心 webServer 仍只监听 127.0.0.1，不会把 DSH 的远程执行界面暴露到网络。
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createBhOps } from "./ops.js";

export const name = "dsh-baihua-bridge";

export const inject = ["agents", "sessions", "webServer", "tools"];

export const Config = z.object({
  /** history 响应体大小上限（字节）；超出部分截断并标记 truncated。 */
  maxBufferedText: z.number().default(1_000_000),
  /** 可选共享密钥：设置后，除 /status 外的所有接口要求 Bearer token（HTTP）或 ?token=（WS）。 */
  token: z.string(),
  /** agentDefaultModel 服务缺失（或尚未选择）时回退使用的 provider 路由。 */
  fallbackProvider: z.string().default("deepseek-official"),
  /** agentDefaultModel 服务缺失（或尚未选择）时回退使用的模型。 */
  fallbackModel: z.string().default("deepseek-v4-flash"),
  /**
   * 可选：把桥接接口（/dsh-bridge/*）额外暴露到指定地址，如 "0.0.0.0:3081"。
   * 仅暴露桥接路由（带 token 鉴权），DSH 核心 webServer 仍只监听 127.0.0.1，
   * 不会把 DSH 的远程执行界面暴露到网络。设置非回环地址时必须同时配置 token。
   */
  lanListen: z.string().default(""),
  /**
   * 百花服务运维（bh CLI）入口。留空（""）则禁用运维端点与工具；
   * 默认 "bh"（宿主机 PATH 中），也可填绝对路径如
   * "/home/lumin/src/mdyj/baihuagu/tools/bh/bh.sh"。注意：这些操作会
   * 以宿主机用户权限执行启停/编译/更新，必须配合 token 鉴权。
   */
  bhCommand: z.string().default("bh"),
});

/** 从第一条用户消息抽取会话标题候选。 */
function titleForEvents(events) {
  for (const e of events) {
    if (e.type === "user/message") {
      const t = (e.data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      if (t) return t;
    }
  }
  return "(空会话)";
}

/** 会话里的用户消息数（不含注入上下文）。 */
function countUserMessages(events) {
  return events.filter((e) => e.type === "user/message").length;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function readJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 拉平文本块。 */
function textOfBlocks(blocks) {
  return (blocks || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 把会话事件精简成百花可渲染的 JSON 对象。 */
function eventToJson(sessionId, event) {
  const base = { sessionId, seq: event.seq, time: event.time, type: event.type };
  switch (event.type) {
    case "turn/start":
    case "turn/end":
    case "step/start":
    case "step/end":
      return { ...base, data: event.data };
    case "user/message":
      return { ...base, data: { text: textOfBlocks(event.data.content), source: event.data.source?.kind } };
    case "assistant/chunk": {
      const c = event.data.chunk;
      return {
        ...base,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          chunkType: c.type,
          text: "text" in c ? c.text : undefined,
          index: "index" in c ? c.index : undefined,
        },
      };
    }
    case "assistant/message": {
      const blocks = event.data.message.content || [];
      const toolCalls = blocks
        .filter((b) => b.type === "tool-call")
        .map((b) => ({ id: String(b.id), name: b.name, arguments: b.arguments }));
      return {
        ...base,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          text: textOfBlocks(blocks),
          toolCalls,
          usage: event.data.usage ?? undefined,
        },
      };
    }
    case "tool/call":
      return {
        ...base,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          callId: String(event.data.callId),
          name: event.data.name,
          arguments: event.data.arguments,
        },
      };
    case "tool/result": {
      const blocks = (event.data.message.content || []).filter(
        (b) => b.type === "text" || b.type === "reasoning",
      );
      const text = blocks.map((b) => b.text ?? "").join("");
      return {
        ...base,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          callId: String(event.data.message.source?.callId ?? ""),
          text,
          isError: event.data.error != null,
          error: event.data.error ?? undefined,
        },
      };
    }
    default:
      return { ...base, data: event.data };
  }
}

/**
 * Cordis 插件入口。复用 DSH 的 `ctx.webServer`（默认 127.0.0.1:3080）暴露桥接路由；
 * 配置 `lanListen` 时额外在指定地址起一个只暴露 /dsh-bridge/* 的局域网小服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ maxBufferedText: number, token?: string, fallbackProvider: string, fallbackModel: string, lanListen?: string }} config
 */
export function apply(ctx, config) {
  /** 活跃 agent：sessionId -> { handle, sockets } */
  const active = new Map();
  /** 会话元数据清单（内存，供列表展示）。 */
  const metas = [];
  const maxBufferedText = config.maxBufferedText;

  // ---------- 可选鉴权 ----------
  const bridgeToken = config.token;
  function authorized(req) {
    if (!bridgeToken) return true;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("token") === bridgeToken) return true;
    const header = req.headers?.authorization;
    return typeof header === "string" && header === `Bearer ${bridgeToken}`;
  }
  function unauthorized(res) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }

  // ---------- 可选：桥接接口局域网监听（仅 /dsh-bridge/*，DSH 核心保持 127.0.0.1） ----------
  const lanListen = config.lanListen;
  let lanHost = null;
  let lanPort = 0;
  if (lanListen) {
    const idx = lanListen.lastIndexOf(":");
    if (idx <= 0) {
      throw new Error(`[dsh-baihua-bridge] lanListen 格式应为 host:port，收到 "${lanListen}"`);
    }
    lanHost = lanListen.slice(0, idx);
    lanPort = Number(lanListen.slice(idx + 1));
    if (!Number.isInteger(lanPort) || lanPort <= 0 || lanPort > 65535) {
      throw new Error(`[dsh-baihua-bridge] lanListen 端口无效: "${lanListen}"`);
    }
    const loopback = lanHost === "127.0.0.1" || lanHost === "localhost" || lanHost === "::1";
    if (!loopback && !bridgeToken) {
      throw new Error("[dsh-baihua-bridge] lanListen 对外暴露（非回环地址）必须同时配置 token");
    }
  }

  function upsertMeta(m) {
    const i = metas.findIndex((x) => x.id === m.id);
    if (i >= 0) metas[i] = m;
    else metas.push(m);
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function subscribeSocket(sessionId, ws) {
    const a = active.get(sessionId);
    if (!a) return;
    a.sockets.add(ws);
    ws.on("close", () => a.sockets.delete(ws));
    ws.on("error", () => a.sockets.delete(ws));
  }

  function broadcast(session, event) {
    const a = active.get(session.id);
    if (!a || a.sockets.size === 0) return;
    const payload = JSON.stringify(eventToJson(session.id, event));
    for (const ws of a.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {
          /* noop */
        }
      }
    }
  }

  async function refreshMetaFromAgent(handle, title) {
    const events = handle.agent.session.events;
    const existing = metas.find((m) => m.id === handle.agent.id);
    upsertMeta({
      id: handle.agent.id,
      title: title ?? titleForEvents(events),
      cwd: handle.agent.session.header.cwd,
      createdAt: existing?.createdAt ?? handle.agent.session.header.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messageCount: countUserMessages(events),
    });
  }

  async function ensureAgent(cwd, sessionId) {
    if (sessionId && active.has(sessionId)) {
      return { agent: active.get(sessionId).handle.agent, id: sessionId, created: false };
    }
    const defaultModel = ctx.get("agentDefaultModel");
    const selection =
      defaultModel?.currentSelection?.() ?? {
        provider: config.fallbackProvider,
        model: config.fallbackModel,
      };
    const workingDir = cwd ?? process.cwd();

    let handle;
    let id = sessionId;
    if (id) {
      handle = await ctx.agents.resume({ resumeSessionId: SessionId(id) });
    } else {
      id = `session-${randomUUID()}`;
      handle = await ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: workingDir },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined });
          // 会话销毁时清理桥接侧状态，避免 active 表悬挂
          agentCtx.on("agent/disposed", () => {
            const entry = active.get(agentCtx.agent.id);
            if (entry) {
              for (const ws of entry.sockets) {
                try {
                  ws.close(1001, "disposed");
                } catch {
                  /* noop */
                }
              }
              active.delete(agentCtx.agent.id);
            }
          });
        },
      });
    }
    await handle.agent.whenIdle();
    active.set(id, { handle, sockets: new Set() });
    return { agent: handle.agent, id, created: !sessionId };
  }

  async function runUpdate(handle) {
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);
    await refreshMetaFromAgent(handle);
  }

  const webServer = ctx.get("webServer");
  const wss = new WebSocketServer({ noServer: true });

  // ---------- 百花服务运维（bh CLI）----------
  const bhOps = config.bhCommand ? createBhOps(config) : null;
  const registerBhTools = () => {
    if (!bhOps) return;
    const j = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
    ctx.tools.register(
      defineTool({
        name: "bh_status",
        description:
          "查询百花服务的运行状态（family/ai/vault/webui/openvino/postgres 各服务的就绪副本数、镜像、重启次数）与运行中的 bh 长操作。宿主机运维工具，只读。",
        parameters: {},
        output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute() {
          const r = await bhOps.status();
          return r.ok ? j(r.status) + (r.runningOps?.length ? `\n\n运行中的操作：\n${j(r.runningOps)}` : "") : `失败：${r.error}`;
        },
      }),
    );
    for (const name of ["start", "stop", "restart"]) {
      ctx.tools.register(
        defineTool({
          name: `bh_${name}`,
          description: `对百花某个服务执行 ${name}（family/ai/vault/webui/openvino/postgres，可省略 bh- 前缀）。宿主机运维操作，执行前请先向用户确认。`,
          parameters: { service: { type: "string", required: true, description: "服务名，如 family / ai / webui" } },
          output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
          async execute(args) {
            const r = bhOps.action(name, String(args.service));
            return r.ok ? `✅ bh ${name} ${args.service}：${r.stdout || "完成"}` : `❌ bh ${name} 失败：${r.stderr || r.stdout || "未知错误"}`;
          },
        }),
      );
    }
    ctx.tools.register(
      defineTool({
        name: "bh_build",
        description:
          "编译百花镜像（可指定服务 family/ai/vault/webui/openvino，省略则编译全部）。耗时数分钟，后台执行，返回 opId 后用 bh_op_status 查询。执行前请先向用户确认。",
        parameters: { service: { type: "string", description: "要编译的服务（可选，默认全部）" } },
        output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
          const r = bhOps.startLongAction("build", args.service ? String(args.service) : "");
          return r.ok
            ? `已开始编译（opId=${r.opId}）。用 bh_op_status 查询进度，或用 bh_logs 看服务日志。`
            : `启动失败：${r.error}`;
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "bh_update",
        description:
          "百花一键更新：git pull 最新代码 → 编译变更涉及的镜像 → 重新部署（等同 bh update）。耗时可能很长，后台执行，返回 opId。执行前请务必先向用户确认。",
        parameters: {},
        output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute() {
          const r = bhOps.startLongAction("update");
          return r.ok ? `已开始更新（opId=${r.opId}）。用 bh_op_status 查询进度。` : `启动失败：${r.error}`;
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "bh_logs",
        description: "查看百花某个服务的最近日志（默认 50 行，最多 500）。参数 service 如 family/ai/webui。",
        parameters: {
          service: { type: "string", required: true, description: "服务名，如 family / ai / webui" },
          lines: { type: "integer", description: "行数（默认 50）" },
        },
        output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
          const r = bhOps.logs(String(args.service), Number(args.lines) || 50);
          return r.ok ? (r.stdout || "(空)") : `❌ 获取日志失败：${r.stderr || r.stdout || "未知错误"}`;
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "bh_op_status",
        description: "查询 bh 长操作（编译/更新）的进度与最近输出。参数 opId 来自 bh_build / bh_update 的返回值。",
        parameters: { opId: { type: "string", required: true, description: "操作 ID，如 op-1724..." } },
        output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
        async execute(args) {
          const op = bhOps.opStatus(String(args.opId));
          return op ? j(op) : "未找到该操作（可能进程已重启，操作记录不持久）。";
        },
      }),
    );
  };
  registerBhTools();

  // ---------- 百花服务运维 HTTP 端点（/dsh-bridge/bh/*，全部 token 鉴权） ----------
  function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  }

  function handleBh(req, res) {
    if (!authorized(req)) return unauthorized(res);
    if (!bhOps) return sendJson(res, 503, { ok: false, error: "bh 运维未启用（未配置 bhCommand）" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const m = () => {
      // 读取 POST body（仅 action 需要）
      return new Promise((resolve) => {
        if (req.method !== "POST") return resolve(null);
        readBody(req).then(resolve, () => resolve(null));
      });
    };
    if (path === "/dsh-bridge/bh/status" && req.method === "GET") {
      void bhOps.status().then((r) => (r.ok ? sendJson(res, 200, r) : sendJson(res, 502, { ok: false, error: r.error })));
      return;
    }
    if (path === "/dsh-bridge/bh/ops" && req.method === "GET") {
      sendJson(res, 200, { ok: true, ops: bhOps.listOps() });
      return;
    }
    const opM = /^\/dsh-bridge\/bh\/ops\/([^/]+)$/.exec(path);
    if (opM && req.method === "GET") {
      const op = bhOps.opStatus(decodeURIComponent(opM[1]));
      sendJson(res, op ? 200 : 404, op ? { ok: true, op } : { ok: false, error: "操作不存在" });
      return;
    }
    if (path === "/dsh-bridge/bh/logs" && req.method === "GET") {
      const r = bhOps.logs(url.searchParams.get("service") ?? "", url.searchParams.get("lines") ?? "");
      sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true, stdout: r.stdout } : { ok: false, error: r.stderr || r.stdout || "获取日志失败" });
      return;
    }
    if (path === "/dsh-bridge/bh/action" && req.method === "POST") {
      void m().then((input) => {
        const body = input ? readJson(input) : null;
        const action = String(body?.action ?? "");
        const service = String(body?.service ?? "");
        if (bhOps.action && ["start", "stop", "restart"].includes(action)) {
          const r = bhOps.action(action, service);
          return sendJson(res, r.ok ? 200 : 400, r);
        }
        if (["build", "update", "up", "deploy"].includes(action)) {
          const r = bhOps.startLongAction(action, service);
          return sendJson(res, r.ok ? 200 : 400, r);
        }
        return sendJson(res, 400, { ok: false, error: `不支持的操作: ${action}` });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  // ==================== 桥接路由处理器（webServer 与局域网监听共用） ====================

  // GET /dsh-bridge/status（健康检查，不鉴权）
  function handleStatus(_req, res) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        service: "dsh-baihua-bridge",
        ok: true,
        activeSessions: active.size,
        loadedSessions: metas.length,
        pid: process.pid,
      }),
    );
  }

  // GET /dsh-bridge/sessions（精确）
  function handleSessions(req, res) {
    if (!authorized(req)) return unauthorized(res);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ sessions: metas }));
  }

  // POST /dsh-bridge/chat
  async function handleChat(req, res) {
    if (!authorized(req)) return unauthorized(res);
    try {
      const body = await readBody(req);
      const input = readJson(body);
      if (!input || !input.message || !input.message.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "message is required" }));
        return;
      }
      const { agent, id } = await ensureAgent(input.cwd, input.sessionId);
      // 不 await 本轮结束：agent 在后台异步执行，执行过程通过 WS 事件流推送。
      // 这样客户端可以先拿到 sessionId 并打开 WS 订阅，再实时接收 assistant/chunk。
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: input.message }],
          source: { kind: "user" },
        }),
      );
      // 后台等待停稳，更新元数据
      void (async () => {
        try {
          await runUpdate(active.get(id).handle);
        } catch (e) {
          console.error(`[dsh-baihua-bridge] chat run error: ${e instanceof Error ? e.message : e}`);
        }
      })();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          sessionId: id,
          messageCount: countUserMessages(agent.session.events),
        }),
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  // GET /dsh-bridge/sessions/{id}/history（前缀）
  async function handleHistory(req, res) {
    const m = /^\/dsh-bridge\/sessions\/([^/]+)\/history$/.exec(req.url ?? "/");
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!authorized(req)) return unauthorized(res);
    const id = decodeURIComponent(m[1]);
    try {
      const live = active.get(id)?.handle.agent;
      let events;
      if (live) {
        events = live.session.events;
      } else {
        // 非活跃会话：走 DSH 官方持久化服务读取（JSONL 后端支持原始 artifact 读取，
        // 自动处理项目目录分组与 zstd 解压），不再自行猜测磁盘布局。
        const persistence = ctx.get("sessionPersistence");
        const raw =
          persistence && persistence.supportsRawArtifacts
            ? await persistence.readRaw(SessionId(id))
            : undefined;
        if (!raw) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `session ${id} is not live and has no persisted log`,
            }),
          );
          return;
        }
        events = raw.content
          .split(/\r?\n/)
          .map(readJson)
          .filter(Boolean);
      }
      const existing = metas.find((x) => x.id === id);
      upsertMeta({
        id,
        title: titleForEvents(events),
        cwd: live?.session.header.cwd ?? existing?.cwd,
        createdAt: live?.session.header.createdAt ?? existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        messageCount: countUserMessages(events),
      });
      // 按 maxBufferedText 截断序列化体积，避免单次响应过大
      const parts = [];
      let total = 0;
      let truncated = false;
      for (const e of events) {
        const s = JSON.stringify(eventToJson(id, e));
        if (maxBufferedText > 0 && total + s.length > maxBufferedText) {
          truncated = true;
          break;
        }
        total += s.length;
        parts.push(s);
      }
      const title = titleForEvents(events);
      const body =
        `{"sessionId":${JSON.stringify(id)},"title":${JSON.stringify(title)},` +
        `"events":[${parts.join(",")}]${truncated ? `,"truncated":true` : ""}}`;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  // WS upgrade: /dsh-bridge/stream?sessionId=xxx&token=
  function handleWsUpgrade(req, socket, head) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (bridgeToken && url.searchParams.get("token") !== bridgeToken) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
          JSON.stringify({ ok: false, error: "unauthorized" }),
      );
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const cwd = url.searchParams.get("cwd") ?? undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const send = (obj) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      };
      const subscribe = (sid) => {
        if (!active.has(sid)) {
          send({ kind: "error", message: `session ${sid} not active` });
          ws.close();
          return;
        }
        subscribeSocket(sid, ws);
        send({ kind: "connected", sessionId: sid });
      };
      if (sessionId) {
        // 续聊已存在的会话
        subscribe(sessionId);
        return;
      }
      // 未指定 sessionId：新建一个 agent 会话，先回客户端 sessionId 供 POST /chat 使用
      ensureAgent(cwd, undefined)
        .then(({ id }) => {
          if (ws.readyState === WebSocket.OPEN) {
            send({ kind: "session", sessionId: id });
          }
          subscribe(id);
        })
        .catch((e) => {
          send({ kind: "error", message: e instanceof Error ? e.message : String(e) });
          try {
            ws.close();
          } catch {
            /* noop */
          }
        });
    });
  }

  // ---------- 注册（DSH webServer + 可选局域网监听），全部包在 effect 里随卸载自动释放 ----------
  ctx.effect(() => {
    const disposers = [];

    // DSH webServer（127.0.0.1:3080）
    const disposeStatus = webServer?.register({ kind: "exact", path: "/dsh-bridge/status", handler: handleStatus });
    if (disposeStatus) disposers.push(disposeStatus);
    const disposeSessions = webServer?.register({ kind: "exact", path: "/dsh-bridge/sessions", handler: handleSessions });
    if (disposeSessions) disposers.push(disposeSessions);
    const disposeChat = webServer?.register({ kind: "exact", path: "/dsh-bridge/chat", handler: handleChat });
    if (disposeChat) disposers.push(disposeChat);
    const disposeHistory = webServer?.register({ kind: "prefix", path: "/dsh-bridge/sessions", handler: handleHistory });
    if (disposeHistory) disposers.push(disposeHistory);
    const disposeBh = bhOps ? webServer?.register({ kind: "prefix", path: "/dsh-bridge/bh", handler: handleBh }) : null;
    if (disposeBh) disposers.push(disposeBh);
    const disposeUpgrade = webServer?.registerUpgrade({ path: "/dsh-bridge/stream", handler: handleWsUpgrade });
    if (disposeUpgrade) disposers.push(disposeUpgrade);

    // 可选局域网监听：只暴露 /dsh-bridge/*（token 鉴权），其余路径一律 404
    let lanServer = null;
    if (lanListen) {
      lanServer = createServer((req, res) => {
        let path;
        try {
          path = new URL(req.url ?? "/", "http://localhost").pathname;
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (path === "/dsh-bridge/status") return handleStatus(req, res);
        if (path === "/dsh-bridge/sessions") return handleSessions(req, res);
        if (path === "/dsh-bridge/chat") {
          void handleChat(req, res);
          return;
        }
        if (/^\/dsh-bridge\/sessions\/[^/]+\/history$/.test(path)) {
          void handleHistory(req, res);
          return;
        }
        if (path.startsWith("/dsh-bridge/bh")) {
          handleBh(req, res);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      lanServer.on("upgrade", handleWsUpgrade);
      lanServer.listen(lanPort, lanHost);
      console.log(`[dsh-baihua-bridge] 桥接接口已额外监听 ${lanHost}:${lanPort}（仅 /dsh-bridge/*）`);
    }

    // 事件转发监听（Cordis 会在 fiber 卸载时自动移除 ctx.on 监听器）
    ctx.on("session/event", (session, event) => {
      if (active.has(session.id)) broadcast(session, event);
    });

    return () => {
      for (const ws of wss.clients) {
        try {
          ws.close(1001, "shutdown");
        } catch {
          /* noop */
        }
      }
      try {
        wss.close();
      } catch {
        /* noop */
      }
      if (lanServer) {
        try {
          lanServer.close();
        } catch {
          /* noop */
        }
      }
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* noop */
        }
      }
    };
  });

  console.log(
    `[dsh-baihua-bridge] loaded${bridgeToken ? " (token auth enabled)" : " (open, loopback only)"}${lanListen ? `, lan ${lanListen}` : ""}.`,
  );
}
