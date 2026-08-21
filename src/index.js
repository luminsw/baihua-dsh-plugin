/**
 * baihua-dsh-plugin — 在 DeepSeek Harness 的 webServer 上暴露 HTTP + WebSocket 接口，
 * 让百花（Baihua.Web，Blazor）作为客户端驱动 DSH 的 agent 会话，
 * 并把 `session/event` 事件流实时推回给百花渲染（流式 token / 工具调用时间线）。
 *
 * 依赖 DSH 核心服务：agents / sessions / agentDefaultModel / webServer。
 * 安装到 DSH web profile 并挂到 `~/.dsh/cordis.patch.yml` 的 insert 列表即可加载。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-baihua-bridge";

const inject = ["agents", "sessions", "agentDefaultModel", "webServer"];

export const Config = z.object({
  maxBufferedText: z.number().default(1_000_000),
});

/** 会话文件根目录（持久化 JSONL 所在）。 */
function sessionRoot() {
  return join(process.env.DSH_HOME ?? process.env.USERPROFILE ?? ".", ".dsh", "sessions");
}

/** 从第一条用户消息抽取会话标题候选。 */
function titleFromPrompt(prompt) {
  const t = prompt.trim().replace(/\s+/g, " ").slice(0, 60);
  return t || "(空任务)";
}

/** 从会话事件序列推断标题：第一条 user 消息文本。 */
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
 * Cordis 插件入口。复用 DSH 的 `ctx.webServer`（默认 127.0.0.1:3080）暴露桥接路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ maxBufferedText: number }} config
 */
export function apply(ctx, config) {
  /** 活跃 agent：sessionId -> { handle, sockets } */
  const active = new Map();
  /** 会话元数据清单（内存，供列表展示）。 */
  const metas = [];

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

  /** 在全局 session/event 火焰线上，仅转发我们管理的 session。 */
  ctx.on("session/event", (session, event) => {
    if (active.has(session.id)) broadcast(session, event);
  });

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
      defaultModel?.currentSelection?.() ?? { provider: "deepseek-official", model: "deepseek-v4-flash" };
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

  // ---------- GET /dsh-bridge/status ----------
  webServer?.register({
    kind: "exact",
    path: "/dsh-bridge/status",
    handler: (_req, res) => {
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
    },
  });

  // ---------- GET /dsh-bridge/sessions (精确) ----------
  webServer?.register({
    kind: "exact",
    path: "/dsh-bridge/sessions",
    handler: (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sessions: metas }));
    },
  });

  // ---------- POST /dsh-bridge/chat ----------
  webServer?.register({
    kind: "exact",
    path: "/dsh-bridge/chat",
    handler: async (req, res) => {
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
    },
  });

  // ---------- GET /dsh-bridge/sessions/{id}/history (前缀) ----------
  webServer?.register({
    kind: "prefix",
    path: "/dsh-bridge/sessions",
    handler: async (req, res) => {
      const m = /^\/dsh-bridge\/sessions\/([^/]+)\/history$/.exec(req.url ?? "/");
      if (!m) {
        res.writeHead(404);
        res.end();
        return;
      }
      const id = decodeURIComponent(m[1]);
      try {
        const live = active.get(id)?.handle.agent;
        let events;
        if (live) {
          events = live.session.events;
        } else {
          const file = join(sessionRoot(), `${id}.jsonl`);
          const raw = await readFile(file, "utf8");
          events = raw
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
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            sessionId: id,
            title: titleForEvents(events),
            events: events.map((e) => eventToJson(id, e)),
          }),
        );
      } catch (e) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    },
  });

  // ---------- WS upgrade: /dsh-bridge/stream?sessionId=xxx ----------
  const wss = new WebSocketServer({ noServer: true });
  ctx.effect(() => {
    const cleanup = () => {
      for (const ws of wss.clients) ws.close(1001, "shutdown");
    };
    (globalThis).__dshBridgeCleanup = cleanup;
    return () => {
      try {
        wss.close();
      } catch {
        /* noop */
      }
    };
  });

  webServer?.registerUpgrade({
    path: "/dsh-bridge/stream",
    handler: (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
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
    },
  });

  console.log(`[dsh-baihua-bridge] loaded.`);
}
