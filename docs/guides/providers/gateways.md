# 网关类 server

mx 不对任何网关做专门适配（[ADR 0007](../../adr/0007-no-gateway-specific-adaptation.md)）。Asterlane 这类网关对 mx 来说就是一个普通的 HTTP MCP server：配好 bearer 凭证即可，它暴露的元工具按通用规则命名、映射参数和渲染输出。

## 接入

```yaml
servers:
  aster:
    url: http://127.0.0.1:3721/mcp
    auth: { bearer: "env:ASTERLANE_KEY" }
```

## 使用

```console
$ mx aster
asl      search · describe · call · batch · fetch
tools:   asl-status

$ mx aster asl:search --query "web search"
$ mx aster asl:call --name search__exa__neural_search --arguments.query "rust mcp"
```

代价是 agent 要做两层发现：先在 mx 里找到网关的元工具，再通过网关的搜索找到上游工具。换来的是 mx 与任何网关零耦合，网关怎么演进都不需要改 mx。

## 什么时候在 mx 之外再加一层网关

以 [Asterlane](https://github.com/komiyoo/asterlane) 为例：

| | 只用 mx | mx + 网关 |
| --- | --- | --- |
| 适用场景 | 个人开发、本地工具 | 团队、多 agent、生产环境 |
| 上游凭证 | 在本机，agent 理论上可读到 | 只在网关，agent 只持有网关 key |
| 权限范围 | 本地 `deny` 规则 | 网关按 key 划分，可吊销，有审计 |
| 本地 stdio server | 支持 | 由 mx 直连，与网关并存 |
