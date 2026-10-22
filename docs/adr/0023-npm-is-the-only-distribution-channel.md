# 0023. npm 是唯一的分发渠道

- 状态：已接受
- 日期：2026-10-22
- 取代：[ADR 0004](0004-typescript.md) 里「另提供单文件可执行版本」这一条，以及实现说明里 0.3 起的单文件可执行与 Homebrew 两节。ADR 0004 的其余部分（TypeScript、Node.js 20+、官方 SDK）仍然有效。

## 背景

0.3 起 via 同时有两条分发路径：

- npm 包 `@modelctx-ai/via`（`npm install -g`），需要 Node.js 20+。
- 用 `bun build --compile` 从 `src/` 编译的单文件可执行（`npm run build:bin`），随 `v*` 标签上传到 GitHub Release，每个平台一个文件，65–95 MiB，另带 `SHA256SUMS`。0.4 的开发中又加了一份 Homebrew formula，装 npm 包加 Homebrew 的 `node`，推送到 tap 仓库要手工做。

第二条路径一直没有做完：macOS 产物没有公证，Windows 没有签名，Intel macOS、Windows 与 musl 的产物只构建、没有在目标机器上跑过，「单文件是否成为默认安装方式」一直挂在[待定问题](../open-questions.md)里。同时它有持续的成本：发布流程要在七个目标上构建、在其中几个上跑冒烟测试；CI 要装固定版本的 Bun；`src/` 里有识别 Bun 编译产物的分支（`isCompiledBinary()`）；钥匙串模块要按目标平台另外取；`.env` 与 `bunfig.toml` 的自动加载要专门关闭。Homebrew 一侧还多出一个要手工维护的 tap 仓库和一份从没在真实 Homebrew 上运行过的 formula。

维护者决定：分发只走 npm。

## 决策

- **via 只通过 npm（`@modelctx-ai/via`）分发。** 不提供 Homebrew formula，不在 GitHub Release 里放单文件可执行，不做代码签名与公证。需要免装 Node 的环境（容器、CI 镜像）自己装 Node 再用 npm。
- **`release.yml` 只剩两件事**：`v*` 标签上先测试再 `npm publish`（OIDC trusted publisher，行为不变），成功后建 GitHub Release，发布说明由 GitHub 自动生成，不附文件。去掉手动触发（它只用来重做单文件产物）。
- **`build:bin` 整个删除，不保留「自行构建、不受支持」的版本。** 删除 `scripts/build-bin.ts`、`scripts/lib/bin-targets.ts`、`test/cli/bin.test.ts`、`test/bin-targets.test.ts`、CI 的 `binary` 任务、`npm run build:bin`，以及 `src/runtime.ts` 里识别 Bun 编译产物的分支。理由：
  - 保留的构建路径只能靠测试保证它还能用，而那组测试需要 Bun、要真的编译出 70 MiB 以上的产物，只能放在 CI 里跑；没有任何发布依赖它之后，这个任务就是纯维护成本，不删迟早会悄悄失效。
  - 「不受支持」的构建会变成事实上的支持：有人会拿它去装机器，出了问题（Gatekeeper、钥匙串、交叉编译的 `.node` 文件）还是要回答。
  - 需要的人可以从 0.3.1 及之前的标签里取出脚本，实测数据（[perf-0.1](../../bench/results/perf-0.1.md)、[perf-0.3](../../bench/results/perf-0.3.md)）作为历史记录留在 `bench/results/`。
- **删除 Homebrew 相关的全部内容**：`packaging/homebrew/`、`scripts/render-homebrew.mjs`、`test/packaging/homebrew.test.ts`、`homebrew` 任务，以及文档里的安装说明。它们没有随任何版本发布过。
- **`npm run bench:perf` 去掉 Bun 一节**（第 6 节，`--only-bun`、`--skip-bun`）和第 5 节里的单文件行，因为它们靠 `build:bin` 的产物。`src/proxy.ts` 与 `src/cli/main.ts` 里对「在 Bun 下运行 `dist/via.js`」的判断保留：那是普通脚本，与编译产物无关，不增加维护。
- 路线图 c1 标为「已实现，后已移除」，d4 按决定结案；[待定问题](../open-questions.md)里「运行时与分发」一条移除（结论：Node.js 20+，npm 分发）。

## 备选方案

- **继续发单文件，补全签名与公证。** 需要 Apple 开发者账号、Windows 证书和各目标平台的机器来验证，对一个维护者的项目来说成本远高于「多装一个 Node」；冷启动更快（`--version` 约 20 对 66 ms）的收益只在没有 Node 的环境里才有意义，而这些环境本来就能装 Node。
- **只发 Homebrew formula。** 它装的是同一个 npm 包，只多了一个手工维护的 tap 和对 Homebrew 的 `node` 版本的依赖，没有带来 npm 之外的能力。
- **保留 `build:bin` 作为不受支持的自行构建。** 见上，没有选。
- **只删发布路径，保留 `build:bin`、测试与 CI 任务。** CI 任务与测试正是主要的维护成本，保留等于什么都没省。

## 后果

- 安装说明只有一种：`npm install -g @modelctx-ai/via`，需要 Node.js 20+。README、快速上手、测试与实现说明同步修改。
- 此前随 Release 上传的单文件不再更新，也不再有校验和文件；已有的附件不主动删除，新的版本不会再带。想继续用旧版单文件的人会停在 0.3.x。
- 冷启动指标按 Node 的数字衡量（规范里的目标行不再写「单文件」）。启动速度仍是核心指标，靠分块与懒加载、编译缓存和 daemon 保证（[实现说明](../development/implementation.md#启动速度)）。
- CI 少了两个目标平台上的 Bun 构建，`release.yml` 少了七个目标的矩阵；不再需要 Bun 版本的固定与升级。
- 如果以后要重新提供免装 Node 的形态，需要新的 ADR：到那时优先考虑 Node 官方的单可执行应用（SEA）或自带 Node 的安装包，而不是回到这次删除的 Bun 构建。
