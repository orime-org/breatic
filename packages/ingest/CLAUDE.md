# @breatic/ingest — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩。

## 角色
**部署在 Cloudflare 的 ingest Worker**。浏览器把文件字节直接发给它，它写进 R2、算出内容 hash，**把算出来的东西放在收尾那次请求的响应里答回去**。**它不主动请求任何地址，也不持有我们任何一个端点的地址**（#206）——收尾由我们自己的 server 发起，所以它答给谁、后果落在哪，全由发起方决定。**它是这个仓库里唯一跑在 workerd 上的包**——运行时是 workerd，没有 `node:*`、没有数据库、没有 Redis。

## 分层(包内)
- `src/index.ts` = fetch handler，四个端点的路由 + CORS
- **本包零 Durable Object，零常驻状态**。一次上传要记住的两样东西（R2 的 `uploadId`、每片的 etag）由发起方持有、每次请求带回来，跟 Cloudflare 自己的多段上传示例一致（「the state of the multipart upload is tracked in the client application which sends requests to the Worker」）。判上传死活的也不在这儿：任务行的时限由 server 在有人读节点任务列表时算（#186 设计 §4.6）
- `src/stored-object.ts` = Worker 对 R2 上那个对象做的两件事：拼装、算哈希
- `src/part-layout.ts` = 一片合不合票据签的布局。写 R2 之前判一次（唯一拦得住字节的时刻），收尾时对交回的清单逐项再判一次，然后数片数够不够
- 本包内部用 `@ingest/*` 前缀

## 可 import 谁
- ✅ `@breatic/shared`（**只有它**——ticket 和每片重签一次的会话令牌，签名和验签都在 `shared/src/upload/`，而 shared 是唯一零 `node:*` 依赖的包）。**令牌住在那儿是因为两端都要读它**：Worker 验它才收分片（`index.ts`），我们的 server 验它才知道这次收尾说的是哪个 key（`assets.ts` 的 `/complete`）。签名格式搬进本包，server 就够不到它，两边会各写一份然后互相拒绝
- ❌ `@breatic/core` / `@breatic/domain` —— 它们用 node API，workerd 加载不了
- ❌ `@server` / `@worker` / `@collab` / `@web` —— 服务之间互不 import

## 怎么拿配置
经 fetch handler 的 `env` 参数（wrangler 的 bindings 和 vars），**不读 `process.env`**——workerd 没有它。

**谁需要配它**：改这个 Worker 本身的人，以及要在自己机器上把一次上传从头走到尾的人。其余情形不用配也不用跑——编译、单测、集成测试都不碰它，浏览器指向已部署的环境时字节直接进线上 Worker。

**要在本地跑一次完整上传，Worker 就必须也在本地跑**：本机的浏览器发分片、本机的 server 发收尾，两者都按仓库根 `.env` 的 `INGEST_BASE_URL` 找它，而那是本机的一个端口。**「部署在 Cloudflare 的 Worker 够不到 localhost」这条理由已经不成立**（#206 之前它要回拨我们的 server，现在它谁都不请求），今天挡住线上那个的是 `ALLOWED_ORIGINS`——里面没有你的本地地址，而且它写的是线上那个桶。

**配置文件不进仓库，进仓库的是它的模板**（user 2026-08-31 拍定）：`wrangler.toml.template` 和 `.dev.vars.template` 进，`wrangler.toml` 和 `.dev.vars` 不进（`.gitignore` 挡住）。需要配的人各自复制一份、去掉 `.template` 后缀、把值改成自己的。模板里的值是占位说明，不是任何人的真实取值——**wrangler 不做 `${VAR}` 插值**（实测 4.127.1，`[vars]` 里的 `${X}` 原样当字面量），所以占位符只是给人读的。

**一个变量只在一个文件里定义，没有覆盖**：`wrangler.toml` 装非密钥（桶名、允许的来源），`.dev.vars` 只装 `INGEST_SHARED_SECRET`，两边没有同名的东西。**这里不配我们任何一个端点的地址**——Worker 不请求它们。环境的差别只是同一组变量的不同取值——顶层给 `wrangler dev`，`[env.production]` 给部署。

**缺配置要说出缺的是哪一个**：`fetch` 入口第一件事查三个必填项（`INGEST_SHARED_SECRET` · `ALLOWED_ORIGINS` · `BUCKET` 绑定），缺了答 500 并列出名字，空字符串也算缺。

部署走 `pnpm deploy:worker`（带 `--env production`）。顶层的 `name` 跟生产那个不同名，漏掉这个 flag 不会盖到线上 Worker。名字带后缀是因为 `deploy` 是 pnpm 自己的子命令（本仓的 `Dockerfile` 正在用它打三个服务的产物），同名的 script 会被它遮住、一行都不执行。

细节见 [README.md](./README.md)。

## 关键路径
它站在上传链路上，而上传是**用户看得见的**。四个端点的每一次拒绝都要有明确状态码：ticket 或令牌验不过 401，分片长度不合 400，交回的清单还差片数 409，写 R2 或算 hash 没成 502。**收尾和 `POST /fetch` 都要共享密钥**（不符 401）——浏览器拿不到它，所以这两步只可能由我们自己的服务发起；`POST /fetch` 另有一条：源地址不是 https 400。**「这个 key 有没有人在收尾」不在这儿判**——那道许可在我们的账本上，由发起收尾的 server 在调它之前取（#206）。

## 测试
跑在真 workerd 里（`@cloudflare/vitest-pool-workers`）。R2 的多段上传和 `crypto.DigestStream` 都没有 Node 等价物可以替身，**替身在这里等于替身我们对平台行为的猜测**。

**测试自己声明 bindings 和 compatibility date**（`vitest.config.ts`），不读 `wrangler.toml`——那个文件不进仓库，读它的测试就只在恰好有一份的机器上跑得起来。实测：把 `wrangler.toml` 移走，整套照样绿。

`compatibility_date` 钉在测试运行时支持的日期上——定得比它晚，部署用的是测试从没跑过的运行时标志。升级时两者一起动。
