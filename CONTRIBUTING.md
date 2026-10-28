# 参与贡献

via 当前版本是 0.4.0（路线图 0.1–0.3）。现在最有价值的贡献是：在真实的 MCP server 和 agent 框架上试用并报告问题、补充真实 server 的拆分案例、指出设计里的漏洞、推进[路线图](docs/roadmap.md)与[待定问题](docs/open-questions.md)。

本地开发：`npm ci` 安装依赖，`npm run typecheck`、`npm test`、`npm run build` 是提交前要跑的检查（CI 同样运行这三项）。

## 文档如何组织

| 目录 | 作用 | 修改门槛 |
| --- | --- | --- |
| `docs/overview/` | 愿景、架构、术语 | 讨论后修改 |
| `docs/spec/` | 规范：实现必须遵循 | 改动需说明理由，影响用户可见行为时更新 CHANGELOG |
| `docs/guides/` | 使用指南、provider 示例、组合用法 | 随时补充 |
| `docs/development/` | 实现说明、测试、数据文件格式 | 随实现演进 |
| `docs/adr/` | 架构决策记录 | 只追加，不改写已接受的结论 |

完整索引与写作约定见 [docs/README.md](docs/README.md)。

## 改动流程

1. **小的澄清或补充**：直接提 PR。
2. **改变用户可见行为**（命令语法、输出格式、退出码、配置字段）：在 PR 描述里说明动机和影响，同步更新 `docs/spec/` 与 `CHANGELOG.md`。
3. **推翻或替换已有决策**：先开 issue 讨论，结论写成新的 ADR，旧 ADR 状态改为「被 ADR-xxxx 取代」。

## 写作约定

- 文档使用中文；命令、参数、字段名、代码保持英文原样并用反引号包裹。
- 例外：根目录的 `README.md` 用英文（GitHub 与 npm 默认展示它），`README.zh-CN.md` 是中文版；改动其中一份时同步另一份。
- 规范性文档使用以下措辞，含义固定：
  - **必须 / 不得**：硬性要求，违反即为缺陷。
  - **应当 / 不应**：默认要求，偏离时需要在代码或文档中说明理由。
  - **可以**：可选行为。
- 示例里的输出以「意图」为准，具体列宽、措辞以快照测试为准。
- 引用真实 MCP server 的工具名时注明来源与时间，因为上游会改名。

## 提交信息

建议使用 [Conventional Commits](https://www.conventionalcommits.org/)：`docs(spec): …`、`feat(catalog): …`、`fix(render): …`。

## 许可

提交的贡献以 [Apache License 2.0](LICENSE) 授权。
