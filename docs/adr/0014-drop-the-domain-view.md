# 0014. 去掉「域」：provider 按名字列出，不做分类

- 状态：已接受
- 日期：2026-10-21

## 背景

域（domain）是 0.1 引入的浏览分组：把 provider 归到 `code`、`search`、`docs` 这样的分类里，`via` 顶层按域分组、`via find --domain` 在域内搜索、`via servers --why` 解释判定依据。归类靠三层：配置里的 `servers.<name>.domain` 与顶层 `domains`、内置分类表（`data/domains.json`）、确定性启发式打分（词典 `data/domain-lexicon.json` 加阈值）。

这套东西的维护成本不小：分类表、词典、离线生成脚本、打分参数、按资源拆分、缓存里的域判定、命中说明，以及一整节规范。而它换来的只是浏览时的分组。

更关键的是，它把 via 的推断结果摆到了用户和 agent 面前。模型本来就知道 `github` 是代码托管、`linear` 是项目管理；域是在替它猜，猜错了（`codegraph` 落在 `other`）就得靠 `--why` 和配置覆盖去修，而这些信息它根本不需要。`via prompt` 把域摘要塞进 AGENTS.md 之后这个问题变得刺眼：一行按域分组的说明曾经因为一个 server 的资源数被撑到 2.6 KB，而 agent 想要的只是「有哪些 server」。

## 决策

- provider 就是配置里的 server，按名字列出，不分类。
- `via` 顶层：每个 provider 一行，第二列是可见工具数或状态（`needs auth`、`failed`、`untrusted`），按名字排序。
- 删除：`servers.<name>.domain`、顶层 `domains`、`via servers --why`、`via find --domain`、`data/domains.json`、`data/domain-lexicon.json` 及其 schema、`scripts/build-lexicon.ts` 与 `npm run lexicon`、启发表与词典的代码、预构建缓存快照里的域字段。
- 用户配置里仍写着 `domain:` / `domains:` 时给出 `removed-field` 告警，指明字段已移除、可以删掉，而不是只说「unknown field」。
- 停用词（原 `data/domains.json` 的 `heuristic.stopwords`）保留下来，`via find` 建索引要用：移到 `data/stopwords.json`。
- [ADR 0006](0006-domain-is-a-view.md)（域只是浏览视图）由本 ADR 取代；它当时担心的问题——分类写进命令路径会不稳定——本 ADR 用「干脆不分类」解决。

## 备选方案

- **保留域，只从 `via prompt` 里去掉**：agent 侧的噪音没了，但分类表、词典、脚本、缓存字段和规范依旧要维护，而它们唯一的作用是给一个不需要分类的人看。
- **把域的推断交给模型**：`via` 的输出要经过一次模型调用才能分组，违背「发现不调用模型」这条原则，还多一次延迟和不确定性。
- **只保留配置里的显式域，删掉启发式**：手工给每个 server 配分类，比不分类更麻烦，且同样要维护视图规则。
- **改成按工具数排序的分组（按字母区间切）**：仍然是一个用户没要求、也不会去读的分组层；名字排序已经足够找到目标。

## 后果

- 少一个概念、一张分类表、一个生成脚本、一整套打分参数：`src/catalog/domain.ts`（359 行）与 `lexicon.ts`（90 行）、`test/catalog/domain.test.ts`（149 行）删除，`data/` 少了 324 行数据，其余文件各减几行；配置也短了。
- 没有分类可覆盖，也就没有「分类错了怎么办」：视图不再可能误导，agent 看到的就是真实的 server 名。
- `via` 在 provider 很多时不再分组。代价由三件事补偿：按名字排序、每行带工具数、`via find` 跨 provider 搜索；真要看某个方向的工具，`find` 比扫分组更准。
- `via prompt` 的 provider 列表因此天然有界：它只随 provider 数量增长，与 server 内部的资源规模无关。
- 破坏性：已有配置里的 `domain:` / `domains:` 会被忽略并告警；`via find --domain`、`via servers --why` 变为用法错误（退出码 2）。0.0.0 阶段的破坏性变更，写进 CHANGELOG。
