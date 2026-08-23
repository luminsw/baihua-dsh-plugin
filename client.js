/**
 * baihua-dsh-plugin 客户端模块（DSH Web UI 侧）。
 *
 * 由 DSH 客户端模块系统按 lazy-CJS factory 格式加载（window.__ModuleLoader__.load），
 * 打包格式手写复刻官方未发布的 clientBundle 预设输出。
 *
 * 作用：在 DSH 设置 → 插件页注册一张「百花服务」卡片——展示百花各服务状态
 * （就绪/副本/阶段/重启数 + 运行中 bh 操作 + 代码版本对比），每 10s 自动刷新，
 * 并提供操作按钮（启动/停止/重启/编译并重启/一键更新）。
 * 数据源：host 侧 /dsh-bridge/bh/status-ui（仅 127.0.0.1 webServer、免鉴权、只读）；
 * 操作走 /dsh-bridge/bh/ui-action（同源免 token，host 侧做同源校验）。
 */
window.__ModuleLoader__.load({
  id: "baihua-dsh-plugin",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STATUS_URL = "/dsh-bridge/bh/status-ui";
    const ACTION_URL = "/dsh-bridge/bh/ui-action";
    const OPEN_URL = "/dsh-bridge/baihua/open-url";

    // “打开百花”：向 host 申请 cli-token，再打开百花 WebUI 首页（自动登录）
    const openBaihua = async (setMsg) => {
      try {
        const res = await fetch(OPEN_URL, { cache: "no-store" });
        const j = await res.json().catch(() => null);
        if (!j || !j.ok) throw new Error((j && j.error) || "HTTP " + res.status);
        window.open(j.url, "_blank", "noopener,noreferrer");
        setMsg({ ok: true, text: "已打开百花 WebUI（自动登录）" });
      } catch (e) {
        setMsg({ ok: false, text: "打开百花失败：" + (e instanceof Error ? e.message : String(e)) });
      }
    };

    // 长操作（后台执行，返回 opId）
    const LONG_ACTIONS = ["build", "build-restart", "update", "up", "deploy"];

    // 可配置字段（与 host Config 对齐；token/drawToken 为 write-only）
    const BAIHUA_FIELDS = [
      { key: "token", label: "桥接鉴权 token", hint: "除 /status 外接口要求 Bearer token（write-only）", type: "password" },
      { key: "familyUrl", label: "Family 服务地址", hint: "如 http://127.0.0.1:8788", type: "text" },
      { key: "webUrl", label: "WebUI 地址", hint: "「打开百花」自动登录用", type: "text" },
      { key: "drawGatewayUrl", label: "绘图网关地址", hint: "空=用 familyUrl；跨机可指向任一百花节点", type: "text" },
      { key: "drawToken", label: "绘图网关 token", hint: "write-only", type: "password" },
      { key: "bhCommand", label: "bh 命令", hint: "留空禁用运维；默认 bh；重启生效", type: "text" },
      { key: "gitRepo", label: "git 仓库根", hint: "提交推送用；默认自动推断", type: "text" },
      { key: "lanListen", label: "局域网监听", hint: "如 0.0.0.0:3081；配非回环需同时设 token", type: "text" },
    ];

    function BaihuaStatusCard(props) {
      const scope = props.scope;
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null); // { ok, text } 操作结果提示
      const [open, setOpen] = useState(false); // 开合：默认收起，与内置卡片一致
      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [saveMsg, setSaveMsg] = useState(null);
      const [discovered, setDiscovered] = useState(null);

      // 展示「已自动发现」的百花配置（只读：从本机 /api/dsh/config 拉取，零配置自举结果）
      useEffect(() => {
        (async () => {
          try {
            const res = await fetch("/api/dsh/config", { cache: "no-store" });
            if (res.ok) setDiscovered(await res.json());
          } catch { /* noop */ }
        })();
      }, []);

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATUS_URL, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          setData(json);
          setErr(null);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 10000);
        return () => clearInterval(timer);
      }, [load]);

      const runAction = useCallback(
        async (action, service, message) => {
          if (busy) return;
          // 危险/耗时操作先确认
          if (action === "build-restart" || action === "update" || action === "build") {
            const label = action === "update" ? "一键更新（git pull + 编译 + 部署；编译失败会自动清理缓存重试）" : `编译${service ? " " + service : ""}`;
            if (!window.confirm(`确定执行「${label}」？可能需要数分钟。`)) return;
          }
          setBusy(true);
          setMsg(null);
          try {
            const res = await fetch(ACTION_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, service, message }),
            });
            const j = await res.json();
            if (j.ok) {
              if (LONG_ACTIONS.includes(action)) {
                setMsg({ ok: true, text: `已开始 ${action}${service ? " " + service : ""}（opId=${j.opId}），后台执行中…` });
              } else {
                setMsg({ ok: true, text: `${action} ${service} 成功` });
              }
              setTimeout(load, 1500); // 稍后刷新状态
            } else {
              setMsg({ ok: false, text: `${action}${service ? " " + service : ""} 失败：${j.error || j.stderr || "未知错误"}` });
            }
          } catch (e) {
            setMsg({ ok: false, text: `调用失败：${e instanceof Error ? e.message : String(e)}` });
          } finally {
            setBusy(false);
          }
        },
        [busy, load],
      );

      // 绑定 settings scope：订阅快照，外来变更时回填草稿
      useEffect(() => {
        if (!scope) return;
        const read = () => {
          const s = scope.getSnapshot();
          setSnap(s);
          const v = s.value || {};
          const d = {};
          for (const f of BAIHUA_FIELDS) {
            if (f.type === "password") continue;
            d[f.key] = v[f.key] === undefined ? "" : String(v[f.key]);
          }
          setDraft(d);
        };
        read();
        const off = scope.subscribe(read);
        return () => off();
      }, [scope]);

      const setField = (key, raw) => setDraft((d) => ({ ...d, [key]: raw }));

      const save = useCallback(async () => {
        if (!scope || saving) return;
        setSaving(true);
        setSaveMsg(null);
        try {
          const v = (scope.getSnapshot().value) || {};
          const ops = [];
          for (const f of BAIHUA_FIELDS) {
            const raw = draft[f.key];
            if (f.type === "password") {
              const text = String(raw || "").trim();
              if (text) ops.push(() => scope.set(f.key, text));
              continue;
            }
            const text = String(raw === undefined ? "" : raw).trim();
            const cur = v[f.key] === undefined ? "" : String(v[f.key]);
            if (text === cur) continue;
            ops.push(text ? () => scope.set(f.key, text) : () => scope.unset(f.key));
          }
          for (const op of ops) await op();
          setSaveMsg({ ok: true, text: "已保存（部分参数重启后生效）" });
        } catch (e) {
          setSaveMsg({ ok: false, text: "保存失败：" + (e instanceof Error ? e.message : String(e)) });
        } finally {
          setSaving(false);
        }
      }, [scope, draft, saving]);

      const discard = useCallback(() => {
        setSaveMsg(null);
        const v = (scope && scope.getSnapshot().value) || {};
        const d = {};
        for (const f of BAIHUA_FIELDS) {
          if (f.type === "password") continue;
          d[f.key] = v[f.key] === undefined ? "" : String(v[f.key]);
        }
        setDraft(d);
      }, [scope]);

      const services = data?.services ?? [];
      const summary = data?.summary;
      const git = data?.git;
      const base = {
        fontFamily: "inherit",
        fontSize: 13,
        lineHeight: 1.6,
        // 与 DSH 内置插件卡片一致：边框 + 背景 + 圆角
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 14,
        boxShadow: "0 2px 8px rgba(0,0,0,.14)",
        padding: "14px 16px",
      };
      const th = { textAlign: "left", padding: "2px 12px 2px 0", color: "#888", fontWeight: 600 };
      const td = { padding: "2px 12px 2px 0", whiteSpace: "nowrap" };
      const btn = {
        fontSize: 11,
        padding: "1px 8px",
        marginRight: 4,
        borderRadius: 4,
        border: "1px solid #999",
        background: "transparent",
        cursor: busy ? "not-allowed" : "pointer",
        color: "inherit",
        opacity: busy ? 0.6 : 1,
      };
      const headBadge = git && git.head !== "unknown"
        ? " · " + git.head + (git.dirty ? " ⚠️未提交" : "")
        : "";

      return React.createElement(
        "div",
        { style: base },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8 } },
          React.createElement(
            "button",
            {
              type: "button",
              style: { appearance: "none", display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, textAlign: "left", font: "inherit", color: "inherit", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer" },
              "aria-expanded": open,
              onClick: () => setOpen(!open),
            },
            React.createElement(
              "span",
              { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)", flex: 1, minWidth: 0 } },
              "百花服务状态" + (summary ? `（${summary.ready}/${summary.total} 就绪）` : "") + headBadge
            ),
            React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", style: { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s", transform: open ? "rotate(180deg)" : "none" } },
              React.createElement("path", { d: "M3 5.5L7 9.5L11 5.5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
            )
          ),
          React.createElement(
            "button",
            { style: btn, disabled: busy, onClick: () => runAction("update"), title: "一键更新：git pull + 编译变更镜像 + 部署；若编译因 NuGet 缓存损坏（NETSDK1064）失败会自动清理缓存重试" },
            "🔄一键更新"
          ),
          React.createElement(
            "button",
            { style: btn, disabled: busy, onClick: () => openBaihua(setMsg), title: "获取百花 cli-token 并打开 WebUI 首页（自动登录）" },
            "🌐打开百花"
          )
        ),
        React.createElement(
          "div",
          { style: { fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
          "百花 k8s 服务运行状态与版本对比，可启停/重启/编译各服务，或一键更新（编译失败自动清理缓存重试）。"
        ),
        open
          ? React.createElement(
              "div",
              null,
        err
          ? React.createElement(
              "div",
              { style: { color: "#c0392b" } },
              "加载失败：" + err + "（桥插件未启用 bhCommand？）"
            )
          : services.length === 0 && !data
            ? React.createElement("div", { style: { color: "#888" } }, "加载中…")
            : React.createElement(
                "table",
                { style: { borderCollapse: "collapse" } },
                React.createElement(
                  "thead",
                  null,
                  React.createElement(
                    "tr",
                    null,
                    ["服务", "状态", "版本", "重启", "操作"].map((c) =>
                      React.createElement("th", { key: c, style: th }, c)
                    )
                  )
                ),
                React.createElement(
                  "tbody",
                  null,
                  services.map((s) =>
                    React.createElement(
                      "tr",
                      { key: s.name },
                      React.createElement("td", { style: td }, s.name),
                      React.createElement(
                        "td",
                        { style: td },
                        (s.ready > 0 ? "● 运行中" : "○ 已停止") + " " + s.ready + "/" + s.replicas + " · " + s.phase
                      ),
                      React.createElement(
                        "td",
                        { style: td },
                        s.imageCommit && s.imageCommit !== "unknown"
                          ? s.upToDate
                            ? "✅ " + s.imageCommit
                            : "🕓 " + s.imageCommit
                          : "—"
                      ),
                      React.createElement("td", { style: td }, String(s.restarts ?? 0)),
                      React.createElement(
                        "td",
                        { style: td },
                        s.ready > 0
                          ? React.createElement(
                              "button",
                              { style: btn, disabled: busy, onClick: () => runAction("stop", s.name) },
                              "停止"
                            )
                          : React.createElement(
                              "button",
                              { style: btn, disabled: busy, onClick: () => runAction("start", s.name) },
                              "启动"
                            ),
                        React.createElement(
                          "button",
                          { style: btn, disabled: busy, onClick: () => runAction("restart", s.name) },
                          "重启"
                        ),
                        React.createElement(
                          "button",
                          { style: btn, disabled: busy, onClick: () => runAction("build-restart", s.name) },
                          "编译"
                        )
                      )
                    )
                  )
                )
              ),
        msg
          ? React.createElement(
              "div",
              { style: { marginTop: 6, color: msg.ok ? "#2e7d32" : "#c0392b" } },
              msg.text
            )
          : null,
        (data?.runningOps?.length ?? 0) > 0
          ? React.createElement(
              "div",
              { style: { marginTop: 6, color: "#b7791f" } },
              "⏳ " + data.runningOps.length + " 个 bh 操作进行中（编译/更新等，可在状态栏观察）"
            )
          : null,
        (data?.recentOps?.length ?? 0) > 0
          ? React.createElement(
              "div",
              { style: { marginTop: 6, color: "#888", fontSize: 12 } },
              "最近操作：" +
                data.recentOps
                  .map(
                    (op) =>
                      op.action +
                      (op.service ? " " + op.service : "") +
                      (op.exitCode === 0 ? " ✅" : " ❌")
                  )
                  .join(" · ")
            )
          : null,
        scope && snap
          ? React.createElement(
              "div",
              { style: { marginTop: 10, borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 } },
              discovered && discovered.ok
                ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 8, lineHeight: 1.6 } },
                    React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: 2 } }, "已自动发现（零配置自举）"),
                    React.createElement("div", null, "Family: " + (discovered.familyUrl || "—")),
                    React.createElement("div", null, "Vault: " + (discovered.vaultUrl || "—")),
                    React.createElement("div", null, "AI: " + (discovered.aiUrl || "—")),
                    React.createElement("div", null, "算力池: " + (discovered.poolUrl || "—")),
                    React.createElement("div", null, "绘图: " + (discovered.drawGatewayUrl || "—"))
                  )
                : null,
              React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: 4 } }, "参数配置" + (snap.status === "unavailable" ? "（当前不可编辑）" : "")),
              BAIHUA_FIELDS.map((f) => {
                const val = draft[f.key];
                const isNum = f.type === "number";
                const isBool = f.type === "boolean";
                return React.createElement(
                  "div",
                  { key: f.key, style: { display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" } },
                  React.createElement("label", { style: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-primary)" } }, f.label),
                  isBool ? null : React.createElement("input", {
                    style: { font: "inherit", fontSize: 13, color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "6px 10px", lineHeight: 1.5 },
                    type: f.type === "password" ? "password" : "text",
                    inputMode: isNum ? "numeric" : undefined,
                    value: val === undefined ? "" : String(val),
                    placeholder: f.type === "password" ? "留空保持现状" : undefined,
                    disabled: !(snap.writable !== false) || saving,
                    onChange: (e) => setField(f.key, e.target.value),
                  }),
                  React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 } }, f.hint)
                );
              }),
              React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" } },
                React.createElement("button", { style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: saving ? "not-allowed" : "pointer" }, disabled: saving || snap.writable === false, onClick: discard }, "放弃修改"),
                React.createElement("button", { style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid transparent", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)", cursor: saving ? "not-allowed" : "pointer" }, disabled: saving || snap.writable === false, onClick: save }, saving ? "保存中…" : "保存"),
                saveMsg ? React.createElement("span", { style: { fontSize: 12, color: saveMsg.ok ? "#2e7d32" : "#c0392b" } }, saveMsg.text) : null
              )
            )
          : null
              )
          : null
      );
    }

    return {
      name: "dsh-baihua-bridge-client",
      inject: ["slots"],
      apply(ctx) {
        // 绑定 baihua settings namespace（host 提供 settingsScope 服务；缺失时退化为只读状态卡）
        const settingsScope = ctx.get("settingsScope");
        let scope = null;
        if (settingsScope) {
          try {
            scope = settingsScope.bind({ namespace: "baihua" });
            ctx.onDispose(() => {
              try { scope?.dispose?.(); } catch { /* noop */ }
            });
          } catch (e) {
            console.log("[dsh-baihua-bridge] settingsScope.bind 失败，退化为只读：", e.message);
          }
        }
        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: "baihua",
              locale: "settings.baihua",
              inject: () => ({ scope }),
            },
            BaihuaStatusCard
          );
        });
      },
    };
  },
});
