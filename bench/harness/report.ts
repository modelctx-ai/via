// Turning a SuiteMeasure into the console table, the JSON result and the markdown record.
import { BYTES_PER_TOKEN, estimateTokens } from './tokens';
import type { SessionMeasure, SuiteMeasure, TaskMeasure } from './measure';

export interface ReportMeta {
  /** via version under test. */
  via: string;
  node: string;
  /** Why the mcp2cli column is absent, when it is. */
  mcp2cliSkipped?: string;
  mounted: string[];
}

export interface Row {
  id: string;
  title: string;
  /** Tokens (estimated) per column. */
  native: number;
  via: number;
  mcp2cli?: number;
}

const ratio = (a: number, b: number): string => (b === 0 ? 'n/a' : `${Math.round((a / b) * 100)}%`);
const fmt = (n: number): string => n.toLocaleString('en-US');

export function rows(measure: SuiteMeasure): Row[] {
  return measure.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    native: estimateTokens(t.native.totalBytes),
    via: estimateTokens(t.via.totalBytes),
    ...(t.mcp2cli ? { mcp2cli: estimateTokens(t.mcp2cli.totalBytes) } : {}),
  }));
}

export function totals(rs: readonly Row[]): Row {
  const hasM = rs.every((r) => r.mcp2cli !== undefined);
  return {
    id: 'total',
    title: 'total',
    native: rs.reduce((n, r) => n + r.native, 0),
    via: rs.reduce((n, r) => n + r.via, 0),
    ...(hasM ? { mcp2cli: rs.reduce((n, r) => n + (r.mcp2cli ?? 0), 0) } : {}),
  };
}

function pad(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ').trimEnd();
}

/** Plain-text table for the terminal. */
export function formatConsole(measure: SuiteMeasure, meta: ReportMeta): string {
  const rs = rows(measure);
  const all = [...rs, totals(rs)];
  const hasM = all.every((r) => r.mcp2cli !== undefined);
  const head = ['task', 'native', 'via', ...(hasM ? ['mcp2cli'] : []), 'via/native', ...(hasM ? ['mcp2cli/native'] : [])];
  const body = all.map((r) => [
    r.id,
    fmt(r.native),
    fmt(r.via),
    ...(hasM ? [fmt(r.mcp2cli!)] : []),
    ratio(r.via, r.native),
    ...(hasM ? [ratio(r.mcp2cli!, r.native)] : []),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const lines = [pad(head, widths), ...body.slice(0, -1).map((b) => pad(b, widths)), '-'.repeat(widths.reduce((n, w) => n + w + 2, -2)), pad(body.at(-1)!, widths)];
  const perTurn = estimateTokens(measure.injection.bytes);
  const toolCount = Object.values(measure.injection.perServer).reduce((n, s) => n + s.tools, 0);
  lines.push(
    '',
    `tokens are estimated at ${BYTES_PER_TOKEN} bytes each; mounted: ${meta.mounted.join(', ')} (${toolCount} tools)`,
    `native injects ~${fmt(perTurn)} tokens on every turn; via prompt ~${fmt(estimateTokens(measure.viaPromptBytes))} once` +
      (measure.mcp2cli ? `; mcp2cli instructions ~${fmt(estimateTokens(measure.mcp2cli.fixedBytes))} once (mcp2cli ${measure.mcp2cli.version})` : ''),
  );
  if (meta.mcp2cliSkipped) lines.push(`mcp2cli column skipped: ${meta.mcp2cliSkipped}`);
  return `${lines.join('\n')}\n`;
}

// JSON -----------------------------------------------------------------------------------------

function sessionJson(s: SessionMeasure & { totalBytes: number }) {
  return {
    fixedBytes: s.fixedBytes,
    sessionBytes: s.sessionBytes,
    totalBytes: s.totalBytes,
    totalTokens: estimateTokens(s.totalBytes),
    steps: s.steps.map((st) => ({ command: st.command, commandBytes: st.commandBytes, stdoutBytes: st.stdoutBytes, stderrBytes: st.stderrBytes, exit: st.exit })),
  };
}

export function formatJson(measure: SuiteMeasure, meta: ReportMeta): string {
  const rs = rows(measure);
  const result = {
    schema: 1,
    estimator: { bytesPerToken: BYTES_PER_TOKEN },
    via: meta.via,
    node: meta.node,
    mounted: meta.mounted,
    injection: {
      bytesPerTurn: measure.injection.bytes,
      tokensPerTurn: estimateTokens(measure.injection.bytes),
      servers: measure.injection.perServer,
    },
    viaPromptBytes: measure.viaPromptBytes,
    mcp2cli: measure.mcp2cli ? { version: measure.mcp2cli.version, fixedBytes: measure.mcp2cli.fixedBytes } : { skipped: meta.mcp2cliSkipped ?? 'not run' },
    tasks: measure.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      goal: t.goal,
      native: {
        turns: t.native.turns,
        injectionBytes: t.native.injectionBytes,
        callBytes: t.native.callBytes,
        resultBytes: t.native.resultBytes,
        totalBytes: t.native.totalBytes,
        totalTokens: estimateTokens(t.native.totalBytes),
        calls: t.native.calls,
      },
      via: sessionJson(t.via),
      ...(t.mcp2cli ? { mcp2cli: sessionJson(t.mcp2cli) } : {}),
    })),
    totals: totals(rs),
  };
  return `${JSON.stringify(result, null, 2)}\n`;
}

// Markdown -------------------------------------------------------------------------------------

const tokens = (bytes: number): string => fmt(estimateTokens(bytes));

/** A GitHub-flavoured table; `---:` right-aligns every column but the first. */
function mdTable(head: readonly string[], body: ReadonlyArray<readonly string[]>): string[] {
  return [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`), ''];
}

function taskSection(t: TaskMeasure): string[] {
  const n = t.native;
  const out = [`### ${t.id}`, '', t.goal.trim().replace(/\s*\n\s*/g, ' '), ''];
  out.push(`- native：${n.turns} 轮 × ${tokens(n.injectionBytes)} 注入 + ${tokens(n.callBytes)} 调用 + ${tokens(n.resultBytes)} 原始结果 = **${tokens(n.totalBytes)}**`);
  out.push(`- via：说明 ${tokens(t.via.fixedBytes)} + ${t.via.steps.length} 条命令共 ${tokens(t.via.sessionBytes)} = **${tokens(t.via.totalBytes)}**`);
  if (t.mcp2cli) out.push(`- mcp2cli：说明 ${tokens(t.mcp2cli.fixedBytes)} + ${t.mcp2cli.steps.length} 条命令共 ${tokens(t.mcp2cli.sessionBytes)} = **${tokens(t.mcp2cli.totalBytes)}**`);
  out.push('');
  const steps = (label: string, s: SessionMeasure): string[] => [
    `${label} 逐步（tokens）：`,
    '',
    ...mdTable(
      ['命令', '命令文本', '输出'],
      s.steps.map((st) => [`\`${st.command.replace(/\|/g, '\\|')}\``, tokens(st.commandBytes), tokens(st.stdoutBytes + st.stderrBytes)]),
    ),
  ];
  out.push(...steps('via', t.via));
  if (t.mcp2cli) out.push(...steps('mcp2cli', t.mcp2cli));
  return out;
}

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

export function formatMarkdown(measure: SuiteMeasure, meta: ReportMeta, release: string): string {
  const rs = rows(measure);
  const total = totals(rs);
  const hasM = total.mcp2cli !== undefined;
  const mcp2cli = measure.mcp2cli;
  const toolCount = sum(Object.values(measure.injection.perServer).map((s) => s.tools));
  const lines: string[] = [];

  lines.push(`# token 基准结果（${release}）`, '');
  lines.push(
    '由 `npm run bench:tokens` 生成，方法见 [测试与评测](../../docs/development/testing.md#token-基准) 和 [bench/README.md](../README.md)。数字是估算（4 字节约 1 token），读之前请先看文末的「这些数字说明什么」。',
    '',
  );

  lines.push('## 环境', '');
  lines.push(`- via ${meta.via}，Node.js ${meta.node}`);
  lines.push(`- 挂载的 server：${meta.mounted.join('、')}（共 ${toolCount} 个工具）`);
  lines.push(mcp2cli ? `- 对照：mcp2cli ${mcp2cli.version}（说明文本取自它自带的 skill）` : `- 对照：mcp2cli 一列未运行（${meta.mcp2cliSkipped ?? '不可用'}）`);
  lines.push(`- token 估算：${BYTES_PER_TOKEN} 字节约 1 token，与 \`via doctor\` 相同`, '');

  lines.push('## 总览', '');
  lines.push(
    ...mdTable(
      ['任务', 'native', 'via', ...(hasM ? ['mcp2cli'] : []), 'via / native', ...(hasM ? ['mcp2cli / native'] : [])],
      [...rs, total].map((r) => [
        r.id === 'total' ? '**合计**' : r.id,
        fmt(r.native),
        fmt(r.via),
        ...(hasM ? [fmt(r.mcp2cli!)] : []),
        ratio(r.via, r.native),
        ...(hasM ? [ratio(r.mcp2cli!, r.native)] : []),
      ]),
    ),
  );

  const perServer = Object.entries(measure.injection.perServer).map(([s, v]) => `${s} ${fmt(estimateTokens(v.bytes))}`).join('、');
  const injected = sum(measure.tasks.map((t) => t.native.injectionBytes * t.native.turns));
  const nativeBytes = sum(measure.tasks.map((t) => t.native.totalBytes));
  lines.push(
    `native 每轮注入约 ${fmt(estimateTokens(measure.injection.bytes))} token（${perServer}），占它总量的 ${Math.round((injected / nativeBytes) * 100)}%；via 的说明（\`via prompt\`）约 ${fmt(estimateTokens(measure.viaPromptBytes))} token` +
      (mcp2cli ? `；mcp2cli 的说明约 ${fmt(estimateTokens(mcp2cli.fixedBytes))} token。` : '。'),
    '',
  );

  // Two sensitivity checks the headline table hides.
  lines.push('### 换个算法会怎样', '');
  lines.push('总览按任务要求，把 via 与 mcp2cli 的说明文本只算一次，native 的工具定义按每轮算。两边的口径可以各换一种：', '');
  lines.push('- **说明常驻每一轮**：说明放在 AGENTS.md 或 skill 里，和工具定义一样随每轮请求发送（提示缓存降低费用，但不改变占用的上下文）。按「说明 × 轮数」重算。');
  lines.push('- **native 不计注入**：框架对工具定义做延迟加载或检索时，每轮注入接近零，但调用和原始结果仍在。这一行只剩调用与原始结果，不含发现成本，所以偏低。', '');
  const resident = (fixed: number, steps: number, session: number): number => estimateTokens(fixed * (steps + 1) + session);
  const residentVia = sum(measure.tasks.map((t) => resident(t.via.fixedBytes, t.via.steps.length, t.via.sessionBytes)));
  const residentM = hasM ? sum(measure.tasks.map((t) => resident(t.mcp2cli!.fixedBytes, t.mcp2cli!.steps.length, t.mcp2cli!.sessionBytes))) : 0;
  const nativeFree = sum(measure.tasks.map((t) => estimateTokens(t.native.callBytes + t.native.resultBytes)));
  lines.push(
    ...mdTable(
      ['', 'native', 'via', ...(hasM ? ['mcp2cli'] : [])],
      [
        ['总览（说明算一次）', fmt(total.native), fmt(total.via), ...(hasM ? [fmt(total.mcp2cli!)] : [])],
        ['说明常驻每一轮', fmt(total.native), fmt(residentVia), ...(hasM ? [fmt(residentM)] : [])],
        ['native 不计注入', fmt(nativeFree), fmt(total.via), ...(hasM ? [fmt(total.mcp2cli!)] : [])],
      ],
    ),
  );

  lines.push('## 任务明细', '');
  for (const t of measure.tasks) lines.push(...taskSection(t));

  lines.push('## 这些数字说明什么', '');
  lines.push(
    '**说明的**：同一组任务、同一批 server 之下，三种方式放进模型上下文的内容量级差异——原生注入的每轮固定成本，via 的说明加按需发现与紧凑渲染，mcp2cli 的说明加平铺列表与原样 JSON。命令文本和 stdout、stderr（含元信息行）都是真实运行 `dist/via.js` 得到的字节数，不是估计的。',
    '',
    '**不说明的**：',
    '',
    '- 任务成功率、错误调用和发现轮数。via 与 mcp2cli 的命令序列是人按「合理的 agent 路径」写的脚本，不是模型的实际行为；真实模型会多走弯路，也可能少走。这部分由 agent 评测验证（[测试与评测](../../docs/development/testing.md#agent-评测)）。',
    `- 精确的 token 数。这里只做 ${BYTES_PER_TOKEN} 字节约 1 token 的估算；代码、中日韩文本或标点密集的 JSON 的实际比例不同，三列的偏差方向也不一定一致。比较的是量级和比例，不是计费。`,
    '- 夹具有一部分是合成的（见 [test/fixtures/README.md](../../test/fixtures/README.md)）。工具名取自真实 server，但描述和参数已精简、没有逐参数的说明文字，所以 native 的注入成本是**偏低**估计：真实的 GitHub、Notion 的 `tools/list` 要大得多。',
    '- `tools/call` 的结果是按常见 API 的形状合成的（`bench/recordings/`）。via 在结果侧的节省取决于 server 返回的 JSON 有多冗余；已经精简输出的 server 上差距会小得多。文本型结果（源码文件、页面快照、Markdown）via 原样输出，三列相同，`github-find-code` 与 `playwright-docs-search` 里能看到。快照也比真实页面小得多。',
    '- native 一列是「全部工具定义每轮完整注入」的朴素模型。支持工具延迟加载或检索的框架会大幅降低这一项，参考上面「native 不计注入」一行。',
    '- 轮数：native 按「每个并行调用批次一轮，再加最后的回答一轮」；via 与 mcp2cli 的每条命令各占一轮，不假设 agent 会把多条命令合并成一次 shell 调用。',
    '- 没有计入模型自己写的思考和最终回答，也没有计入对话历史的累积（三种方式都有）；native 的每轮注入按未缓存计。',
    '- 命令序列的选择有主观成分：mcp2cli 在工具不超过 25 个的 server 上用 `--list`，更大的用 `--search <关键词>`，每条要用的命令先看一次 `--help`（它的 skill 就是这样写的）；via 从 `via <provider>` 或 `via find` 开始（`via prompt` 的域摘要已说明有哪些 provider），资源视图的签名够写出调用时不再加 `-h`。',
    '- 为了可复现，元信息行里的耗时统一记为 `100ms`，端口和沙箱路径也做了归一。',
    '',
  );
  return lines.join('\n');
}
