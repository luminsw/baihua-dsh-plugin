/**
 * baihua.js — 百花数据只读工具（知识库检索/笔记、家庭数据）。
 *
 * 从 DSH 宿主机直连百花后端（k8s ClusterIP 或本机回环），端点均为只读、
 * 默认免签名（走服务内部信任面）。URL 通过插件配置注入：
 *   vaultUrl   → 百花 Vault（如 http://127.0.0.1:8790 或 k8s ClusterIP）
 *   familyUrl  → 百花 Family（如 http://127.0.0.1:8788 或 k8s ClusterIP）
 */

/** 解析 JSON 响应；失败返回 null。 */
async function getJson(url, timeoutMs = 15_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createBaihuaApi(config) {
  const vaultUrl = (config.vaultUrl || "http://127.0.0.1:8790").trim().replace(/\/+$/, "");
  const familyUrl = (config.familyUrl || "http://127.0.0.1:8788").trim().replace(/\/+$/, "");

  /** 知识库全文搜索。 */
  async function searchVault(query, vaultId = "") {
    const url = `${vaultUrl}/api/search?q=${encodeURIComponent(query)}&vaultId=${encodeURIComponent(vaultId)}`;
    const json = await getJson(url);
    return { ok: json != null, data: json };
  }

  /** 列出全部知识库（/api/settings/vaults，与百花 Web 同一数据源）。 */
  async function listVaults() {
    const json = await getJson(`${vaultUrl}/api/settings/vaults`);
    return { ok: json != null, data: json };
  }

  /** 读取某条笔记（markdown 内容）。path 相对知识库根，如 "基础认识/笔记.md"。 */
  async function readNote(path, vaultId = "") {
    const escaped = path.split("/").map((s) => encodeURIComponent(s)).join("/");
    const json = await getJson(`${vaultUrl}/vault/read/${escaped}?vaultId=${encodeURIComponent(vaultId)}`);
    return { ok: json != null, data: json };
  }

  /** 家庭记账汇总（本月收支/分类）。 */
  async function budgetSummary() {
    const json = await getJson(`${familyUrl}/api/budget/summary`);
    return { ok: json != null, data: json };
  }

  /** 家庭任务/待办列表。 */
  async function listTasks() {
    const json = await getJson(`${familyUrl}/api/tasks`);
    return { ok: json != null, data: json };
  }

  return { searchVault, listVaults, readNote, budgetSummary, listTasks };
}
