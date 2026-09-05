# @breatic/ingest — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩。

## 角色
**部署在 Cloudflare 的 ingest Worker**。浏览器把文件字节直接发给它，它写进 R2、算出内容 hash、把结果报告给 server。**它是这个仓库里唯一不跑在 Node 上的包**——运行时是 workerd，没有 `node:*`、没有数据库、没有 Redis。

## 分层(包内)
- `src/index.ts` = fetch handler，三个端点的路由 + CORS
- `src/upload-session.ts` = Durable Object，一次上传一个实例。它持有这次上传的状态（uploadId、票据、收到了哪些片、报告投没投出去）。**字节不经过它，两个方向都不经过**——DO 按墙钟时长 × 固定 128 MB 计费，等慢网络的那段时间按这个价收，把几个 G 的对象读回来算哈希同理；`index.ts` 收字节、调 R2、拼装、算哈希，只把 `(partNumber, etag, sizeBytes)` 和 `(sizeBytes, sha256)` 这两组小 JSON 报给它。**它不按时间判上传的死活**：只有成功和出错两个出口，寿命归 `TaskTimer`。**时间只决定它什么时候松手**：开传时按票据签的 `bookkeepingTtlSeconds`（= 任务时限 × 2）设一个地平线，到点还没收尾就 `deleteAll()`——DO 存储在被删之前一直计费，而没人收尾的上传永远走不到那个让实例被回收的步骤
- `src/stored-object.ts` = Worker 这一侧对 R2 上那个对象做的两件事：拼装、算哈希
- `src/part-layout.ts` = 一片合不合票据签的布局。Worker 写 R2 之前判一次（唯一拦得住字节的时刻），DO 记账之前判一次（「片数齐了吗」靠数行数回答，那要求每个非末片正好一片长）
- 本包内部用 `@ingest/*` 前缀

## 可 import 谁
- ✅ `@breatic/shared`（**只有它**——ticket 的签名验证在那儿，而 shared 是唯一零 `node:*` 依赖的包）
- ❌ `@breatic/core` / `@breatic/domain` —— 它们用 node API，workerd 加载不了
- ❌ `@server` / `@worker` / `@collab` / `@web` —— 服务之间互不 import

## 怎么拿配置
经 fetch handler 的 `env` 参数（wrangler 的 bindings 和 vars），**不读 `process.env`**——workerd 没有它。

**配置文件不进仓库，进仓库的是它的模板**（user 2026-08-31 拍定）：`wrangler.toml.template` 和 `.dev.vars.template` 进，`wrangler.toml` 和 `.dev.vars` 不进（`.gitignore` 挡住）。拿到代码的人各自复制一份、去掉 `.template` 后缀、把值改成自己的。模板里的值是占位说明，不是任何人的真实取值——**wrangler 不做 `${VAR}` 插值**（实测 4.127.1，`[vars]` 里的 `${X}` 原样当字面量），所以占位符只是给人读的。

**一个变量只在一个文件里定义，没有覆盖**：`wrangler.toml` 装非密钥（桶名、两个地址），`.dev.vars` 只装 `INGEST_SHARED_SECRET`，两边没有同名的东西。环境的差别只是同一组变量的不同取值——顶层给 `wrangler dev`，`[env.production]` 给部署。

**缺配置要说出缺的是哪一个**：`fetch` 入口第一件事查三个必填项，缺了答 500 并列出名字，空字符串也算缺。

部署走 `pnpm deploy:worker`（带 `--env production`）。顶层的 `name` 跟生产那个不同名，漏掉这个 flag 不会盖到线上 Worker。名字带后缀是因为 `deploy` 是 pnpm 自己的子命令（本仓的 `Dockerfile` 正在用它打三个服务的产物），同名的 script 会被它遮住、一行都不执行。

细节见 [README.md](./README.md)。

## 关键路径
它站在上传链路上，而上传是**用户看得见的**。三个端点的每一次拒绝都要有明确状态码：ticket 验不过 401，分片长度不合 400，上传已结束再来 409。

## 测试
跑在真 workerd 里（`@cloudflare/vitest-pool-workers`）。Durable Object 的跨请求状态、R2 的多段上传、`crypto.DigestStream` 都没有 Node 等价物可以替身，**替身在这里等于替身我们对平台行为的猜测**。

**测试自己声明 bindings 和 compatibility date**（`vitest.config.ts`），不读 `wrangler.toml`——那个文件不进仓库，读它的测试就只在恰好有一份的机器上跑得起来。实测：把 `wrangler.toml` 移走，34 条照样绿。

`compatibility_date` 钉在测试运行时支持的日期上——定得比它晚，部署用的是测试从没跑过的运行时标志。升级时两者一起动。
