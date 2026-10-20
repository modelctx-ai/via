# 0010. 提供 MCP resources、prompts 与 roots，且不进入工具语法

- 状态：已接受
- 日期：2026-10-20

## 背景

via 到 0.2 只覆盖 MCP 的 tools。但 MCP server 还能提供另外三类东西：

- **resources**：按 URI 寻址的只读内容（文件、数据库行、日志），外加 URI 模板（RFC 6570）；
- **prompts**：server 提供的、带参数的消息模板；
- **roots**：反向的，由 client 声明「server 可以在哪些目录里工作」。filesystem 一类 server 依赖它，不声明就拿不到目录（或只能靠启动参数）。

这个问题在 [open-questions](../open-questions.md) 里挂了一段时间：是只做 tools，还是提供 `via read <uri>`、`via prompts`，以及 roots 是否按 server 配置、默认取当前工作目录。约束是：

- 命令语法是 [ADR 0005](0005-command-grammar-provider-resource-verb.md) 定下的 `via <provider> <resource>:<verb>`，冒号表示「这是一个工具」。URI 本身含冒号（`file:///a.txt`），放进工具语法就会被解析成工具引用。
- 不为任何 server 写专门逻辑（[ADR 0007](0007-no-gateway-specific-adaptation.md)）。
- 每个 agent 的说明文本都要付 token，新增能力不应让 `via prompt` 变长。
- daemon 的会话在不同工作目录的 CLI 之间共享；凭证与结果的脱敏规则不能因新请求而放松。

## 决策

**提供 resources 和 prompts，并且是三个独立的内置子命令，不进工具语法。**

```text
via resources <provider>                    列出资源和资源模板
via read <provider> <uri>                   读取一个资源
via prompts <provider>                      列出提示
via prompts <provider> <name> [--arg 值…]   取一个提示（参数写法同工具）
```

- `resources`、`read`、`prompts` 成为保留字，与之重名的 provider 需要用 `alias` 改名，规则同其他内置子命令。
- 第二个参数是 provider（唯一前缀、大小写、`-`/`_` 宽松），其余照常。URI 是普通的位置参数，不做任何拆分。
- 范围：`resources/list`、`resources/templates/list`、`resources/read`、`prompts/list`、`prompts/get`。订阅（`resources/subscribe`）、补全（`completion/complete`）、sampling、elicitation 不做：它们要么需要长连接，要么需要反向询问用户，与一次一命令的模型不合。
- 输出走现有渲染流水线：文本内容按 text 渲染，二进制 `blob` 落盘只打印路径，超出预算的部分存游标，`via more` 续读；脱敏和元信息行规则不变。没有新的输出格式。
- 浏览视图里只给一行提示。`via <provider>` 在该 server 在 `initialize` 里声明了 `resources` 或 `prompts` 时多一行 `also: via resources <p> · via prompts <p>`。声明随 `tools/list` 一起缓存，不额外连接；缓存里没有这项信息（旧缓存）时不显示，刷新一次后出现。`via prompt` 生成的说明不变，所以不增加 token。
- 不适用 `deny`（它匹配工具引用）、`--yes`、`--dry-run`：这三类请求在协议上都是只读的。要整个隐藏一个 server 用 `disabled`。

**roots 按 server 配置，默认不声明。**

- 配置字段 `servers.<name>.roots`：路径或 `file://` URI 的列表。路径中的 `~` 展开为家目录，相对路径相对于 CLI 的当前目录（与 stdio 的 `cwd` 一致），统一转成 `file://` URI，名字取目录的末段。
- **默认没有**：不写 `roots`（或写 `[]`）时，via 不声明 `roots` 能力，server 不会向 via 要目录。想让 filesystem 一类 server 看到当前目录的人写 `roots: ["."]`。
- 声明时 `listChanged` 为 `false`：一个会话的 roots 在它的一生里不变。需要不同 roots 就是不同的会话。
- daemon 里 roots 参与会话键：CLI 把相对路径按自己的当前目录解成绝对 URI 后再发给 daemon（和 stdio 的 `cwd` 同一处理），所以 `roots: ["."]` 的 server 在两个目录里是两个会话，不会把 A 目录的 roots 交给在 B 目录里工作的 CLI，也就不需要 `notifications/roots/list_changed`。代价与 stdio 的 `cwd` 相同：两个目录交替使用时会话互相替换。
- 项目级配置设置非空的 `roots` 视同改变 server 的访问边界，需要 `via trust`，`via trust` 显示 roots；设为 `[]`（收窄）不需要。
- 给 HTTP server 配 `roots` 时，配置加载给出告警：本地路径会发往远端服务。

## 备选方案

- **只做 tools**：最省事，但 filesystem 和一批文档类 server 的主要能力就在 resources 与 roots 上；agent 无法使用，只能回到框架里挂载，抵消 via 的价值。
- **`via <provider> resources`（provider 之后的保留词）**：与「provider 之后的第一个词是资源或工具」的解析冲突。真实 server 常有 `list_resources` 之类的工具，会拆出名为 `resource` 的资源，保留词会让它们的行为取决于 server 的工具名。内置子命令的名字空间是 via 自己的，不会冲突。
- **把 URI 当工具引用的一种：`via fs file:///a.txt`**：违反 ADR 0005 中冒号的含义。
- **把 resources 和 prompts 合成伪工具（`resource:read`、`prompt:get`）并入目录**：目录、`find`、`deny` 都得区分真假工具，名字还会撞上真正的工具；而且 prompt 的参数是扁平的字符串表，没有必要走工具 schema 的全套。参数解析器仍然复用，见后果。
- **`via prompt` 更名或合并成 `via prompts`**：`prompt` 已发布，且含义不同（给 agent 的说明）。名字相近是代价，见下。
- **roots 默认取当前工作目录**：方便，但默认就把 CLI 所在目录（常含用户名、项目名）告知每一个声明了该能力的 server，而 filesystem 类 server 一旦收到 roots 就会把它们当作可访问范围。daemon 里这个目录还会随调用者变化。默认公开范围应当由用户明确写下。
- **命令行 `--root`**：每次调用的 roots 不同会让会话无法复用，也让「写进 shell 历史的目录」成为授权手段；配置更可审计。

## 后果

- 三个新保留字；`RESERVED_COMMANDS` 与 `ACTIVE_COMMANDS` 同步。`prompt` 与 `prompts` 相近：`via prompt` 带位置参数时报错并提示 `via prompts <provider>`。
- prompt 的参数是 `{name, description, required}` 的列表，转成只有字符串属性的 schema 后复用工具的参数解析器、`-h` 与本地校验，所以 `--name 值`、`@文件`、`-`、唯一必填参数的位置写法都能用。
- 协议新增四个请求，`list` 的结果多一个 `features`（见 [daemon.md](../spec/daemon.md)）。结果在 daemon 里脱敏，凭证仍不经过 socket。
- 没有声明相应能力的 server 收到这些命令时，不发请求，退出码 3，`next:` 指回 `via <provider>`。
- `deny` 管不到 resources 和 prompts，这是边界说明的一部分（[security.md](../spec/security.md#边界说明)）：声明了 resources 的 server 是否暴露敏感内容，由 server 与 roots 的范围决定。
- 订阅、补全和 sampling 仍未支持，需要时另开 ADR。
