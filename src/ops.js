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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";

const QUICK_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const MAX_TAIL = 16_000;

/** NuGet 包缓存损坏的特征错误（NETSDK1064 / restore 部分完成 / 包 not found）。命中即清理 buildkit 缓存后重试。 */
const NUGET_CACHE_ERROR_RE = /NETSDK1064|only partially completed|was not found/i;

/** 长操作允许的命令（避免任意命令执行面）。 */
const LONG_ACTIONS = new Set(["build", "update", "up", "deploy", "build-restart"]);
/** 快速操作允许的命令。 */
const QUICK_ACTIONS = new Set(["start", "stop", "restart"]);

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

  function runQuick(args, timeoutMs = QUICK_TIMEOUT_MS) {
    try {
      const [cmd, argv] = bhArgv(args);
      const r = spawnSync(cmd, argv, {
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
    const entry = {
      id,
      action,
      service: service ?? "",
      startedAt: new Date().toISOString(),
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
      running: op.running,
      exitCode: op.exitCode,
      error: op.error ?? null,
      tail: op.tail?.slice(-2000) ?? "",
    };
  }

  /** 状态总览（bh status --json 解析 + 运行中的长操作 + 最近完成操作）。 */
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
        // 只含真正运行中的（已完成的不算"进行中"，避免卡片永远显示有操作）
        runningOps: remaining.filter((op) => op.running).map(opView),
        // 最近完成的（供"最近操作"列表展示），按开始时间倒序，最多 10 条
        recentOps: remaining
          .filter((op) => !op.running)
          .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
          .slice(0, 10)
          .map(opView),
      };
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
    const entry = {
      id,
      action: "build-restart",
      service: service ?? "",
      startedAt: new Date().toISOString(),
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
        append(`\n===== ${label}（bh ${args.join(" ")}）=====\n`);
        const [cmd, argv] = bhArgv(args);
        const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (d) => append(d.toString()));
        child.stderr.on("data", (d) => append(d.toString()));
        // exit 收尾：bh restart 也会拉起服务进程（继承管道句柄），close 永不触发
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
      const buildArgs = ["build"];
      if (service) buildArgs.push(service);
      let buildCode = await run(buildArgs, "编译");
      if (buildCode !== 0 && NUGET_CACHE_ERROR_RE.test(entry.tail)) {
        append("\n[build-restart] 检测到 NuGet 包缓存损坏（NETSDK1064），清理构建缓存后重试…\n");
        await run(["prune"], "清理构建缓存");
        buildCode = await run(buildArgs, "编译(重试)");
      }
      if (buildCode !== 0) {
        entry.running = false;
        entry.exitCode = buildCode;
        append(`\n[build-restart] 编译失败（exit ${buildCode}），已跳过重启。\n`);
        return;
      }
      const restartArgs = ["restart", service];
      const restartCode = await run(restartArgs, "滚动重启");
      // 重建镜像并滚动重启成功后，把 deployment 的 baihua.git-commit 标注同步为当前 HEAD，
      // 避免 bh status 误报"落后"（deploy/update 会经 deploy_all 打标注，build-restart 不会）。
      if (restartCode === 0) {
        await run(["annotate", service], "打标注");
      }
      entry.running = false;
      entry.exitCode = restartCode;
      append(`\n[build-restart] ${restartCode === 0 ? "完成 ✅" : "重启失败（exit " + restartCode + "）"}。\n`);
    })();

    return entry;
  }

  /**
   * 链式一键更新：bh update（git pull + 编译变更镜像 + 部署）。
   * 若编译阶段因 NuGet 包缓存损坏（NETSDK1064）失败，自动 bh prune 清理 buildkit 缓存后
   * 重建 4 个 .NET 应用镜像并部署一次（避免 ORIG_HEAD==HEAD 时 changed_images 误跳过构建）。
   * 说明：bh update 内部按 changed_images 决定重建哪些镜像；这里是"再彻底重建一次"，宁可多构建也不留半失败状态。
   */
  function startUpdate() {
    const id = `op-${Date.now()}-${++seq}`;
    const logPath = `/tmp/bh-${id}.log`;
    const entry = {
      id,
      action: "update",
      service: "",
      startedAt: new Date().toISOString(),
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
        append(`\n===== ${label}（bh ${args.join(" ")}）=====\n`);
        const [cmd, argv] = bhArgv(args);
        const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
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
      let code = await run(["update"], "一键更新");
      if (code !== 0 && NUGET_CACHE_ERROR_RE.test(entry.tail)) {
        append("\n[update] 检测到 NuGet 包缓存损坏（NETSDK1064），清理 buildkit 构建缓存后重建并部署…\n");
        await run(["prune"], "清理构建缓存");
        code = await run(["build", "vault", "ai", "webui", "family"], "重建 .NET 镜像");
        if (code === 0) code = await run(["deploy"], "部署");
      }
      entry.running = false;
      entry.exitCode = code;
      append(`\n[update] ${code === 0 ? "完成 ✅" : "失败（exit " + code + "）"}。\n`);
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
    if (name === "update") {
      const op = startUpdate();
      return { ok: true, opId: op.id, action: "update", service: "" };
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

  /**
   * 重启 DSH 自身（宿主机 dsh web 进程）。
   * 注意：插件运行在 DSH 进程内，kill 掉 DSH 就是杀掉自己——因此必须把重启脚本交给一个
   * 独立于本进程的宿主执行：sleep 1s 等 HTTP 响应发出 → 杀掉当前 dsh 进程树 → sleep 等端口
   * 释放 → 重新拉起。调用方立即得到 { ok: true }，实际重启在后台进行。
   *
   * Windows 用「计划任务」方案（写临时 ps1 → Register-ScheduledTask → Start-ScheduledTask）：
   * 任务在独立上下文运行，不随父进程被强杀而中断；此前 detached 子进程方案实测不可靠
   * （kill DSH 时子进程未生效，DSH 进程未被重启）。
   */
  function restartDsh() {
    if (process.platform === "win32") {
      const taskName = "dsh-web-restart";
      const stamp = Date.now();
      const scriptPath = join(tmpdir(), `dsh-web-restart-${stamp}.ps1`);
      const logPath = join(tmpdir(), `dsh-web-restart-${stamp}.log`);
      const errLogPath = join(tmpdir(), `dsh-web-restart-${stamp}.err.log`);
      const home = homedir();
      // 保持 ASCII（PowerShell 5.1 无 BOM 时按 ANSI 读，含中文会乱码/报错）
      const script = [
        "# dsh web restart (generated by dsh-baihua-bridge)",
        "Start-Sleep -Seconds 1",
        // 杀掉 npx 包装与 dsh 本体：命令行同时含 'dsh' 与 'web' 的 node 进程
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match 'web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        "Start-Sleep -Seconds 2",
        // 重新拉起（与手工重启方式一致）：npx @deepseek-ai/dsh web，输出落盘
        `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npx @deepseek-ai/dsh web' -WorkingDirectory '${home}' -WindowStyle Hidden -RedirectStandardOutput '${logPath}' -RedirectStandardError '${errLogPath}'`,
        // 清理：任务固定名，下次重启会被 -Force 覆盖；此处尝试自删（运行中会失败，无妨）
        "Unregister-ScheduledTask -TaskName 'dsh-web-restart' -Confirm:$false -ErrorAction SilentlyContinue",
      ].join("\r\n");
      try {
        writeFileSync(scriptPath, script, "utf8");
        const ps = [
          `$task = '${taskName}'`,
          `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"'`,
          `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)`,
          `Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Force | Out-Null`,
          `Start-ScheduledTask -TaskName $task`,
        ].join("; ");
        const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        if (r.status !== 0) {
          return {
            ok: false,
            error:
              (r.stderr || "").trim() ||
              (r.stdout || "").trim() ||
              `计划任务注册失败（exit ${r.status}）`,
          };
        }
        return { ok: true, message: "DSH 正在重启（约 10-30 秒），期间桥接短暂不可用" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    // Linux/macOS：pkill 后 nohup 重启（命令 & 脱离，detached + unref 不随父进程死）
    const script = [
      "sleep 1",
      'pkill -f "@deepseek-ai/dsh" || pkill -f "dsh/lib/bin.js" || true',
      "sleep 2",
      'cd "$HOME" && nohup npx @deepseek-ai/dsh web >"$HOME/.dsh-restart.log" 2>&1 &',
    ].join(" && ");
    try {
      const child = spawn("/bin/bash", ["-c", script], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true, message: "DSH 正在重启（约 10-30 秒），期间桥接短暂不可用" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 仅停止 DSH 自身（宿主机 dsh web 进程），不重新拉起。
   * 与 restartDsh 同理：插件运行在 DSH 进程内，kill 掉 DSH 就是杀掉自己，
   * 因此停止动作交给独立于本进程的宿主执行：sleep 1s 等 HTTP 响应发出 →
   * 杀掉当前 dsh 进程树。调用方立即得到 { ok: true }，实际停止在后台进行。
   */
  function stopDsh() {
    if (process.platform === "win32") {
      const taskName = "dsh-web-stop";
      const stamp = Date.now();
      const scriptPath = join(tmpdir(), `dsh-web-stop-${stamp}.ps1`);
      const home = homedir();
      // 保持 ASCII（PowerShell 5.1 无 BOM 时按 ANSI 读，含中文会乱码/报错）
      const script = [
        "# dsh web stop (generated by dsh-baihua-bridge)",
        "Start-Sleep -Seconds 1",
        // 杀掉 npx 包装与 dsh 本体：命令行同时含 'dsh' 与 'web' 的 node 进程
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'dsh' -and $_.CommandLine -match 'web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        // 清理：任务固定名，下次会被 -Force 覆盖；此处尝试自删（运行中会失败，无妨）
        "Unregister-ScheduledTask -TaskName 'dsh-web-stop' -Confirm:$false -ErrorAction SilentlyContinue",
      ].join("\r\n");
      try {
        writeFileSync(scriptPath, script, "utf8");
        const ps = [
          `$task = '${taskName}'`,
          `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"'`,
          `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)`,
          `Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Force | Out-Null`,
          `Start-ScheduledTask -TaskName $task`,
        ].join("; ");
        const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        if (r.status !== 0) {
          return {
            ok: false,
            error:
              (r.stderr || "").trim() ||
              (r.stdout || "").trim() ||
              `计划任务注册失败（exit ${r.status}）`,
          };
        }
        return { ok: true, message: "DSH 正在停止（约 5-10 秒），桥接将不可用" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    // Linux/macOS：pkill（命令 & 脱离，detached + unref 不随父进程死）
    const script = [
      "sleep 1",
      'pkill -f "@deepseek-ai/dsh" || pkill -f "dsh/lib/bin.js" || true',
    ].join(" && ");
    try {
      const child = spawn("/bin/bash", ["-c", script], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true, message: "DSH 正在停止（约 5-10 秒），桥接将不可用" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
        append(`\n[bootstrap] ${entry.exitCode === 0 ? "完成 ✅" : "失败（exit " + entry.exitCode + "）"}。\n`);
      }
    })();

    return entry;
  }

  return {
    status,
    action,
    startLongAction,
    listOps,
    opStatus,
    logs,
    restartDsh,
    stopDsh,
    startGitCommitPush,
    startBootstrap,
  };
}
