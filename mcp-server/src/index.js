/**
 * baihua-mcp-server — 百花能力的标准 MCP server（stdio）。
 *
 * 暴露只读工具（与 baihua-dsh-plugin 内注册的百花数据工具同源）：
 *   baihua_vault_search / baihua_vault_list / baihua_vault_read_note
 *   baihua_budget_summary / baihua_tasks_list
 *
 * 连接目标经环境变量配置（默认本机回环；k8s 部署填 ClusterIP）：
 *   BAIHUA_VAULT_URL   （默认 http://127.0.0.1:8790）
 *   BAIHUA_FAMILY_URL  （默认 http://127.0.0.1:8788）
 *
 * DSH 接入示例（profile cordis.patch.yml，需先安装 @deepseek-ai/dsh-mcp-client）：
 *   - id: mcp-baihua
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       serverName: baihua
 *       transport: stdio
 *       command: node
 *       args: ['/abs/path/baihua-dsh-plugin/mcp-server/src/index.js']
 *       env:
 *         BAIHUA_VAULT_URL: 'http://10.43.242.109:8790'
 *         BAIHUA_FAMILY_URL: 'http://10.43.159.101:8788'
 * 工具名在 DSH 里带 mcp__baihua__ 前缀（如 mcp__baihua__baihua_vault_search）。
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBaihuaApi } from "../../src/baihua.js";

const vaultUrl = (process.env.BAIHUA_VAULT_URL || "http://127.0.0.1:8790").trim().replace(/\/+$/, "");
const familyUrl = (process.env.BAIHUA_FAMILY_URL || "http://127.0.0.1:8788").trim().replace(/\/+$/, "");
const api = createBaihuaApi({ vaultUrl, familyUrl });

const server = new McpServer({ name: "baihua-mcp-server", version: "0.1.0" });

const textResult = (r) => ({
  content: [{ type: "text", text: r.ok ? JSON.stringify(r.data, null, 2) : "调用失败（百花服务不可达或返回错误）。" }],
});

server.registerTool(
  "baihua_vault_search",
  {
    title: "搜索百花知识库",
    description: "搜索百花知识库（全文/语义），返回命中的笔记片段。参数 query 为关键词，vaultId 可选（留空搜全部）。",
    inputSchema: z.object({
      query: z.string().describe("搜索关键词"),
      vaultId: z.string().optional().describe("知识库 id（可选）"),
    }),
  },
  async (args) => textResult(await api.searchVault(args.query, args.vaultId ?? "")),
);

server.registerTool(
  "baihua_vault_list",
  {
    title: "列出百花知识库",
    description: "列出百花全部知识库（名称/路径/来源）。",
    inputSchema: z.object({}),
  },
  async () => textResult(await api.listVaults()),
);

server.registerTool(
  "baihua_vault_read_note",
  {
    title: "读取百花笔记",
    description: "读取百花知识库中的一条笔记（markdown 全文）。参数 path 为笔记相对路径（如 基础认识/笔记.md），vaultId 为知识库 id。",
    inputSchema: z.object({
      path: z.string().describe("笔记相对路径，如 基础认识/笔记.md"),
      vaultId: z.string().describe("知识库 id"),
    }),
  },
  async (args) => textResult(await api.readNote(args.path, args.vaultId)),
);

server.registerTool(
  "baihua_budget_summary",
  {
    title: "百花家庭记账汇总",
    description: "查看百花家庭记账汇总（本月收入/支出/结余/分类）。",
    inputSchema: z.object({}),
  },
  async () => textResult(await api.budgetSummary()),
);

server.registerTool(
  "baihua_tasks_list",
  {
    title: "百花家庭任务列表",
    description: "查看百花家庭任务/待办列表（标题/状态/时间）。",
    inputSchema: z.object({}),
  },
  async () => textResult(await api.listTasks()),
);

await server.connect(new StdioServerTransport());
