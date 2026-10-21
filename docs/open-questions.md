# 待定问题

讨论有结论后，把结论写进对应的规范或新的 ADR，并从这里移除。

- [ ] **运行时与分发**：默认要求 Node 22，还是同时以 Bun 单文件可执行为主要分发形式；两者冷启动差异需要实测。
  - 0.1 的实测（[perf-0.1](../bench/results/perf-0.1.md)）：`bun build --compile` 不加标志时单文件可执行（85 MiB）比 Node 22 + 编译缓存还慢（`--version` 约 72–78 对 44 ms，浏览类命令持平）。
  - 0.3 的结论（[perf-0.3](../bench/results/perf-0.3.md)，`npm run build:bin` 已实现）：慢不是体积的问题（77.5 MiB 是 Bun 运行时本身），而是每次启动重新解析整包 JS；`--bytecode` 去掉解析，`--splitting` 保持懒加载，之后单文件是所有形态里最快的（Linux 上 `--version` 约 20 对 66 ms，根视图约 54 对 124 ms，经热 daemon 的整进程调用约 75 对 199 ms）。钥匙串模块、daemon 自重启、stdio、OAuth 回环、`batch` 都在编译产物里验证过；`.env`/`bunfig.toml` 自动加载必须关闭。
  - 还开放的：是否把单文件作为默认推荐的安装方式（体积 65–94 MiB，gzip 约 42 MiB）；是否出 x64 baseline（无 AVX2）、Intel macOS 之外的更多目标；macOS 公证与 Windows 签名；交叉编译产物在目标平台上的实际验证（目前只有 Linux x64 与 CI 的 Linux/macOS 冒烟）；Windows 的 daemon（路线图 c4）。
- [ ] **截断预算默认值**：8 KB 是起点，需要用 token 基准和 agent 评测确定。
- [ ] **拆分规则**：动词表的范围、拆分失败（退回叶子工具）的比例，需要在真实 server 上统计和调整。
- [ ] **按使用频率排序**：`via find` 和资源视图是否参考本地调用记录，把常用工具排前面（mcp2cli 的 `--sort usage` 做法）。这能省 token，但同样的查询在不同机器、不同时间结果不同，与「输出严格」有冲突；需要决定是默认开启、作为同分时的次级排序，还是只作为选项。
- [ ] **`via serve` 模式**：是否让 via 以 MCP server 身份对外暴露少量元工具，服务没有 shell 的 agent。这与网关的角色部分重叠。
- [ ] **框架提示的维护方式**：各框架版本更新较快，`data/frameworks/` 靠社区贡献还是定期人工核对。
- [ ] **并存期的状态冲突**：除 `exclusive` 提示外，是否需要主动检测框架里正在运行的同名 stdio 实例。
- [ ] **文档语言**：是否需要英文版 README 与规范。
