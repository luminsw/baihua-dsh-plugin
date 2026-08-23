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

    function BaihuaStatusCard(_props) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null); // { ok, text } 操作结果提示

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

      const services = data?.services ?? [];
      const summary = data?.summary;
      const git = data?.git;
      const base = { fontFamily: "inherit", fontSize: 13, lineHeight: 1.6 };
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
          { style: { marginBottom: 6 } },
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15 } },
            React.createElement(
              "span",
              { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" } },
              "百花服务状态" + (summary ? `（${summary.ready}/${summary.total} 就绪）` : "") + headBadge
            ),
            React.createElement(
              "button",
              {
                style: btn,
                disabled: busy,
                onClick: () => runAction("update"),
                title: "一键更新：git pull + 编译变更镜像 + 部署；若编译因 NuGet 缓存损坏（NETSDK1064）失败会自动清理缓存重试",
              },
              "🔄一键更新"
            ),
            React.createElement(
              "button",
              {
                style: btn,
                disabled: busy,
                onClick: () => openBaihua(setMsg),
                title: "获取百花 cli-token 并打开 WebUI 首页（自动登录）",
              },
              "🌐打开百花"
            )
          ),
          React.createElement(
            "div",
            { style: { fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
            "百花 k8s 服务运行状态与版本对比，可启停/重启/编译各服务，或一键更新（编译失败自动清理缓存重试）。"
          )
        ),
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
          : null
      );
    }

    return {
      name: "dsh-baihua-bridge-client",
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: "baihua",
              locale: "settings.baihua",
              inject: () => ({}),
            },
            BaihuaStatusCard
          );
        });
      },
    };
  },
});
