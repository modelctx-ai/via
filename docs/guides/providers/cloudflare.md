# Cloudflare

Cloudflare 的代码模式 MCP server 只有 4 个工具：`search` 在 OpenAPI 规范里找接口，`execute` 执行调用 Cloudflare API 的 JavaScript，`docs` 搜文档，`whoami` 查当前身份。全部是叶子工具。

via 在这里的价值不是发现，而是让代码可以直接从文件或 heredoc 传入，不用转义进 JSON。

## 接入

```yaml
servers:
  cloudflare:
    url: <Cloudflare MCP 端点>
    auth: oauth            # 然后执行 via auth login cloudflare
```

## 浏览

```console
$ via cloudflare
tools: search · execute · docs · whoami
```

## 调用

```bash
via cloudflare whoami
via cloudflare docs "D1 batch size limit"

# 先查接口，再执行；--code 的值从文件或 stdin 读
via cloudflare search --code @find-workers-endpoints.js
via cloudflare execute --account-id 0123abcd --code - <<'JS'
async () => {
  const r = await cloudflare.request({ method: "GET", path: `/accounts/${accountId}/workers/scripts` });
  return r.result.map(s => s.id);
}
JS
```

Cloudflare 另有按产品划分的细粒度 server，它们和 Linear 一样走普通拆分规则。

来源：实际连接的 Cloudflare MCP server 的 `tools/list`（2026-10）。
