/**
 * baihua-dsh-plugin 客户端模块（DSH Web UI 侧）。
 *
 * 由 DSH 客户端模块系统按 lazy-CJS factory 格式加载（window.__ModuleLoader__.load），
 * 打包格式手写复刻官方未发布的 clientBundle 预设输出。
 *
 * 作用：在 DSH 设置 → 插件页注册一张「百花服务」卡片——只读展示百花各服务状态
 * （就绪/副本/阶段/重启数 + 运行中 bh 操作），每 10s 自动刷新。
 * 数据源：host 侧 /dsh-bridge/bh/status-ui（仅 127.0.0.1 webServer、免鉴权、只读）。
 */
window.__ModuleLoader__.load({
  id: "baihua-dsh-plugin",
  factory(require) {
    const React = require("react");
    const { useState, useEffect } = React;

    const STATUS_URL = "/dsh-bridge/bh/status-ui";

    function BaihuaStatusCard(_props) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);

      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const res = await fetch(STATUS_URL, { cache: "no-store" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const json = await res.json();
            if (alive) {
              setData(json);
              setErr(null);
            }
          } catch (e) {
            if (alive) setErr(e instanceof Error ? e.message : String(e));
          }
        };
        load();
        const timer = setInterval(load, 10000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      const services = data?.services ?? [];
      const summary = data?.summary;
      const base = { fontFamily: "inherit", fontSize: 13, lineHeight: 1.6 };
      const th = { textAlign: "left", padding: "2px 12px 2px 0", color: "#888", fontWeight: 600 };
      const td = { padding: "2px 12px 2px 0", whiteSpace: "nowrap" };

      return React.createElement(
        "div",
        { style: base },
        React.createElement(
          "div",
          { style: { fontWeight: 600, marginBottom: 6 } },
          "百花服务状态" + (summary ? `（${summary.ready}/${summary.total} 就绪）` : "")
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
                    ["服务", "状态", "重启"].map((c) =>
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
                      React.createElement("td", { style: td }, String(s.restarts ?? 0))
                    )
                  )
                )
              ),
        (data?.runningOps?.length ?? 0) > 0
          ? React.createElement(
              "div",
              { style: { marginTop: 6, color: "#b7791f" } },
              "⏳ " + data.runningOps.length + " 个 bh 操作进行中（可用 bh_op_status 查询）"
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
