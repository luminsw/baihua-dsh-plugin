/**
 * ops.js — 百花服务运维（bh CLI 封装）。
 *
 * 运行在 DSH 所在宿主机（Node 进程），通过 child_process 调用 bh（bash）：
 *  - 快速操作（status/start/stop/restart/logs）：**异步 spawn + 超时**（绝不 spawnSync——
 *    DSH 是单线程，同步调用会把整个 harness 冻住，实测 `bh status --json` 要 6.4s）；
 *    status 另有 5s 新鲜期缓存与「超时回退旧快照」；
 *  - 长操作（build/update/up/deploy）：后台 spawn，输出落盘 + 内存 tail，
 *    返回 opId 供轮询（进程存活期间有效）。
 *
 * 说明：bh 命令本身带自动提权（sudo），因此本模块要求宿主机可免密 sudo；
 * 所有对外入口（HTTP / 工具）都必须经过桥接 token 鉴权。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const QUICK_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const MAX_TAIL = 16_000;
/**
 * 状态采集上限：`bh status --json` 在 native cell 上要 6s 左右（WMI/端口/git 扫描），
 * 这里给一个硬上限，超时即 kill，避免请求悬挂。
 */
const STATUS_HARD_TIMEOUT_MS = 12_000;
/** 状态缓存新鲜期：窗口内的重复请求（UI 卡片轮询 / 工具连续调用）直接复用，不再起子进程。 */
const STATUS_CACHE_TTL_MS = 5_000;
/** UI 卡片最多同步等这么久；超时先回退旧快照（stale=true），采集在后台继续。 */
const STATUS_UI_MAX_WAIT_MS = 1_200;

/** NuGet 包缓存损坏的特征错误（NETSDK1064 / restore 部分完成 / 包 not found）。命中即清理 buildkit 缓存后重试。 */
const NUGET_CACHE_ERROR_RE = /NETSDK1064|only partially completed|was not found/i;

/** 长操作允许的命令（避免任意命令执行面）。 */
// 2026-11-15 收窄：只剩 build —— DSH 不再负责把百花拉起来。
// 原因：插件经 child_process 起的服务是 DSH 的后代进程，DSH 重启/退出时整棵树可能被
// job object 连带杀掉（历史踩过）。启动百花交给宿主机 `bh start` / 登录自启，
// 插件只保留「看状态、看日志、编译、停止」这类不会留下常驻子进程的动作。
const LONG_ACTIONS = new Set(["build"]);
/** 快速操作允许的命令。 */
const QUICK_ACTIONS = new Set(["stop"]);

/** 由 bh 可执行文件路径推断百花仓库根：从 bhCommand 所在目录向上逐级找 tools/bh/bh.sh（或 .git）。 */
function inferRepoRoot(bhCommand) {
  try {
    let dir = resolve(dirname(bhCommand));
    for (let i = 0; i < 8; i++) {
      if (isBaihuaRepo(dir)) return dir;
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fallthrough */
  }
  return process.cwd();
}

/** 百花仓库源码的常见候选根目录（Linux 与 Windows 通用，按平台展开 ~）。 */
function defaultCloneCandidates() {
  const home = homedir();
  return [
    join(home, "src", "mdyj", "baihua"),
    join(home, "src", "mdyj", "baihuagu"),
    join(home, "src", "baihua"),
    join(home, "src", "baihuagu"),
    join(home, "baihua"),
    join(home, "work", "baihua"),
  ];
}

/** 展开开头的 ~（Windows 与 Linux 通用）。 */
function expandHomePath(p) {
  return typeof p === "string" && /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p;
}

/** 百花源码的可靠标志：仓库根下存在 tools/bh/bh.sh（仅 baihua 仓库有）。 */
function isBaihuaRepo(root) {
  return existsSync(join(root, "tools", "bh", "bh.sh"));
}

/** 检测本机是否已有百花源码：BAIHUA_HOME > 常见候选路径 > 当前目录向上。返回仓库根或 null。 */
export function detectRepoRoot(opts = {}) {
  const { bhCommand, gitRepo, extraCandidates = [] } = opts;
  const tried = [];
  const tryPath = (dir) => {
    if (!dir) return null;
    const root = resolve(expandHomePath(dir));
    if (tried.includes(root)) return null;
    tried.push(root);
    if (isBaihuaRepo(root)) return root;
    return null;
  };
  // 1) 显式配置 gitRepo / BAIHUA_HOME
  if (gitRepo) {
    const r = tryPath(gitRepo);
    if (r) return r;
  }
  if (process.env.BAIHUA_HOME) {
    const r = tryPath(process.env.BAIHUA_HOME);
    if (r) return r;
  }
  // 2) 常见候选路径
  for (const c of [...extraCandidates, ...defaultCloneCandidates()]) {
    const r = tryPath(c);
    if (r) return r;
  }
  // 3) 从 bhCommand 推断（bh 指向定位器时其目标仓库即源码）
  if (bhCommand) {
    const r = tryPath(inferRepoRoot(bhCommand));
    if (r) return r;
  }
  // 4) 当前目录向上找 tools/bh/bh.sh
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (isBaihuaRepo(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function createBhOps(config) {
  const bhCommand = config.bhCommand || "bh";
  /**
   * git 提交/推送的仓库根：
   * - 显式配置了 gitRepo：直接使用（随后由 verifyGitRepo 校验，路径不对会明确报错，
   *   不会静默回退到候选路径）；
   * - 未配置：从常见路径（~/src/baihua 等）、BAIHUA_HOME、bhCommand 所在目录自动推断；
   *   全部未命中则为 null（此时 git 操作快速失败，不再回退到 process.cwd() 造成
   *   `fatal: not a git repository`）。
   */
  const explicitGitRepo =
    config.gitRepo && String(config.gitRepo).trim()
      ? resolve(expandHomePath(String(config.gitRepo).trim()))
      : "";
  const gitRepo = explicitGitRepo || (detectRepoRoot({ bhCommand, gitRepo: "" }) ?? null);
  const ops = new Map();
  let seq = 0;

  // Windows：bh 是 .cmd/.ps1，Node 无法直接 spawn（bare 名 ENOENT、.cmd EINVAL），
  // 统一经 cmd.exe /d /s /c 包装（Linux/macOS 直接 spawn）。
  const winCmd = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : null;
  function bhArgv(args) {
    if (!winCmd) return [bhCommand, args];
    const line = [bhCommand, ...args]
      .map((a) => {
        const s = String(a);
        return /[\s"]/.test(s) && !/^".*"$/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
      })
      .join(" ");
    return [winCmd, ["/d", "/s", "/c", line]];
  }

  /**
   * 异步执行 bh 子命令：不阻塞事件循环。
   *
   * ⚠️ 不要改回 spawnSync：DSH 是单线程 Node 进程，同步执行子命令会把整个 harness
   * （Web UI、SSE、流式输出）冻住；实测 `bh status --json` 一次要 6.4s，同步版就是 6.4s 全站卡死。
   * 超时后 kill 子进程并返回 timedOut。
   */
  function runAsync(args, timeoutMs = QUICK_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const [cmd, argv] = bhArgv(args);
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      let child;
      try {
        child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return done({ ok: false, code: null, timedOut: false, stdout: "", stderr: String(e?.message ?? e) });
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
        done({ ok: false, code: null, timedOut: true, stdout, stderr });
      }, timeoutMs);
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        done({ ok: false, code: null, timedOut: false, stdout, stderr: String(e?.message ?? e) });
      });
      // status/logs 这类一次性命令用 close（等 stdout 收全）；只有 start/stop 那种把管道交给
      // 常驻服务的命令才必须用 exit（见 startLong 的说明）。
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, code: code ?? null, timedOut: false, stdout, stderr });
      });
    });
  }

  function startLong(action, service) {
    const id = `op-${Date.now()}-${++seq}`;
    const logPath = `/tmp/bh-${id}.log`;
    const args = [action];
    if (service) args.push(service);
    const entry = {
      id,
      action,
      service: service ?? "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      running: true,
      exitCode: null,
      logPath,
      tail: "",
    };
    const append = (s) => {
      entry.tail = (entry.tail + s).slice(-MAX_TAIL);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* noop */
      }
    };
    // Windows 上 bh 是 .cmd/.ps1，须经 cmd.exe 包装（bare 名 spawn 会 ENOENT/EINVAL，导致长操作一启动就失败）
    const [cmd, argv] = bhArgv(args);
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => append(d.toString()));
    child.stderr.on("data", (d) => append(d.toString()));
    // 用 exit 而非 close 收尾：bh 启动的服务进程会继承 stdout 管道句柄，
    // close 要等管道彻底关闭（服务存活期间永不触发），导致 op 一直显示“运行中”。
    const finalize = (code) => {
      if (entry.finalized) return;
      entry.finalized = true;
      entry.running = false;
      entry.exitCode = code;
      entry.finishedAt = new Date().toISOString();
      append(`\n[op] exit code: ${code}\n`);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* noop */
      }
    };
    child.on("exit", finalize);
    child.on("close", finalize); // 幂等兜底（正常关闭路径）
    child.on("error", (err) => {
      entry.finalized = true;
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
      finishedAt: op.finishedAt ?? null,
      durationMs: op.finishedAt
        ? new Date(op.finishedAt).getTime() - new Date(op.startedAt).getTime()
        : null,
      running: op.running,
      exitCode: op.exitCode,
      error: op.error ?? null,
      tail: op.tail?.slice(-2000) ?? "",
    };
  }

  /** 最近一次成功的 status 解析结果（缓存），以及进行中的采集。 */
  let statusSnapshot = null;
  let statusSnapshotAt = 0;
  let statusInflight = null;

  /** 组装返回体：缓存里的 status + 实时内存态 ops 列表（ops 是内存数据，不需要重新采集）。 */
  function statusView(parsed, stale) {
    const all = [...ops.values()];
    const now = Date.now();
    // 清理已结束超过 1 小时的 op（避免内存/列表无限膨胀）
    for (const op of all) {
      if (!op.running && now - new Date(op.startedAt).getTime() >= 60 * 60 * 1000) {
        ops.delete(op.id);
      }
    }
    const remaining = [...ops.values()];
    return {
      ok: true,
      status: parsed,
      /** true = 采集还没回来，这里返回的是上一次的快照。 */
      stale: Boolean(stale),
      // 只含真正运行中的（已完成的不算"进行中"，避免卡片永远显示有操作）
      runningOps: remaining.filter((op) => op.running).map(opView),
      // 最近完成的（供"最近操作"列表展示），按开始时间倒序，最多 10 条
      recentOps: remaining
        .filter((op) => !op.running)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
        .slice(0, 10)
        .map(opView),
    };
  }

  /** 发起（或复用）一次 bh status 采集。异步、带缓存，绝不会阻塞事件循环。 */
  function refreshStatus() {
    if (statusInflight) return statusInflight;
    statusInflight = runAsync(["status", "--json"], STATUS_HARD_TIMEOUT_MS)
      .then((r) => {
        if (!r.ok) {
          return {
            ok: false,
            error: r.timedOut ? "bh status 超时" : r.stderr || r.stdout || `bh status 失败（exit ${r.code}）`,
          };
        }
        let parsed;
        try {
          parsed = JSON.parse(r.stdout);
        } catch {
          return { ok: false, error: `bh status 输出不是 JSON：${r.stdout.slice(0, 300)}` };
        }
        statusSnapshot = parsed;
        statusSnapshotAt = Date.now();
        return statusView(parsed, false);
      })
      .finally(() => {
        statusInflight = null;
      });
    return statusInflight;
  }

  /**
   * 状态总览（bh status --json 解析 + 运行中的长操作 + 最近完成操作）。
   *
   * 性能约定（2026-10 实测 `bh status --json` 单次要 6.4s）：
   *  - 一律异步 spawn，绝不用 spawnSync —— 同步版会把整个 DSH 事件循环冻住 6s 以上；
   *  - 5s 新鲜期内直接复用缓存；
   *  - 传 maxWaitMs（UI 卡片用）时，超时先回退旧快照（stale=true），采集在后台继续。
   * @param {{maxWaitMs?: number}} [opts]
   */
  async function status(opts = {}) {
    if (statusSnapshot && Date.now() - statusSnapshotAt < STATUS_CACHE_TTL_MS) {
      return statusView(statusSnapshot, false);
    }
    const pending = refreshStatus();
    const { maxWaitMs } = opts;
    // 没有旧快照可回退 → 只能等这一次采集（首次打开卡片）
    if (!statusSnapshot || !Number.isFinite(maxWaitMs) || maxWaitMs <= 0) return pending;
    let timerId;
    const timeout = new Promise((resolve) => {
      timerId = setTimeout(() => resolve(null), maxWaitMs);
      timerId.unref?.();
    });
    try {
      const r = await Promise.race([pending, timeout]);
      if (r === null) {
        pending.catch(() => {});
        return statusView(statusSnapshot, true);
      }
      return r;
    } finally {
      clearTimeout(timerId);
    }
  }

  /** 快速操作：stop <svc>（异步，不阻塞事件循环）。start/restart 已移除：百花由宿主机 bh start 拉起。 */
  async function action(name, service) {
    if (!QUICK_ACTIONS.has(name)) return { ok: false, error: `不支持的快速操作: ${name}` };
    if (!service) return { ok: false, error: `bh ${name} 需要指定服务（server/webui/openvino/postgres/open-webui）` };
    const r = await runAsync([name, service]);
    return { ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }


  /**
   * 长操作：只剩 build [svc]。返回 opId。
   * 注意：`bh build` 会先停掉在跑的服务再 publish（exe 被占用），所以编译完服务是停的 ——
   * 需要时到宿主机执行 `bh start`（DSH 不再代劳）。
   */
  function startLongAction(name, service) {
    if (!LONG_ACTIONS.has(name)) return { ok: false, error: `不支持的长操作: ${name}（只剩 build；启动/更新请用宿主机 bh）` };
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

  async function logs(service, lines) {
    // 默认取唯一后端 bh-server（合并前默认 "family"，容器名 bh-family 已不存在；
      // 注意 bh logs 对不存在的服务仍 exit 0，静默返回 "No resources found"，容易误导）
    const svc = service || "server";
    const n = Math.min(Math.max(1, Number(lines) || 50), 500);
    const r = await runAsync(["logs", svc, String(n)], STATUS_TIMEOUT_MS);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }



  /**
   * 校验 gitRepo 是有效的 git 仓库根：`git rev-parse --show-toplevel` 必须成功，
   * 且解析出的仓库根与配置的路径一致（避免在子目录执行导致只提交子目录改动）。
   * 返回 { ok: true } 或 { ok: false, error }。
   */
  function verifyGitRepo(root) {
    if (!root) {
      return {
        ok: false,
        error:
          "无法定位百花仓库根：未配置 gitRepo，常见路径（~/src/baihua 等）、BAIHUA_HOME、" +
          "bhCommand 推断均未命中。可先调用 bh_bootstrap 引导安装，或在插件配置中显式设置 gitRepo。",
      };
    }
    let r;
    try {
      r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (e) {
      return { ok: false, error: `校验 git 仓库失败：${e.message}` };
    }
    if (r.status !== 0) {
      return {
        ok: false,
        error: `${root} 不是有效 git 仓库（git rev-parse exit ${r.status}：${
          (r.stderr || "").trim() || (r.stdout || "").trim() || "无输出"
        }）`,
      };
    }
    const toplevel = String(r.stdout || "").trim();
    const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (norm(toplevel) !== norm(resolve(root))) {
      return {
        ok: false,
        error: `gitRepo 不是仓库根：${root}（实际仓库根为 ${toplevel}）。请将 gitRepo 配置为仓库根目录。`,
      };
    }
    return { ok: true };
  }

  /**
   * 提交并推送百花仓库（git add -A → commit → push），作为长操作（opId + tail）。
   * 在 gitRepo 目录执行；commit message 由调用方传入（UI 输入）。push 失败（网络/认证）
   * 时 exit 非 0，tail 会包含 git 输出。
   * 仓库定位失败（找不到/不是仓库根）时同步返回 { ok: false, error }，不创建 op。
   */
  function startGitCommitPush(message) {
    const check = verifyGitRepo(gitRepo);
    if (!check.ok) return check;
    const repoRoot = gitRepo;
    const id = `op-${Date.now()}-${++seq}`;
    const logPath = `/tmp/bh-${id}.log`;
    const entry = {
      id,
      action: "git-commit-push",
      service: message ?? "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      running: true,
      exitCode: null,
      logPath,
      tail: "",
    };
    const append = (s) => {
      entry.tail = (entry.tail + s).slice(-MAX_TAIL);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* noop */
      }
    };
    ops.set(id, entry);

    const run = (args, label) =>
      new Promise((resolve) => {
        append(`\n===== ${label}（git ${args.join(" ")}）=====\n`);
        const child = spawn("git", args, {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (d) => append(d.toString()));
        child.stderr.on("data", (d) => append(d.toString()));
        const settle = (code) => {
          append(`\n[${label}] exit code: ${code}\n`);
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            /* noop */
          }
          resolve(code);
        };
        child.on("exit", settle);
        child.on("close", settle); // 幂等兜底
        child.on("error", (err) => {
          append(`\n[${label}] spawn error: ${err.message}\n`);
          entry.error = err.message;
          resolve(-1);
        });
      });

    void (async () => {
      try {
        if (process.platform === "win32") {
          const ps = [
            "git add -A",
            `git commit -m ${JSON.stringify(String(message ?? "").replace(/"/g, '\\"'))}`,
            "git push",
          ];
          // Windows 用 cmd 串行执行，tail 逐条记录
          for (const cmd of ps) {
            append(`\n===== ${cmd} =====\n`);
            const code = await new Promise((resolve) => {
              const child = spawn("cmd", ["/c", cmd], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
              child.stdout.on("data", (d) => append(d.toString()));
              child.stderr.on("data", (d) => append(d.toString()));
              const settle = (c) => {
                append(`\n[${cmd}] exit code: ${c}\n`);
                try {
                  child.stdout?.destroy();
                  child.stderr?.destroy();
                } catch {
                  /* noop */
                }
                resolve(c);
              };
              child.on("exit", settle);
              child.on("close", settle); // 幂等兜底
              child.on("error", (err) => {
                append(`\n[${cmd}] spawn error: ${err.message}\n`);
                resolve(-1);
              });
            });
            entry.exitCode = code;
            if (code !== 0) break;
          }
        } else {
          const addCode = await run(["add", "-A"], "add");
          if (addCode !== 0) {
            entry.exitCode = addCode;
            return;
          }
          const msg = String(message ?? "").trim();
          if (!msg) {
            append("\n[commit] 未提供提交信息，跳过 commit/push。\n");
            entry.exitCode = 0;
            return;
          }
          const commitCode = await run(["commit", "-m", msg], "commit");
          if (commitCode !== 0) {
            // commit 失败（通常是无改动）→ 尝试 push 已有提交
            append("\n[commit] 无变更或提交失败，继续尝试 push。\n");
          }
          entry.exitCode = await run(["push"], "push");
        }
      } finally {
        entry.running = false;
        entry.finishedAt = new Date().toISOString();
        append(`\n[git-commit-push] ${entry.exitCode === 0 ? "完成 ✅" : "失败（exit " + entry.exitCode + "）"}。\n`);
      }
    })();

    return entry;
  }

  /**
   * 引导安装：若本机还没有百花源码，自动 git clone 到目标目录并执行 bh install
   * （把自包含定位器装进 PATH），之后 bh 立即可用。作为长操作（opId + tail）。
   * 若检测到已有源码，直接返回其路径，不做任何改动。
   *
   * @param {object} o - { url, target, depth, bhCommand, gitRepo }
   */
  function startBootstrap(o = {}) {
    const id = `op-${Date.now()}-${++seq}`;
    const logPath = `/tmp/bh-${id}.log`;
    const entry = {
      id,
      action: "bootstrap",
      service: o.url ?? "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      running: true,
      exitCode: null,
      logPath,
      tail: "",
    };
    const append = (s) => {
      entry.tail = (entry.tail + s).slice(-MAX_TAIL);
      try {
        appendFileSync(logPath, s);
      } catch {
        /* noop */
      }
    };
    ops.set(id, entry);

    const run = (args, label, cwd) =>
      new Promise((resolve) => {
        append(`\n===== ${label}（${args.join(" ")}）=====\n`);
        const child = spawn(args[0], args.slice(1), {
          cwd: cwd ?? undefined,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (d) => append(d.toString()));
        child.stderr.on("data", (d) => append(d.toString()));
        const settle = (code) => {
          append(`\n[${label}] exit code: ${code}\n`);
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            /* noop */
          }
          resolve(code);
        };
        child.on("exit", settle);
        child.on("close", settle); // 幂等兜底
        child.on("error", (err) => {
          append(`\n[${label}] spawn error: ${err.message}\n`);
          entry.error = err.message;
          resolve(-1);
        });
      });

    void (async () => {
      try {
        // 0) 已有源码？直接返回，不下载
        const existing = detectRepoRoot({ bhCommand, gitRepo });
        if (existing) {
          append(`\n[bootstrap] 检测到已有百花源码：${existing}\n`);
          entry.exitCode = 0;
          entry.result = { ok: true, cloned: false, root: existing };
          return;
        }

        // 1) 目标目录：target 展开 ~，默认 ~/src/baihua
        const home = homedir();
        const rawTarget = o.target || join(home, "src", "baihua");
        const target = rawTarget.replace(/^~(?=$|\/|\\)/, home);
        const url = o.url || "https://github.com/luminsw/baihua.git";
        const depth = Number(o.depth) > 0 ? Number(o.depth) : 1;

        if (existsSync(join(target, ".git"))) {
          append(`\n[bootstrap] 目标目录已有 .git：${target}（视为已安装）\n`);
          entry.exitCode = 0;
          entry.result = { ok: true, cloned: false, root: target };
          return;
        }
        mkdirSync(dirname(target), { recursive: true });

        // 2) git clone（浅克隆）
        const cloneArgs = ["git", "clone", "--depth", String(depth), url, target];
        const cloneCode = await run(cloneArgs, "git clone");
        if (cloneCode !== 0) {
          entry.exitCode = cloneCode;
          entry.result = { ok: false, error: `git clone 失败（exit ${cloneCode}），见上方输出` };
          return;
        }

        // 3) 自动安装 bh 定位器（把 PATH 入口装好）
        const bhSh = join(target, "tools", "bh", "bh.sh");
        if (existsSync(bhSh)) {
          const installCode = await run(
            process.platform === "win32" ? ["pwsh", "-NoProfile", "-File", bhSh.replace(/\.sh$/, ".ps1"), "install"] : ["bash", bhSh, "install"],
            "bh install",
            target,
          );
          if (installCode !== 0) {
            entry.exitCode = installCode;
            entry.result = { ok: false, error: `源码已下载到 ${target}，但 bh install 失败（exit ${installCode}）` };
            return;
          }
        }

        entry.exitCode = 0;
        entry.result = { ok: true, cloned: true, root: target, url, depth };
        append(`\n[bootstrap] 完成 ✅ 源码位于 ${target}，bh 已装好，可直接使用。\n`);
      } catch (e) {
        entry.exitCode = 1;
        entry.error = e.message;
        entry.result = { ok: false, error: e.message };
      } finally {
        entry.running = false;
        entry.finishedAt = new Date().toISOString();
        append(`\n[bootstrap] ${entry.exitCode === 0 ? "完成 ✅" : "失败（exit " + entry.exitCode + "）"}。\n`);
      }
    })();

    return entry;
  }

  /** UI 卡片专用入口：最多同步等 STATUS_UI_MAX_WAIT_MS，超时先回退旧快照（采集在后台继续）。 */
  function statusForUi() {
    return status({ maxWaitMs: STATUS_UI_MAX_WAIT_MS });
  }

  return {
    status,
    statusForUi,
    action,
    startLongAction,
    listOps,
    opStatus,
    logs,
    startGitCommitPush,
    startBootstrap,
  };
}
