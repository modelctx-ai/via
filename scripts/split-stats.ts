// Split statistics (roadmap d5): how often the name split falls back to a leaf tool on the
// tools/list fixtures, per server and overall, and why. Offline and deterministic: it runs the
// same code as the CLI (src/catalog) over test/fixtures/tools. Run with `npm run split-stats`;
// `--out <base>` writes <base>.md and <base>.json (bench/results/0.4-split); a hand-written
// "对动词表的建议" section at the end of an existing <base>.md is kept.
//
//   --dir <dir>               fixture directory (default test/fixtures/tools); repeatable
//   --baseline-verbs <file>   a data/verbs.json from before a change (e.g. `git show v0.3.1:data/verbs.json`):
//                             the report then shows the leaf counts under both lists
//   --out <base>              write <base>.md and <base>.json
//   --release <tag>           label in the markdown title (default: dev)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultCatalogRules } from '../src/catalog';
import type { CatalogRules, McpTool } from '../src/catalog';
import { compileSplitRules, type VerbsData } from '../src/catalog/rules';
import { measureProvider, REASONS, WHY, type Reason, type ServerStats } from './lib/split-stats';

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const dirs = args.flatMap((a, i) => (a === '--dir' ? [args[i + 1]!] : []));
const out = value('--out');
const release = value('--release') ?? 'dev';

const rules = defaultCatalogRules();
const baselineFile = value('--baseline-verbs');
const baselineRules: CatalogRules | undefined = baselineFile
  ? { ...rules, split: compileSplitRules(JSON.parse(readFileSync(baselineFile, 'utf8')) as VerbsData) }
  : undefined;

function measure(dir: string, file: string, rules: CatalogRules): ServerStats {
  const tools = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { tools: McpTool[] }).tools;
  return measureProvider(basename(file, '.json'), tools, rules);
}

const stats: ServerStats[] = [];
const before: ServerStats[] = [];
for (const dir of dirs.length > 0 ? dirs : ['test/fixtures/tools']) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    stats.push(measure(dir, file, rules));
    if (baselineRules) before.push(measure(dir, file, baselineRules));
  }
}

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);
const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${(Math.round((n / d) * 1000) / 10).toFixed(1)}%`);
const count = (s: ServerStats, reason: Reason): number => s.leaves.filter((l) => l.reason === reason).length;
const totalTools = sum(stats.map((s) => s.tools));
const totalLeaves = sum(stats.map((s) => s.leaves.length));

/** Words at the start and the end of the names that have no verb: candidates for the verb list. */
function edgeWords(): Array<{ word: string; asFirst: number; asLast: number; servers: string[] }> {
  const table = new Map<string, { asFirst: number; asLast: number; servers: Set<string> }>();
  for (const s of stats) {
    for (const leaf of s.leaves.filter((l) => l.reason === 'no-verb')) {
      const words = leaf.name.split('-');
      const note = (word: string, key: 'asFirst' | 'asLast'): void => {
        const entry = table.get(word) ?? { asFirst: 0, asLast: 0, servers: new Set<string>() };
        entry[key] += 1;
        entry.servers.add(s.server);
        table.set(word, entry);
      };
      note(words[0]!, 'asFirst');
      if (words.length > 1) note(words[words.length - 1]!, 'asLast');
    }
  }
  return [...table].map(([word, e]) => ({ word, asFirst: e.asFirst, asLast: e.asLast, servers: [...e.servers].sort() })).sort((a, b) => b.asFirst + b.asLast - (a.asFirst + a.asLast) || (a.word < b.word ? -1 : 1));
}

function markdown(): string {
  const lines: string[] = [];
  lines.push(`# 拆分统计（${release}）`, '');
  lines.push(
    '由 `npm run split-stats` 生成：对 `test/fixtures/tools/` 里每个 server 的 `tools/list` 运行与 CLI 相同的拆分与冲突处理（[naming.md](../../docs/spec/naming.md)），统计退回为叶子工具的比例和原因。离线、确定性，同一份夹具和同一份 `data/verbs.json` 得到同样的数字。',
    '',
  );
  lines.push('## 先读这个：夹具的可信度', '');
  lines.push(
    '[夹具说明](../../test/fixtures/README.md#来源与可信度)：只有 `github`、`notion`、`cloudflare` 的工具名取自实际连接的 server；`linear`、`playwright`、`exa`、`filesystem`、`slack`、`puppeteer`、`context7`、`tavily`、`sqlite`、`postgres` 依据公开的工具列表整理，不保证逐字一致；`gmail`、`google-drive` 是为覆盖某种形态虚构的样本。所以下面的比例**说明规则在这十五个样本上的表现**，不是对「真实 server 的叶子比例」的无偏估计；要得到后者，需要更多真实 `tools/list`（把它们放进夹具后重跑本脚本即可）。`acme-*` 与 `aster` 是虚构的边缘样本，不计入。',
    '',
  );

  lines.push('## 总览', '');
  const beforeLeaves = sum(before.map((b) => b.leaves.length));
  lines.push(`${stats.length} 个 server、${totalTools} 个工具，其中 ${totalLeaves} 个最终是叶子工具，**叶子比例 ${pct(totalLeaves, totalTools)}**。`);
  if (baselineRules) lines.push(`动词表改动前（\`${baselineFile ? basename(baselineFile) : ''}\` 的基线）是 ${beforeLeaves} 个，${pct(beforeLeaves, totalTools)}。`);
  lines.push('');
  const beforeOf = (server: string): number | undefined => before.find((b) => b.server === server)?.leaves.length;
  lines.push(`| server | 工具数 | 拆成 资源:动作 | 叶子 | 叶子比例 | ${baselineRules ? '改动前叶子 | ' : ''}无动词 | 只有动词 | 冲突 | 让名 |`, `| --- | ---: | ---: | ---: | ---: | ${baselineRules ? '---: | ' : ''}---: | ---: | ---: | ---: |`);
  for (const s of stats) {
    lines.push(`| ${s.server} | ${s.tools} | ${s.tools - s.leaves.length} | ${s.leaves.length} | ${pct(s.leaves.length, s.tools)} | ${baselineRules ? `${beforeOf(s.server)} | ` : ''}${REASONS.map((r) => count(s, r)).join(' | ')} |`);
  }
  lines.push(`| **合计** | ${totalTools} | ${totalTools - totalLeaves} | ${totalLeaves} | **${pct(totalLeaves, totalTools)}** | ${baselineRules ? `${beforeLeaves} | ` : ''}${REASONS.map((r) => sum(stats.map((s) => count(s, r)))).join(' | ')} |`, '');
  lines.push('“拆成 资源:动作”是冲突处理之后的最终结果。列含义：', '');
  for (const r of REASONS) lines.push(`- ${{ 'no-verb': '无动词', 'verb-only': '只有动词', conflict: '冲突', shadowed: '让名' }[r]}：${WHY[r]}`);
  lines.push('');

  lines.push('## 哪些原始名退回为叶子，为什么', '');
  for (const s of stats.filter((x) => x.leaves.length > 0)) {
    lines.push(`### ${s.server}（${s.leaves.length}/${s.tools}）`, '');
    lines.push('| 原始名 | 叶子名 | 原因 |', '| --- | --- | --- |');
    for (const l of s.leaves) {
      const detail = l.detail ? `：\`${l.detail}\`` : '';
      lines.push(`| \`${l.raw}\` | \`${l.name}\` | ${{ 'no-verb': '无动词', 'verb-only': '只有动词', conflict: '冲突', shadowed: '让名' }[l.reason]}${detail} |`);
    }
    lines.push('');
  }

  const edges = edgeWords();
  lines.push('## 无动词叶子的首词与末词', '');
  lines.push('这些词出现在没有动词的叶子名的开头或结尾，是动词表的候选来源；是否收入要看它在该位置是不是动作，取舍见文末「对动词表的建议」。', '');
  lines.push('| 词 | 作首词 | 作末词 | 出现在 |', '| --- | ---: | ---: | --- |');
  for (const e of edges) lines.push(`| ${e.word} | ${e.asFirst} | ${e.asLast} | ${e.servers.join('、')} |`);
  lines.push('');
  return lines.join('\n');
}

const NOTES = '## 对动词表的建议';
let text = markdown();
if (out) {
  const base = resolve(out);
  mkdirSync(dirname(base), { recursive: true });
  // The recommendations are written by hand after reading the tables; regenerating keeps them.
  try {
    const previous = readFileSync(`${base}.md`, 'utf8');
    const at = previous.indexOf(NOTES);
    if (at >= 0) text = `${text}\n${previous.slice(at)}`;
  } catch {
    // first run
  }
  writeFileSync(`${base}.md`, text);
  writeFileSync(
    `${base}.json`,
    `${JSON.stringify({ schema: 1, totals: { servers: stats.length, tools: totalTools, leaves: totalLeaves }, servers: stats }, null, 2)}\n`,
  );
  process.stdout.write(`wrote ${out}.md and ${out}.json\n`);
}
process.stdout.write(`${stats.length} servers, ${totalTools} tools, ${totalLeaves} leaves (${pct(totalLeaves, totalTools)})\n`);
for (const s of stats) process.stdout.write(`  ${s.server.padEnd(14)} ${String(s.leaves.length).padStart(3)}/${String(s.tools).padEnd(3)} ${pct(s.leaves.length, s.tools).padStart(6)}\n`);
