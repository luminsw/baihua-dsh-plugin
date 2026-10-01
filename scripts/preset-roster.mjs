#!/usr/bin/env node
/**
 * 列出 web profile 的 agent preset 名册，并打印每个 preset 的**挂载失败原因**。
 *
 * 为什么需要它：客户端的新会话预设选择器会**隐藏 broken 的 preset**
 * （`@deepseek-ai/dsh-client-ui-agent-preset` 里 `presets.filter((p) => p.broken === void 0)`），
 * 所以「界面里看不到某个模式」几乎总是 = 该 preset 挂载失败。失败的详情只写在设置页的红字里，
 * 没有日志文件；本脚本在进程内 boot 一次 profile，直接调用注册表的 `list()` 拿到原因。
 *
 * 用法：
 *   node scripts/preset-roster.mjs                # 默认 profile=web
 *   node scripts/preset-roster.mjs tui            # 指定其它 profile
 * 需要 DSH_HOME（默认 ~/.dsh）与能解析 @deepseek-ai/dsh 的 node_modules。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const profile = process.argv[2] ?? 'web';
const require = createRequire(import.meta.url);

/** 解析 dsh 安装目录：优先包解析，失败则按 profile 依赖层里的 junction 定位。 */
function dshPackageDir() {
  const fromEnv = process.env.DSH_INSTALL;
  if (fromEnv !== undefined && existsSync(join(fromEnv, 'package.json'))) return fromEnv;
  try {
    return dirname(require.resolve('@deepseek-ai/dsh/package.json'));
  } catch {
    throw new Error('解析不到 @deepseek-ai/dsh：请在本插件的 node_modules 能触达它的地方运行，或设置 DSH_INSTALL');
  }
}

const dshDir = dshPackageDir();
const scopeDir = dirname(dshDir);
const bootEntry = join(dshDir, 'lib', 'profile-boot.js');
const appBootEntry = join(scopeDir, 'dsh-app-boot', 'lib', 'index.js');
if (!existsSync(bootEntry)) throw new Error('找不到 ' + bootEntry);
if (!existsSync(appBootEntry)) throw new Error('找不到 ' + appBootEntry);

const { runProfile } = await import(pathToFileURL(bootEntry).href);
const { loadLayeredEnv } = await import(pathToFileURL(appBootEntry).href);

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  patchFiles: [],
  args: ['--port', '0', '--no-open'], // 随机端口，避免打断在跑的实例
});

let registry;
for (let i = 0; i < 200 && registry === undefined; i += 1) {
  registry = ctx.get('agentPresets');
  if (registry === undefined) await new Promise((r) => setTimeout(r, 250));
}

if (registry === undefined) {
  console.error('\n[preset-roster] profile ' + profile + ' 没有 agentPresets 服务（可能该 profile 未装 agent-preset-registry）');
  await shutdown.shutdown(1);
  process.exit(1);
}

const rows = await registry.list();
console.log(`\n=== ${profile} 的 preset 名册（${rows.length} 条）===`);
for (const row of rows) {
  const ok = row.broken === undefined;
  console.log(`${ok ? '[ok]    ' : '[BROKEN]'} ${row.id}  order=${row.order ?? '-'}  ${row.name ?? ''}`);
  if (!ok) console.log('         reason: ' + String(row.broken).replaceAll('\n', '\n                 '));
}
const broken = rows.filter((r) => r.broken !== undefined);
console.log(`默认 preset: ${registry.defaultId ?? '(none)'}｜broken: ${broken.length}`);
await shutdown.shutdown(broken.length === 0 ? 0 : 1);
process.exit(broken.length === 0 ? 0 : 1);
