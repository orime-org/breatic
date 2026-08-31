# @breatic/ingest — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩。

## 角色
**部署在 Cloudflare 的 ingest Worker**。浏览器把文件字节直接发给它，它写进 R2、算出内容 hash、把结果报告给 server。**它是这个仓库里唯一不跑在 Node 上的包**——运行时是 workerd，没有 `node:*`、没有数据库、没有 Redis。

## 分层(包内)
- `src/index.ts` = fetch handler，三个端点的路由 + CORS
- `src/upload-session.ts` = Durable Object，一次上传一个实例，记账 + 闹钟
- 本包内部用 `@ingest/*` 前缀

## 可 import 谁
- ✅ `@breatic/shared`（**只有它**——ticket 的签名验证在那儿，而 shared 是唯一零 `node:*` 依赖的包）
- ❌ `@breatic/core` / `@breatic/domain` —— 它们用 node API，workerd 加载不了
- ❌ `@server` / `@worker` / `@collab` / `@web` —— 服务之间互不 import

## 怎么拿配置
经 fetch handler 的 `env` 参数（wrangler 的 bindings 和 vars），**不读 `process.env`**——workerd 没有它。

配置分两层：`wrangler.toml` 进仓库，装结构（binding 名、DO 类名、`migrations`、`compatibility_date`）和生产环境的值；`.dev.vars` 不进仓库，装密钥和本地要覆盖的那几行，`wrangler dev` 读它并盖过 `wrangler.toml` 的 `[vars]`。`.dev.vars.example` 进仓库，记的是那个文件可以放什么。密钥在线上走 `wrangler secret put`。

部署走 `pnpm deploy`（带 `--env production`）。顶层的 `name` 跟生产那个不同名，漏掉这个 flag 不会盖到线上 Worker。

## 关键路径
它站在上传链路上，而上传是**用户看得见的**。三个端点的每一次拒绝都要有明确状态码：ticket 验不过 401，分片长度不合 400，上传已结束再来 409。

## 测试
跑在真 workerd 里（`@cloudflare/vitest-pool-workers`）。Durable Object 的跨请求状态、R2 的多段上传、`crypto.DigestStream` 都没有 Node 等价物可以替身，**替身在这里等于替身我们对平台行为的猜测**。

`compatibility_date` 钉在测试运行时支持的日期上——定得比它晚，部署用的是测试从没跑过的运行时标志。升级时两者一起动。
