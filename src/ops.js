/**
 * ops.js — 百花服务运维（bh CLI 封装）。
 *
 * 运行在 DSH 所在宿主机（Node 进程），通过 child_process 调用 bh（bash）：
 *  - 快速操作（status/start/stop/restart/logs）：spawnSync + 超时，同步返回；
 *  - 长操作（build/update/up/deploy）：后台 spawn，输出落盘 + 内存 tail，
 *    返回 opId 供轮询（进程存活期间有效）。
 *
 * 说明：bh 命令本身带自动提权（sudo），因此本模块要求宿主机可免密 sudo；
 * 所有对外入口（HTTP / 工具）都必须经过桥接 token 鉴权。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const QUICK_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const MAX_TAIL = 16_000;

/** 长操作允许的命令（避免任意命令执行面）。 */
const LONG_ACTIONS = new Set(["build", "update", "up", "deploy", "build-restart"]);
/** 快速操作允许的命令。 */
const QUICK_ACTIONS = new Set(["start", "stop", "restart"]);

export function createBhOps(config) {
  const bhCommand = config.bhCommand || "bh";
  const ops = new Map();
  let seq = 0;

  function runQuick(args, timeoutMs = QUICK_TIMEOUT_MS) {
    try {
      const r = spawnSync(bhCommand, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      const timedOut = r.error?.killed === true;
      return {
        ok: r.status === 0,
        code: r.status ?? null,
        timedOut,
        stdout: (r.stdout || "").trim(),
        stderr: (r.stderr || "").trim(),
      };
    } catch (e) {
      return { ok: false, error: e.message, stdout: "", stderr: "" };
    }
  }

  function startLong(action, service) {
    const id = `op-${Date.now()}-${++seq}`;
    const logPath = `/tmp/bh-${id}.log`;
    const args = [action];
    if (service) args.push(service);
    let tail = "";
    const append = (s) => {
      tail = (tail + s).slice(-MAX_TAIL);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* noop */
      }
    };
    const entry = {
      id,
      action,
      service: service ?? "",
      startedAt: new Date().toISOString(),
      running: true,
      exitCode: null,
      logPath,
    };
    const child = spawn(bhCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => append(d.toString()));
    child.stderr.on("data", (d) => append(d.toString()));
    child.on("close", (code) => {
      entry.running = false;
      entry.exitCode = code;
      append(`\n[op] exit code: ${code}\n`);
    });
    child.on("error", (err) => {
      entry.running = false;
      entry.error = err.message;
      append(`\n[op] spawn error: ${err.message}\n`);
    });
    ops.set(id, entry);
    return entry;
  }

  function opView(op) {
    return {
      id: op.id,
      action: op.action,
      service: op.service,
      startedAt: op.startedAt,
      running: op.running,
      exitCode: op.exitCode,
      error: op.error ?? null,
      tail: op.tail?.slice(-2000) ?? "",
    };
  }

  /** 状态总览（bh status --json 解析 + 运行中的长操作）。 */
  async function status() {
    const r = runQuick(["status", "--json"], STATUS_TIMEOUT_MS);
    if (!r.ok) {
      return {
        ok: false,
        error: r.timedOut ? "bh status 超时" : r.stderr || r.stdout || `bh status 失败（exit ${r.code}）`,
      };
    }
    try {
      const parsed = JSON.parse(r.stdout);
      return { ok: true, status: parsed, runningOps: [...ops.values()].map(opView) };
    } catch {
      return { ok: false, error: `bh status 输出不是 JSON：${r.stdout.slice(0, 300)}` };
    }
  }

  /** 快速操作：start / stop / restart <svc>。 */
  function action(name, service) {
    if (!QUICK_ACTIONS.has(name)) return { ok: false, error: `不支持的快速操作: ${name}` };
    if (!service) return { ok: false, error: `bh ${name} 需要指定服务（family/ai/vault/webui/openvino/postgres）` };
    const r = runQuick([name, service]);
    return { ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }

  /**
   * 链式长操作：build-restart <svc> —— 先 bh build <svc>，成功（exit 0）后自动
   * bh restart <svc>，整个过程记入同一个 op（tail 连续追加）。
   */
  function startBuildRestart(service) {
    const id = `op-${Date.now()}-${++seq}`;
    const logPath = `/tmp/bh-${id}.log`;
    let tail = "";
    const append = (s) => {
      tail = (tail + s).slice(-MAX_TAIL);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* noop */
      }
    };
    const entry = {
      id,
      action: "build-restart",
      service: service ?? "",
      startedAt: new Date().toISOString(),
      running: true,
      exitCode: null,
      logPath,
    };
    ops.set(id, entry);

    const run = (args, label) =>
      new Promise((resolve) => {
        append(`\n===== ${label}（bh ${args.join(" ")}）=====\n`);
        const child = spawn(bhCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (d) => append(d.toString()));
        child.stderr.on("data", (d) => append(d.toString()));
        child.on("close", (code) => {
          append(`\n[${label}] exit code: ${code}\n`);
          resolve(code);
        });
        child.on("error", (err) => {
          append(`\n[${label}] spawn error: ${err.message}\n`);
          entry.error = err.message;
          resolve(-1);
        });
      });

    void (async () => {
      const buildArgs = ["build"];
      if (service) buildArgs.push(service);
      const buildCode = await run(buildArgs, "编译");
      if (buildCode !== 0) {
        entry.running = false;
        entry.exitCode = buildCode;
        append(`\n[build-restart] 编译失败（exit ${buildCode}），已跳过重启。\n`);
        return;
      }
      const restartArgs = ["restart", service];
      const restartCode = await run(restartArgs, "滚动重启");
      entry.running = false;
      entry.exitCode = restartCode;
      append(`\n[build-restart] ${restartCode === 0 ? "完成 ✅" : "重启失败（exit " + restartCode + "）"}。\n`);
    })();

    return entry;
  }

  /** 长操作：build [svc] / update / up [--all] / deploy / build-restart <svc>。返回 opId。 */
  function startLongAction(name, service) {
    if (!LONG_ACTIONS.has(name)) return { ok: false, error: `不支持的长操作: ${name}` };
    if (name === "build-restart") {
      if (!service) return { ok: false, error: "build-restart 需要指定服务（family/ai/vault/webui/openvino/postgres）" };
      const op = startBuildRestart(service);
      return { ok: true, opId: op.id, action: "build-restart", service };
    }
    if (name === "up" && service === "--all") {
      const op = startLong("up", "--all");
      return { ok: true, opId: op.id, action: "up", service: "--all" };
    }
    const op = startLong(name, service);
    return { ok: true, opId: op.id, action: name, service: service ?? "" };
  }

  function listOps() {
    return [...ops.values()].map(opView);
  }

  function opStatus(id) {
    const op = ops.get(id);
    return op ? opView(op) : null;
  }

  function logs(service, lines) {
    const svc = service || "family";
    const n = Math.min(Math.max(1, Number(lines) || 50), 500);
    const r = runQuick(["logs", svc, String(n)], STATUS_TIMEOUT_MS);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }

  return { status, action, startLongAction, listOps, opStatus, logs };
}
