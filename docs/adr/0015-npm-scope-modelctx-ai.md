# 0015. npm 包名为 @modelctx-ai/via

- 状态：已接受
- 日期：2026-10-21
- 取代：ADR 0009 里的 npm 包名。命令名、二进制名和路径命名仍以 ADR 0009 为准。

## 背景

ADR 0009 把 npm 包定为 `@modelctx/via`。GitHub 组织是 `modelctx-ai`。2026-10-21 准备发布时，registry 上没有 `@modelctx` 这个 scope（`Scope not found`），`npm publish` 对 `PUT @modelctx/via` 返回 404。同一天创建的 npm 组织是 [modelctx-ai](https://www.npmjs.com/org/modelctx-ai)。

## 决策

- npm 包名是 `@modelctx-ai/via`。
- 命令名和安装后的二进制名仍是 `via`。

## 备选方案

- 继续用 `@modelctx/via`，另建一个叫 `modelctx` 的 npm 组织。GitHub 组织已经是 `modelctx-ai`，两套名字以后会对不齐。
- 用无 scope 的 `via`。npm 上这个名字早年已被占位包占用（ADR 0009）。

## 后果

- 安装命令是 `npm install -g @modelctx-ai/via`。
- 首次发布必须由组织成员在本机执行：包还不存在时，npm 不提供 trusted publisher 的设置页。包出现之后，再把 GitHub Actions 工作流 `release.yml`（仓库 `modelctx-ai/via`）登记为 trusted publisher，并允许 `npm publish`。之后的 `v*` 标签由 `release.yml` 发布。
- 全局安装路径里的目录名从 `@modelctx/via` 变为 `@modelctx-ai/via`。0.3.0 没有发到 npm，没有已安装的用户要迁移。
