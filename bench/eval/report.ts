// Turning the run records into the console summary, the JSON result and the markdown record.
// Output from the scripted model carries a banner everywhere and is never mistaken for a result.
import type { Gate, Summary } from './aggregate';
import type { Condition, RunRecord } from './types';

export interface EvalMeta {
  /** `YYYY-MM-DD`. */
  date: string;
  model: string;
  /** The scripted model: a pipeline check, not a measurement. */
  fake: boolean;
  trials: number;
  maxTurns: number;
  maxTokens: number;
  effort?: string;
  cache: boolean;
  via: string;
  node: string;
  mounted: string[];
  tasks: string[];
  conditions: Condition[];
  mcp2cliVersion?: string;
  mcp2cliSkipped?: string;
}

export const FAKE_BANNER = 'SCRIPTED MODEL (--fake-model): pipeline check only. These numbers are NOT an evaluation of any model; token counts are byte estimates.';

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const one = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
const percent = (n: number): string => `${Math.round(n * 100)}%`;
const seconds = (ms: number): string => one(ms / 1000);

function interval(c: { interval: [number, number] }): string {
  return `${percent(c.interval[0])}–${percent(c.interval[1])}`;
}

function table(head: readonly string[], body: ReadonlyArray<readonly string[]>): string[] {
  return [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`), ''];
}

function summaryRows(summary: Summary): string[][] {
  return summary.conditions.map((c) => [
    c.condition,
    `${c.successes}/${c.runs}`,
    c.runs === 0 ? 'n/a' : `${percent(c.rate)} (${interval(c)})`,
    `${fmt(c.inputTokens.mean)} / ${fmt(c.inputTokens.median)}`,
    `${fmt(c.outputTokens.mean)} / ${fmt(c.outputTokens.median)}`,
    `${fmt(c.totalTokens.mean)} / ${fmt(c.totalTokens.median)}`,
    `${one(c.turns.mean)} / ${one(c.turns.median)}`,
    one(c.toolCalls.mean),
    one(c.errorCalls.mean),
    seconds(c.wallMs.mean),
  ]);
}

const SUMMARY_HEAD = ['condition', 'success', 'rate (95% CI)', 'input tok mean / median', 'output tok mean / median', 'total tok mean / median', 'turns mean / median', 'tool calls', 'error calls', 'wall s'];

function gateLines(gate: Gate): string[] {
  const lines: string[] = [];
  if (!gate.evaluated) {
    lines.push(`gate 1: not evaluated${gate.notes.length > 0 ? ` (${gate.notes[0]})` : ''}`);
    return lines;
  }
  const verdict = gate.holds ? (gate.complete ? 'HOLDS' : 'HOLDS so far (incomplete)') : 'DOES NOT HOLD';
  lines.push(`gate 1 (via success rate not lower than native and mcp2cli): ${verdict}`);
  for (const c of gate.comparisons) {
    lines.push(
      `  via ${percent(c.via.rate)} (${c.via.successes}/${c.via.runs}) ${c.holds ? '>=' : '<'} ${c.versus} ${percent(c.other.rate)} (${c.other.successes}/${c.other.runs})${c.withinNoise ? '  [intervals overlap]' : ''}`,
    );
  }
  for (const note of gate.notes) lines.push(`  note: ${note}`);
  return lines;
}

/** Plain-text summary for the terminal. */
export function formatConsole(runs: readonly RunRecord[], summary: Summary, meta: EvalMeta): string {
  const out: string[] = [];
  if (meta.fake) out.push(FAKE_BANNER, '');
  out.push(`agent evaluation ${meta.date}: model ${meta.model}, ${meta.tasks.length} tasks × ${meta.trials} trial(s), ${runs.length} runs`, '');
  const rows = summaryRows(summary);
  const widths = SUMMARY_HEAD.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ').trimEnd();
  out.push(line(SUMMARY_HEAD), ...rows.map(line), '');

  const conditions = summary.conditions.map((c) => c.condition);
  const taskWidth = Math.max(4, ...summary.tasks.map((t) => t.task.length));
  out.push(['task'.padEnd(taskWidth), ...conditions.map((c) => c.padStart(9))].join('  '));
  for (const t of summary.tasks) {
    out.push([t.task.padEnd(taskWidth), ...conditions.map((c) => (t.cells[c] ? `${t.cells[c]!.successes}/${t.cells[c]!.runs}` : '-').padStart(9))].join('  '));
  }
  out.push('');
  if (meta.mcp2cliSkipped) out.push(`mcp2cli: skipped (${meta.mcp2cliSkipped})`, '');
  out.push(...gateLines(summary.gate), '');
  const failed = runs.filter((r) => !r.success);
  if (failed.length > 0) {
    out.push(`${failed.length} unsuccessful run(s):`);
    for (const r of failed.slice(0, 20)) out.push(`  ${r.condition} ${r.task} #${r.trial} [${r.status}] ${failedChecks(r).join('; ')}${r.error ? ` — ${r.error}` : ''}`);
    if (failed.length > 20) out.push(`  … ${failed.length - 20} more in the JSON result`);
    out.push('');
  }
  if (meta.fake) out.push(FAKE_BANNER, '');
  return out.join('\n');
}

const failedChecks = (r: RunRecord): string[] => r.verdict.checks.filter((c) => !c.ok).map((c) => c.label);

/** The full result as JSON: meta, summary, gate and every run with its calls. */
export function formatJson(runs: readonly RunRecord[], summary: Summary, meta: EvalMeta): string {
  return `${JSON.stringify({ ...(meta.fake ? { notice: FAKE_BANNER } : {}), meta, summary, runs }, null, 2)}\n`;
}

/** The markdown record that goes next to the JSON in `bench/results/`. */
export function formatMarkdown(runs: readonly RunRecord[], summary: Summary, meta: EvalMeta): string {
  const lines: string[] = [];
  lines.push(`# agent 评测结果（${meta.date}）`, '');
  if (meta.fake) lines.push(`> **${FAKE_BANNER}**`, '');
  lines.push(
    '由 `npm run bench:eval` 生成，方法见 [测试与评测](../../docs/development/testing.md#agent-评测) 和 [bench/README.md](../README.md)。成功与否完全由回放 server 的调用日志判定（每个任务的 `success` 块），不由模型自评。',
    '',
  );

  lines.push('## 环境', '');
  lines.push(`- 模型：${meta.model}${meta.effort ? `，effort ${meta.effort}` : ''}${meta.cache ? '，提示缓存开启' : ''}`);
  lines.push(`- ${meta.tasks.length} 个任务 × ${meta.trials} 次，共 ${runs.length} 次运行；每次最多 ${meta.maxTurns} 轮，单次回复最多 ${fmt(meta.maxTokens)} 输出 token`);
  lines.push(`- via ${meta.via}，Node.js ${meta.node}`);
  lines.push(`- 挂载的 server：${meta.mounted.join('、')}`);
  lines.push(meta.mcp2cliVersion ? `- 对照：mcp2cli ${meta.mcp2cliVersion}` : `- 对照：mcp2cli 未运行（${meta.mcp2cliSkipped ?? '不可用'}）`, '');

  lines.push('## 总览', '');
  lines.push(...table(SUMMARY_HEAD, summaryRows(summary)));
  lines.push('token 取自 API 返回的 `usage`，按轮累加；输入含缓存读写。错误调用 = 非零退出码、`isError`，或回放 server 没有对应返回值的调用。', '');

  lines.push('## 门槛 1', '');
  const gate = summary.gate;
  if (!gate.evaluated) {
    lines.push(`未评估${gate.notes.length > 0 ? `：${gate.notes[0]}` : ''}。`, '');
  } else {
    lines.push(`**${gate.holds ? (gate.complete ? '成立' : '目前成立，但比较不完整') : '不成立'}**：via 的任务成功率不低于原生 MCP，且不低于 mcp2cli（[路线图](../../docs/roadmap.md#门槛)）。`, '');
    lines.push(
      ...table(
        ['对比', 'via', '对照', '结果'],
        gate.comparisons.map((c) => [
          `via vs ${c.versus}`,
          `${percent(c.via.rate)} (${c.via.successes}/${c.via.runs})`,
          `${percent(c.other.rate)} (${c.other.successes}/${c.other.runs})`,
          `${c.holds ? '不低于' : '低于'}${c.withinNoise ? '（区间重叠）' : ''}`,
        ]),
      ),
    );
    for (const note of gate.notes) lines.push(`- ${note}`);
    if (gate.notes.length > 0) lines.push('');
  }

  lines.push('## 各任务成功次数', '');
  const conditions = summary.conditions.map((c) => c.condition);
  lines.push(...table(['任务', ...conditions], summary.tasks.map((t) => [t.task, ...conditions.map((c) => (t.cells[c] ? `${t.cells[c]!.successes}/${t.cells[c]!.runs}` : '-'))])));

  const failed = runs.filter((r) => !r.success);
  lines.push('## 未成功的运行', '');
  if (failed.length === 0) {
    lines.push('没有。', '');
  } else {
    lines.push(
      ...table(
        ['条件', '任务', '第几次', '结束状态', '没通过的检查'],
        failed.map((r) => [r.condition, r.task, String(r.trial), r.status, (failedChecks(r).join('；') || (r.error ?? '')).replace(/\|/g, '\\|')]),
      ),
    );
  }

  lines.push('## 这些数字说明什么', '');
  lines.push(
    '- 成功率是「完成任务」的比例，任务由回放 server 的调用日志判定：必需的调用（工具加参数子集）已被回放 server 回答、禁止的调用从未发出、写操作不超过规定次数，只读任务另查最终回答是否提到关键事实。判定标准见任务文件的 `success` 块。',
    '- 返回值是合成数据，且同一工具的返回值不随参数变化（除非任务按参数区分）。它能检验「模型会不会找到并正确调用工具」，不能检验真实 server 的行为差异。',
    '- 三个条件共用同一份任务描述、同一段系统提示骨架（见 [bench/README.md](../README.md#系统提示)），差别只在各自的工具和说明文本。',
    '- 样本量小时差异可能只是噪声；总览里给出 95% Wilson 区间，区间重叠就不要把差异当结论，增加 `--trials`。',
    '- 模型的采样有随机性，同一组任务多跑几次的结果不会完全一样；不同模型的结论不能互相替代。',
    '',
  );
  return lines.join('\n');
}
