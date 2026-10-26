# 0028. 在配置里禁止、只允许、隐藏或只显示某些子命令（`commands`）

- 状态：已接受
- 日期：2026-10-26

## 背景

via 的内置子命令（`find`、`call`、`serve`、`trust`、`auth`、`daemon`…）对每个用户都是同一套。维护者希望能在 via 这一层配置：哪些子命令禁止运行，或者只允许哪些；哪些出现在帮助与给 agent 的说明里，哪些不出现。用途举例：

- 不想让 agent 拉起 `via serve`、改 daemon 的状态，或者看到 `via trust`、`via auth` 这类要人来做的命令；
- 把帮助、`via prompt`、`via serve` 的工具列表收窄到常用的几条，少占 agent 的上下文。

已有的 `deny` 匹配的是工具引用，`disabled` 隐藏整个 server；两者都管不到子命令。

## 决策

1. **配置**（[config.md](../spec/config.md#commands)）：

   ```yaml
   commands:
     deny: [serve, daemon]       # 禁止运行
     allow: [find, call, more]   # 只允许这些（不写 = 全部）
     hide: [doctor]              # 不显示，仍可运行
     show: [find, call]          # 只显示这些（不写 = 全部）
   ```

   名字是内置子命令名，比较方式与命令行相同（大小写不敏感，`_` 等于 `-`）。`help` 不能被限制（它是知道还剩什么的途径），写了只告警。

2. **含义**：
   - 可以运行 = 在 `allow` 里（没写 `allow` 则全部）且不在 `deny` 里。
   - 显示 = 可以运行，且在 `show` 里（没写 `show` 则全部）且不在 `hide` 里。不能运行的一律不显示。
   - 「显示」覆盖的地方：`via -h` 与 `via help` 的用法行和 `commands:` 行；`via prompt` 的说明（`find` 那一行、`via more` 那半句）；`via serve` 的 `tools/list`（每个元工具对应一个子命令，`via_browse` 对应 provider 语法，不受限制）；provider 视图的 `also:` 行。`via help <命令>` 仍显示被隐藏命令的用法：隐藏是「不主动列出」，不是禁止。
   - provider 语法（`via`、`via <provider> …`）不是内置子命令，不受 `commands` 约束；工具与 server 的限制仍用 `deny` 与 `disabled`。

3. **被禁止时**：在加载其余配置、连接任何 server、启动沙箱之前拒绝，退出码 5（与 `deny` 命中同一类「被拒绝」），`error: via serve is turned off in the via config (commands.deny)` 或 `… is not among the commands the via config allows (commands.allow)`，`next: via help`。`via <命令> -h` 与 `via help <命令>` 同样拒绝。别处的 `next:` 提示指向一条被禁止的命令时，这行 `next:` 不输出。

4. **合并**：`deny`、`hide` 各层取并集；`allow`、`show` 取交集。项目配置因此只能收窄（与 `deny` 相同），不需要 `via trust`。

5. **写错的名字**：`deny`、`hide` 里不认识的名字是 error 级诊断（`unknown-command`）：它本意是拿走一条命令，静默忽略会让那条命令照常可用，与无效的 `deny` 正则同样失败关闭，除 `via doctor`、`via servers`、`via help` 外的命令都停下（退出码 2）。`allow`、`show`、`sandbox.exclude` 里的不认识的名字只告警：忽略它只会让限制更紧。

6. **内部入口**：`daemon run` 是 via 拉起自己的 daemon 的方式，不受 `commands` 约束；`deny: [daemon]` 禁止的是 `status`、`stop`、`logs`。

7. **读取时机**：`commands` 与 `sandbox`（[ADR 0027](0027-run-via-inside-a-sandbox-program.md)）要在分发之前知道，每条命令（包括 `-h`）都要读。为了不伤冷启动：先只读用户配置与项目配置的文本，两份里都没有出现 `commands` 或 `sandbox` 这两个词就到此为止，不加载 YAML 库；出现了才解析这两个字段（走同一个解析缓存）。匹配故意宽松，误判只多一次解析，漏判则会让本该拒绝的命令运行。`via doctor` 的 `commands` 一行列出生效的限制。

## 备选方案

- **按命令写一个映射**（`commands: { serve: deny, daemon: hidden }`）：表达不了「只允许这些」，要再加一个默认值键；四个列表与「禁止 / 只允许 / 隐藏 / 只显示」一一对应，更直接。
- **支持两级名字**（`daemon stop`、`auth login`）：有用，但帮助里这些命令只有一行用法，隐藏其中一个子动作要改写用法文字。先只支持一级，以后可以加。
- **把 provider 语法也纳入**（例如用一个伪名字 `providers`）：工具层面已有 `deny`、`disabled`，两套规则管同一件事容易互相矛盾。
- **只在 agent 框架的权限设置里拦**（如 Claude Code 的 `Bash(via serve:*)`）：仍然推荐，那才是不可绕过的拦截；但它不管「显示」，各框架写法也不同。

## 后果

- 用户能按自己的需要收窄 via 的命令面与它占的上下文，不改动框架配置。
- 和 `deny` 一样，**这是 via 一侧的约定，不是安全边界**：与用户同权限的 agent 可以改配置文件、绕过 via 直接做同样的事。需要不可绕过的限制时，在 agent 框架的权限设置里禁止相应的命令，或把配置文件放在 agent 写不到的地方（开启 [ADR 0027](0027-run-via-inside-a-sandbox-program.md) 的沙箱时，via 的配置目录在沙箱里不可写）。
- 每条命令多读一次（最多两份）配置文件的文本；没有用到这两个字段时不解析。
