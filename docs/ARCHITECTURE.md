# Architecture

breatic monorepo 的完整工程参考,合三份文档于一处:**Backend** 架构(7 package + 3 服务)、**Frontend**(`packages/web`)、以及全栈**函数定义编码规范**。行为 mandate(头号原则 / DD / TDD / 红线 / 判定题)在仓库根 [`CLAUDE.md`](../CLAUDE.md);本文写"怎么做的细节"(技术栈 / 包依赖 / 数据流 / 命名 / 节点模型 / token / 函数注释格式),mandate 指向这里。

- [Backend](#backend) — 技术栈 / 7 package / 3 服务 / 画布协作 / 三层记忆 / SubAgent / Worker / Mini-Tool / Skill / Agent tools / 配置 / 日志
- [Frontend](#frontend) — `packages/web` 技术栈 / 7 层 layered / 节点模型 / 命名规范 / 路由 / 源码布局
- [Coding standards (function definition format)](#coding-standards-function-definition-format) — 函数注释 / 显式返回类型 / 异常类型格式 + CI 强制

## Backend

### Product

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo,7 个 package + 3 个运行时服务。

### Tech stack (backend)

| Layer | Tech |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript 5.x strict |
| Monorepo | pnpm workspaces + Turborepo |
| HTTP | Hono |
| ORM | Drizzle ORM |
| DB | PostgreSQL (postgres.js driver) |
| Cache / Queue / PubSub | Redis (ioredis) + BullMQ |
| AI | Vercel AI SDK |
| Realtime collab | Hocuspocus 4.5.0 (Yjs server) |
| Validation | Zod |
| Test | Vitest |
| Logging | pino (main-thread `multistream`) |

Frontend stack: see [Tech stack (frontend)](#tech-stack-frontend).

### 7 packages

```
packages/
├── shared/   # Zod schema + 类型 + 常量 (零依赖)
├── core/     # 后端共享内核 barrel (@breatic/core) — 纯地基,零 AIGC 业务
│              auth/(共享鉴权内核:projectMembers.repo + projectAuth.service〔loadProjectRole〕,collab+server 共用) ·
│              db/(schema.ts 25 表) · i18n/(node 适配器 loadLocales/runWithLocale) · infra/(redis/pubsub/queue/storage/session-store/control-events) · config/
├── domain/   # server+worker 共享 AIGC 业务内核 (@breatic/domain,collab 永不碰) — credit · task(含 markCompletedAndBill 任务·积分跨表原子扣费)· node-history · agent(loader/skills/tools/llm)· model-catalog · canvas-lock(PR4 自 core 迁入,各域 *.repo/*.service 功能文件夹)
├── server/   # HTTP 壳 (Hono): routes/(auth/chat/canvas/mini-tools/projects/members/project-invitations/notifications/skills/tasks/payment/activities〔project 活动流读取〕/assets〔上传握手 + 删除上报〕) + middleware/(路由层=接线员,不写业务;`rateLimitFor` 限流走 `config/rate-limits.yaml`) + modules/(server 私有领域,**按域分功能文件夹**,每域 service+repo+test:auth〔含 user.repo + recovery-code〕/activity〔活动流写入 + 读取〕/conversation/memory/notification/payment/project〔含 projectMembers〕/project-invite〔含 project-invite-mail〕/role-upgrade-request/studio/skill/text-tool/yjs-doc,barrel index.ts re-export) + infra/(stripe/mailer) + config/(pricing/text-tools/limits/rate-limits;**运行参数一律 yaml、禁硬编码,见 [CONFIGURATION.md](./CONFIGURATION.md)**)(healthz 走独立 :3001 进程,见 DEPLOY.md)
├── worker/   # BullMQ 壳: handlers/(dispatch.ts=5 路分发 + local/{runtime,video} 本地 ffmpeg 执行) + providers/(image/video/audio/tts/three-d/understand) + 根(index 入口 / mini-tool-registry / bootstrap-config)
├── collab/   # Hocuspocus 独立进程: hooks/(auth/meta-write-attempt-log/presence/awareness-identity/presence-wiring) + services/(persistence/event-stream/space-rpc/task-listener/members-sync/handling-sweeper/lazy-seed/lifecycle-listener/connection-registry/connection-tracking/space-delete-lock/yjs-documents.repo) + infra/(health-checks · connection-gate〔连接准入:升级阶段从原始对端地址裁决,回环豁免、非回环取 nginx 的 x-real-ip 否则 403;裁决本身随请求头传下去〕 · client-identity〔上面那条规则的纯判定〕 · socket-ceilings〔库里几个「超了就关整条 socket」的上限,从一个声明数推导〕) + 根(index/hocuspocus 装配/config)
└── web/      # React app — see the [Frontend](#frontend) part
config/ agents/ skills/ locales/ (git-tracked); uploads/ + sandbox/ (git-ignored; sandbox/ = agent file-tool sandbox root)
```

**包依赖方向:** `shared(零依赖,前后端共用) ← core(后端共享内核) ← {domain, collab}`;`domain(server+worker 共享 AIGC 业务) ← server / worker`;前端 `web ← shared` 不依赖 core/server。**二次调整(2026-05-31)新增 `@breatic/domain`**:server+worker 共享、collab 永不碰的 AIGC 业务(积分花 / 任务 / 节点历史 / agent / model-catalog / canvas-lock)单独成包,`lint:dependency-cruiser` 的 `collab-no-domain-import` 规则守卫 collab 不 import domain(**PR4 已自 core 迁入业务**:credit/task/node-history/agent/model-catalog/canvas-lock + 各自 repo;同期 user.repo/stripe/mailer/pricing/text-tools 迁 server,core 回归纯地基)。**严格边界**:server 不 import worker,worker 不 import server;**模块化单体(2026-05-31)+ 二次调整 PR4**:core 只放全后端共享内核(共享鉴权 + infra + schema + 跨服务事件协议;AIGC 业务钱/任务/节点历史/agent 等已迁 `@breatic/domain`),**服务私有领域逻辑归各自服务**(server 私有业务在 `server/src/modules`,经三层边界:路由层=接线员 → 业务 service 层 → core 共享内核;`lint:dependency-cruiser` 的 `library-no-app-import` 规则守卫 core/shared 不反向 import 服务包)。collab 历史上独立部署"不依赖 core",2026-05-27 PR `feat/2026-05-27-collab-infra-resilience` 修订为依赖 core infrastructure(`createRedisClient` / 日志 / 配置),production-safety 配置不再 raw 实例化漂离。**二次调整(2026-05-31)重定义**:鉴权 / 会话 / 成员事件这类**全后端(含 collab)必须一致**的逻辑属 core 共享内核,collab 用 core 的统一鉴权;**鉴权已统一(PR2 #179)**:collab `hooks/auth.ts` 调 core 的 `getSession` + `projectAuthService.loadProjectRole`,跟 server 共用同一套原语,不再手写裸 `redis.get(:session:)` / 裸 SQL `loadProjectRole`。旧「collab 只借 core infra、业务不引入」表述作废 —— 它把鉴权漂移当成了设计。**DB 适配统一(2026-06-02)**:collab 也不再手搓 postgres.js 连接池——`yjs_documents` 的持久化(`persistence`)/ 空间存在性读(`auth`)/ space-rpc 软删·恢复全走 core 的 `yjsDocumentsRepo`(那张共享表的**唯一 repo 家**),经 core 的 `db` 单例(per 进程自动建池,同 server/worker);健康探针走 `pingDb()`、boot 连通性走统一的 core `checkInfraReady(redisClients)`(各服务传自己依赖的 Redis 单例:server/worker `{general,queue,stream}`、collab `{general,stream}`;2026-06-03 收编 collab 旧的 `checkCollabInfraReady` + `checkPgReachable`,collab 也走单例式),`postgres` 直接依赖已从 collab 移除。**全项目 postgres.js 驱动只在 core,Drizzle 是唯一查询适配层**;CI 守卫 `breatic/no-postgres-outside-core`(驱动只许 core)+ `breatic/no-yjs-documents-outside-repo`(一表一 repo)+ `breatic/no-raw-sql-outside-repo`(现扫 collab,本包零裸 SQL)。**Redis 适配同理统一(2026-06-02)**:`ioredis` 驱动也只在 core(工厂 + 单例 + `pingRedis` + re-export `Redis` 类型),collab/domain 删直接依赖、`Redis` 类型从 core 拿;collab 会话查走 `getRedis()` 单例,**但订阅 / 阻塞流 / Hocuspocus pub-sub 等专用连接保持独立**(Redis 协议要求每角色独占 socket,连接数收不了,跟 postgres 单池本质不同);跨服务 stream key `:stream:task-events` 收成 core 的 `taskEventsStreamKey()` 单一来源(消灭 worker 发布侧 + collab 消费侧各造的静默断风险);CI 守卫 `breatic/no-ioredis-outside-core`。

**Package exports:** shared/core 导出 `./dist/index.js`(行业标准),本地和 Docker 统一走编译产物。路径解析通过 `MONOREPO_ROOT`(向上查找 `pnpm-workspace.yaml`)。

### 3 services

| Service | Port | 端口来源 | Responsibility |
|---|---|---|---|
| API | 3000 | `PORT` | HTTP 请求 + Agent 聊天 SSE + Text mini-tool SSE |
| Collab | 1234 | `COLLAB_PORT`(跟另两个服务端口一样在 core env schema;`collab.yaml` 只剩行为参数)| Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点 |
| Worker | — | — | BullMQ 任务执行 → 存 DB → Redis Streams publish NodeEvent → Collab 写 Yjs |

三个 healthz 端口(3001 / 1235 / 9101)同样从 env 读(`SERVER_HEALTH_PORT` / `COLLAB_HEALTH_PORT` / `WORKER_HEALTH_PORT`)。**同一台机器上跑多个 worktree 时这些默认值会互撞**,尤其 BullMQ 队列共享会让一个 worktree 的任务被另一个的 worker 执行 —— 整套偏移方式见 `.env.dev` 顶部的 "Running several worktrees at once"。

### Canvas collaboration

- 节点 create/delete + position 由**前端独占**;后端只能改 `data` 字段(state/content 等)
- 画布走 Yjs,Agent 聊天走 SSE。无锁:每次 mini-tool 操作产生新兄弟节点(edge 连接),不覆盖源节点
- 事件总线:Redis Streams `${env}:stream:canvas-nodes`(`NodeStateUpdateEvent`,支持 `targetNodeIds: string[]` 1:N),Collab 消费后写 Yjs
- 文档命名 v10 multi-doc:`project-{id}/meta`(含 spaces 列表)+ `project-{id}/canvas-{spaceId}`(每个 Canvas Space 一个)
- 节点状态机:`idle` / `handling`(均在 Yjs);`localPending` 是本地 React state;失败 = `idle` + `errorMessage`(无第三态,`deriveStatus` 折出 error)
- **handling 租约善后(#1569 + #1580 加固,2026-07-03)**:`handling` 是写进共享文档的易碎状态,驱动者(浏览器上传 / worker AIGC)可能悄无声息死掉。**善后 = 租约超时是唯一正确性保证,事件只是加速器**(业界收敛:Yjs awareness / BullMQ stalled / SQS visibility timeout);**断线不回收 handling**(#1580 片 4 Option A:presigned 直传对象存储对 collab 不可见且比 WS 活得久,任何连接活性信号都只是上传活性的替身 → **断线不动文档里的任何内容**,handling 靠主人自清 + 清扫器保底;#1889 把断线钩子里最后那点活〔剥 mini-tool 配置锁〕连同那个字段一起删了〔它的生产者早在 2026-05-18 web 重写时就没了〕,所以断线现在只剩把连接从跨实例注册表注销,meta 文档本就不计数、连这个也没有)。`HandlingActor` 带必填 `startedAt`(epoch ms,frontend 时钟由清扫器首次观察盖服务器戳 `serverStamped`)+ **必填 `gen`**;统一预算 `HANDLING_TIMEOUT_MS`=1h(shared 单一来源),排队/执行两阶段各自预算窗(`phase` + `renewLease` 续期)。**统一 gen fencing(#1580 #7)**:节点带永久只增计数器 `data.leaseGen`,每次开 handling(上传 / AIGC)领 `gen = leaseGen + 1` 写进 `handlingBy`(前端另带主人三件套 `gen+userId+clientId`,写回验主人 = 节点最终内容属于最终租约主人);AIGC 的 gen 由前端经 `POST /canvas/tasks` 的 `node_gens`(int32 上界)进 job,worker 每次写回(done / failed / renew / 崩溃网)回传,collab 单写者 CAS(开事件 `gen >= leaseGen` 才应用并推进计数器;关/续事件 `gen === 在飞 handlingBy.gen` 才应用,陈旧写回永久丢弃留日志)。**worker 重试协议**:失败 CLOSE 只在**终态** attempt 发(`isTerminalAttempt`,非终态发 CLOSE 会自围栏重试的同 gen 写回 = 扣钱不到货);overwrite 锁跨 attempt 用 `reacquireCanvasNodeLock` 续持;计费后崩溃的重投递补发 done(幂等 + gen 兜);**计费临界区前有僵尸围栏**(`verifyJobLockOwnership`:复活的 stalled 执行用 `job.extendLock(token)` 原子验活,0 = 已被判死,静默退出不碰钱不写任何状态)。**collab 清扫器**(`services/handling-sweeper.ts`)在 `afterLoadDocument`(jitter 500ms~3s 错峰防重启惊群)+ 5min 周期扫(直接 doc 引用、**不走 openDirectConnection**)把超预算 / 无 `handlingBy` 的 handling 节点打回 `idle + errorMessage:'Operation timed out'`,顺带自愈 idle 节点上的 CRDT 残留 handlingBy;写入带 origin `handling-lease-sweep` 只为给读日志的人指名写者,**它不是清扫不进用户撤销栈的原因** —— 事务 origin 从不过网线,画布 UndoManager 跟的是一个只含本地 Symbol 的白名单,服务端的字符串永远进不去。**worker 静默死兜底**:core `createQueueEvents` 的跨进程 `QueueEvents.on('failed')` 对**终态**失败(`job.finishedOn`)发失败事件(带 gen,双发由 CAS 天然去重)。**积分预检**:所有入队路由(`/canvas/tasks` / `/canvas/understand` / `/mini-tools/*`)共用 `precheckCredits`(余额 ≥ `estimateTaskCredits` 的 `cost_per_call` 估价,**不锁积分**软预检),worker 完成时按真实用量原子扣;overwrite 的开-handling 事件发布是**硬前提**(失败即 markFailed + 放锁 + 503,不 best-effort)。**成功写回清 errorMessage**(`errorMessage:null`)。**前后端分界**:租约解耦「可靠性」与「执行位置」→ 碰钱/密钥/重算力归后端,浏览器干得动的纯媒体变换可前端,两边 handling 同走租约善后;UI 有 busy 闸(handling 中拒绝二次上传/发起)
- **存储层:studio 内去重 + 下发记录防伪 + 只插不删(#1826,2026-07-26)** —— 四条铁律见 [CLAUDE.md](../CLAUDE.md#关键规范) 的「存储」条,这里是机制。**三张表**:`studio_assets`(资产账本,`(studio_id, content_hash)` 部分唯一 = 去重键 + 幂等锚,另有 `storage_key` 部分索引供反查)· `upload_grants`(**下发记录**,presign 每铸一个 key 写一行:user + 服务端解析的 owner studio + 声明的 hash + key)· `storage_reclaim_queue`(**待回收清单**,去重命中时把多出来的那份登记进来交离线处理)。**key 租户中立**(`{taskType}/{date}/{时间戳}_{uuid}{ext}`,不含 user/project 前缀,hash 不进 URL),归属判定因此从「看 key 前缀」改成「查下发记录这一行是不是你的」——顺带堵死路径穿越(key 是我们铸的,伪造的不在表里)。**下发记录的三个角色**:① 授权(谓词 = `storage_key + user_id + 未消费`,**不含 studio** —— local 上传是裸字节 PUT,请求里根本没有 project/studio)· ② 提供**权威 owner studio**(从行里读,绝不拿客户端这次报的 project_id 重推,否则跨 studio 成员可把存储成本转嫁给团队)· ③ 把报告**绑定到当初申请的那份内容**(报告的 hash 必须等于下发时声明的,否则并发两个报告能在一个 key 上登记两个不同 hash → 一个还活着的对象被当成重复份送去回收 → 404)。消费一次性(CAS 防重放),且在登记**之后**(消费前该物理对象有「未消费下发记录」这条 in-flight 线索,消费后由账本行认领,中间无空窗)。**类型 / 大小 / 上限一律后端从存下来的东西读**:cloud 走 `head()`,local 读文件头嗅探(magic bytes + SVG/文本内容感知回落)——这是 local 上传 kind 全成 `'file'` 那个老 bug 的真修;权威 size 拿到后**回头跟上限复核**(presign 时客户端声明的 size 只做 UX 预检,不当权威门)

- **归属与去重范围 = project 所属的 studio(#1839,2026-07-28)** —— 推翻 2026-07-04 那条「个人 studio 的项目按**操作者**分流、每个协作者留自己的产出」。现在个人与团队一条路径:`resolveOwnerStudioId(projectId)` 只查 project 的 `studio_id`,**谁操作不进入判定**,去重范围随之变成「一个 studio 一个域」而不是「一个协作者一个域」——旧规则下同一个项目里同样的字节按人各存一份,项目主人还看不到协作者的产出。**归属与产出人拆成两列**:`studio_assets.produced_by_user_id` 记「谁**第一个**把这份内容带进来」(去重命中时保留原产出者,后来传同样字节的人不改写它);旧规则是把这两件事压在 `studio_id` 一列上隐式携带,删掉分支就会连带丢失,所以同批补列。**安全模型是产品决策、不是技术收口**:一个 studio 一个去重域意味着该 studio 下任意项目的 editor 共享它的 hash 命名空间,由此带来的内容存在性探测、跨用户 dedup 投毒(`/local-upload` 不验 hash、`/uploaded` 采信客户端 hash)、配额消耗、拿同 studio 他人的任意资产当自己视频节点的封面(`cover_hash` 残余,见 `routes/assets.ts`)四条风险,**明确由发出邀请的用户承担**(邀请是信任行为)。**告知面尚未建立** —— 用户手册与服务协议都还不存在(无路由、无文案、无文档),这条告知是**待办**、不随本次交付,归 operations。读代码时别把「已决策」当成「已修复」,也别把「计划告知」当成「已告知」
- Yjs 持久化走 PG `yjs_documents` 表(Hocuspocus Database extension);跨实例同步走 Redis pub/sub(Hocuspocus Redis extension),连接在 `REDIS_COLLAB_URL`(DB3 collab 实例间协调库,与跨服务 Streams DB2 分开,以后可整体拆到独立 Redis 实例)
- **频道命名空间是 `REDIS_KEY_PREFIX`(默认 = `ENV`),不是 DB 号** —— Redis 的 `SUBSCRIBE` 是实例级的、不认 `SELECT`,所以 DB3 这层隔离对普通 key 有效、对 pub/sub 频道**无效**。两套部署共用一个 Redis 实例(典型:同机多 worktree 并行开发)必须给不同前缀,否则双方持有同 UUID 文档时会互相收到对方的更新、写进对方的库。跨服务 stream key(`taskEventsStreamKey()` 等)不走这个前缀、仍从 `ENV` 派生,因为那是三服务必须一致的契约
- Space 删除是跨实例 read-modify-write(「项目至少留一个 space」守卫):走 `REDIS_COLLAB_URL` 分布式锁(fencing 唯一 token + Lua check-and-del,TTL 30s 兜底)串行化 + 锁内读 PG 权威 space 数(数 `project-{id}/` 内容文档行、排 meta),防多实例并发删除把项目 space 删到 0(DD 2026-07-01,单靠最终一致的 CRDT 内存判断会被击穿)
- 单文档连接数上限(`max_connections_per_document`,默认 100,满了**降级只读**非拒绝)是**跨实例**计数(#1421,2026-07-01):每连接在 `REDIS_COLLAB_URL`(DB3)一个 sorted set(key `{env}:collab:conncount:{docName}`,member `{instanceId}:{socketId}`,score = 心跳时间戳)登记,`onAuthenticate` 读 cluster-wide `ZCARD`(剪枝过期后)判 `>= cap` → 降级 + 永久日志 `connection_cap_degraded`;本地 `getConnectionsCount()` 只数本实例、多实例部署会到 N×cap 才触发,故不用。心跳每 10s 续期、TTL 30s 崩溃自愈;Redis 抖动 fail-open(计数返回 0 不误锁);**meta 文档豁免**(项目基础设施人人必连)。**登记绑 `connected` 生命周期钩子**(非 `onAuthenticate`)——`connected` 只在 Hocuspocus 建好 Connection 对象(已挂 `onClose → onDisconnect`)后触发,与 `onDisconnect` 注销对称,避免 auth 通过但文档加载失败的连接漏注销、被心跳永久续期成幽灵计数(DD 2026-07-01 对抗验证发现并修)
- **协作身份由连接权威确定(#1886,2026-08-06)** —— 服务端在 `onAuthenticate` 就从凭证解出了这条连接是谁,之后**它写、浏览器不报**。两处落地:**① 在场名单**存 meta 文档的 `users`,只有 `id` / `online` / `lastSeenAt` 三个字段(**没有名字头像** —— 各端自己拿 id 去项目成员名册拉,名字改了不会有陈旧副本)。**② 光标身份**在 `beforeHandleAwareness` **逐条盖章、不判归属**(#1887):一个入站帧是一串按 Yjs client id 编键的条目,而那个键是浏览器自己取的数字,所以手工构造的帧能把条目编到别人的键上 —— 服务端**不问「这一条归谁」**,每一条都盖上这条连接在握手时认证出来的那个人。不问是因为那个问题没有可信答案:协作库的连接名单对**重连**的客户端是空的(连接的 client 集合只从 `added` 长,而文档见过的 id 之后一律归 `updated`,远端客户端的 `meta` 永不清),而 y-protocols 自己给这件事留的钩子 `modifyAwarenessUpdate` 只把状态交给回调、**故意不传 client id**。**这道规则从不删条目** —— 把一帧删空会连带掐掉发送方的心跳:一帧什么都没落地就不发 `update` 事件,而心跳搭在那个事件上,90 秒沉默即判离线。**注意 `update` 不要求状态有变化** —— 心跳正是原样重发同一份状态,按内容过滤的是 `change` 事件、不是 `update`。**服务端整个 `user` 字段说了算,只保留客户端的 `focused`**(只有浏览器知道窗口有没有焦点)。**这个模型让「验证」这件事整个消失了**:此前浏览器自报、服务端设了道守卫查它,而守卫在那一层根本做不成 —— 转发和伪造在帧里长得一模一样,它把真实用户踢下线过。
- **在场状态只被断言、从不被否认(#1886 修订,2026-08-07)** —— **写「在线」只有两处**:连接建立时,以及每次心跳。**socket 关闭时什么都不写** —— 一条 socket 结束不等于它的主人走了(一个人同时握着好几条连接,多实例下有些还在这台机器看不见的地方),所以「不在」从不被宣布,而是由清扫**推断**出来:一条**没有任何人在刷新**的记录才被关掉。**它跨实例正确而不需要任何协调**:记录在共享的 meta 文档里,握着连接的那台机器负责刷时间戳、刷新同步给所有实例,所以「时间戳没人碰过」就等于「全集群没有任何机器握着这个人」。**崩溃重启也不需要特殊处理**:崩溃留下的记录只是不再被刷新,重启后第一个进来的人就带动起清扫。**清扫搭在心跳上,不搭在文档载入上** —— 载入那一刻恰恰是记录最新的时候(崩溃后客户端几十秒就自动重连,幽灵看起来全是活的),而只要还有人在,文档就永不卸载、载入钩子再不会触发;搭在心跳上,门槛就变成一个延迟而不是一次错过。同理,**心跳会把一条已经离线的记录写回在线** —— 清扫持续在跑,可能把还连着的人翻掉(隐藏的浏览器标签页定时器被节流到每分钟一次,而 socket 一直开着),心跳是这个人还在的证据,必须能推翻那个推断:错误地复活会被下一轮清扫纠正,错误地离线则是永久的。**meta 文档的 awareness 通道上只有心跳,不传光标**(光标只在 canvas / document 这类空间文档上,谁往 meta 的 awareness 上发光标都是 bug;meta 的 socket 上另跑着 space / tab 的 stateless RPC,走别的钩子、不碰在场状态),所以每个心跳都写、没有任何限流,两次写之间的最大间隔就是浏览器的心跳间隔;门槛 90 秒必须盖过其中最慢的一档(后台标签页每分钟一次),推导和守卫见 `docs/CONFIGURATION.md` 与 `presence-config.test.ts`。**定性是二类问题**:我们保障「他离线了一定能确认到」,不保障「精确在什么时刻通知别人」。
- **页面被浏览器收起来再恢复,必须把协作本地状态设回去(#1886,2026-08-07)** —— 浏览器对「暂存后恢复」的页面有两半约定:`pagehide` 拆、`pageshow` 装。协作库替我们做了前一半(它自己的 `pagehide` 处理器把本客户端的 awareness 状态**删掉**),后一半留给应用,而我们一直没写。少这一半,**同一处会静默坏掉两样东西**:① 心跳永久停(y-protocols 只在 `getLocalState() !== null` 时续时钟,条件读的正是被删掉的那个东西,定时器照跑但什么都不做),于是在场清扫把一个连着的人关掉、而且再也回不来(复活要靠心跳);② 光标对所有人消失(`setLocalStateField` 在状态为 null 时是空操作,而它是本客户端发布光标和焦点的唯一途径)。**这个状态只有一处来源**:`Awareness` 构造函数最后一行 `setLocalState({})`,只在建 provider 时跑一次;恢复的页面把整个 JS 环境原样搬回来,那一行不会再跑,重连也只恢复连接、不恢复它。所以恢复动作放在统一管理 provider 的那一处(`data/yjs/collab-socket.tsx`),监听 `pageshow` 且 `persisted` 为真时,把还是 null 的那些设回 `{}`。判定题:**这个东西的初值是不是只在「创建时」设过一次?是 → 页面被恢复时它不会自己回来**。
- 节点结构 + 字段归属 + 状态机详细规范跟 `@breatic/shared/types/canvas-node.ts` 类型定义保持一致

### Three-layer memory + Turn compression

| Layer | Scope | Table |
|---|---|---|
| User | 跨项目偏好 | `user_memories` |
| Project | 协作者共享 | `project_memories` |
| Conversation | 当前对话摘要 | `conversation_memories` |

- **Turn 机制**:每条消息带 `turnIndex`(`role=user` 时递增)。`memory_window`(默认 20)按 Turn 计数,超出时自动归纳旧 Turn 到记忆摘要
- **Context 压缩**:最近 `full_detail_turns`(默认 3)个 Turn 保留完整 step(tool_call + tool_result),更早 Turn 只保留 user + assistant 最终回复。`thinking` 字段永远不发回 LLM
- **消息存储**:`conversations.messages` JSONB 数组,含 `turnIndex`、`thinking?`、`tool_calls?: ToolCallInfo[]`。原始消息不删除,归纳只生成摘要

### SubAgent (spawn tool)

SubAgent 通过 `spawn({ task, agent, skill? })` 调用。每个 Agent 是 `agents/*.md` 中定义的角色(frontmatter: name, description, tools, model, skills + body: system prompt)。Skill 是可选的知识补充(`skills/` 目录)。

**Agent 定义角色(谁来做),Skill 定义知识(怎么做)。** 两者正交、可组合。

内置 4 个 Agent:`researcher`(搜索参考)| `prompt_optimizer`(提示词优化)| `analyst`(多模态分析)| `planner`(项目规划)。

Tools 取并集:Agent 声明的 tools ∪ Skill 声明的 tools,始终排除 spawn(防递归)。SubAgent 通过 `AsyncLocalStorage` 继承请求上下文(三层记忆 + 压缩对话历史 + userId),在内部直接扣费。

### Worker 5 paths

1. **AIGC Mini-Tool**(source="mini_tool")→ toolName 查表 → provider 直调
2. **Understand**(task_type="understand")→ 多模态理解 / ASR 转写
3. **AIGC 直达**(image/audio/video/3d/tts)→ provider `generateAsync()`
4. **Skill(显式)** → 指定 skillName → AI SDK Agent 执行
5. **Skill(自动选)** → 按 category 合并 Skills → LLM 选

### 一个 AIGC 任务的执行顺序,和「不归路」

`worker/src/handlers/dispatch.ts` 里一个任务从投递到结束的顺序。**碰 worker 任何一步之前先定位「我在第几步」—— 同一个失败在第 3 步和第 5 步的后果完全相反**:

| 步 | 做什么 | 这一步失败会怎样 |
|---|---|---|
| 1 | BullMQ 投递(第 N 次尝试) | — |
| 2 | 重入守卫读任务行:`billed_at` 已设 → 上次已完成并扣过费,原样返回;`provider_result_url` 已设而 `billed_at` 未设 → 上次调过厂商但没走到扣费,标失败不再重试 | — |
| 3 | 调厂商,或跑本地 ffmpeg handler(`downloadToTempDir` 下载输入素材在此) | **抛异常 → BullMQ 重跑整个任务**(次数取 `job_attempts`,默认 3) |
| 4 | **写下「厂商已返回」这个事实 —— 这行是「不归路」** | — |
| 5 | 转存到永久存储(`downloadValidated` 下载厂商产出在此) | **标失败 + 正常返回不抛异常 → BullMQ 不重跑**,且不扣用户积分 |
| 6 | 标完成 + 锁定计费(`billed_at` 上 CAS,只有第一个到达者赢) | — |
| 7 | 扣用户积分 | 只记错误日志,不回滚不失败 —— 用户有权拿到结果 |

**第 4 步之后为什么一律不许抛异常**:厂商那边已经算完并向我们收过钱了,重跑会在第 3 步**再调一次厂商 = 我们再付一次**。所以第 5 步用 `return` 而不是 `throw`,专门掐死重试。

**两笔钱是两回事,别混**(混过一次,写出了「转存失败 → 积分已扣」这种与代码直接矛盾的话):

| 哪笔 | 谁付给谁 | 第几步花掉 | 怎么判断花没花 |
|---|---|---|---|
| 厂商成本 | 我们付给厂商 | 第 3 步,第 4 步把这个事实落库 | 看 `tasks.provider_result_url` |
| 用户积分 | 用户付给我们 | 第 7 步 | **只看 `tasks.billed_at`**,CAS 保证至多一次 |

判定题:**这次失败落在第 4 步的哪一边?** 之前 → 厂商没收钱,重跑是安全的;之后 → 厂商已收钱,不能重跑,也不向用户收费。

### Mini-Tool (two modes)

| | AIGC (image/video/audio) | Text |
|---|---|---|
| Endpoint | `POST /mini-tools/{image\|video\|audio}` | `POST /mini-tools/text` |
| 执行 | BullMQ Worker(异步) | API 直接 streamText(同步 SSE) |
| 结果交付 | Redis → Hocuspocus → Yjs(协作者可见) | SSE 流给请求者(私有,接受后才写 Yjs) |
| 用户交互 | 等待 → 结果出现 | 打字机效果,可随时 abort |
| 积分 | 按 API cost | 按 token 消耗 |
| 并发 | Worker concurrency 控制 | 每用户 1 个(Redis 锁) |

Text 工具(10 个):polish / expand / summarize / translate / rewrite / continue / generate / character / storyboard / script。操作类发完整 `document` + `selection` 保证上下文。自动匹配输入语言回复。

### Skill system

**两区边界**:Agent(多轮对话,注入上下文)| Canvas(Worker 单次执行,必须生成)。文本编辑器(TipTap)独立运行,不使用 Skill。

**metadata.json**:仅 `name` / `description` 必填;其他字段(`scope`/`category`/`tools`/`output_type`/`requires`/...)`skills-loader.ts` 都有 default 兜底(`scope` 默认 `["agent"]`,`category` 默认 `"default"`)。建议显式填 `scope`/`category` 避免读代码才知行为。完整字段表见 `packages/domain/src/agent/skills-loader.ts` 的 schema 定义。禁用 npm 字段(version/author/license/engines/files/main)。

### Agent tools (12)

`run_script` | `read_file` | `write_file` | `edit_file` | `list_dir` | `web_search` | `web_fetch` | `ask_user_question` | `spawn`

**交互工具(3)**:`ask_user_choice` | `propose_canvas_action` | `show_search_results` —— LLM 调用它们发送结构化 payload 供前端渲染成 UI 组件,不执行动作;`main-agent` 检测 sentinel 前缀的结果后 yield 对应 SSE 事件。

**无通用 shell 执行器**。`run_script` 只能执行 `skills/{name}/scripts/` 下的脚本,路径防穿越,按扩展名选解释器(.py → python3, .sh → sh, .js → node)。

### Configuration files

| File | Use |
|---|---|
| `.env` | 运行时配置(从 `.env.dev` 或 `.env.docker` 复制) |
| `.env.dev` | 本地开发模板(localhost URLs) |
| `.env.docker` | Docker 部署模板(容器名 URLs) |
| `config/agent.yaml` | Agent 模型、归纳模型、loop 次数、memory Turn 窗口(20)、Turn 压缩(3) |
| `config/text-tools.yaml` | Text mini-tool 模型 |
| `config/worker.yaml` | Worker 并发、重试、轮询 |
| `config/collab.yaml` | Hocuspocus debounce、限流、文档大小限制、单文档连接数上限(`max_connections_per_document`,默认 100;满了**降级只读**非拒绝) |
| `config/pricing.yaml` | 积分**购买包**(5 档一次性购买,不是订阅/会员,test+live Stripe ID) |
| `config/limits.yaml` | 成员容量**业务软上限**(`studio_member_cap` / `project_collaborator_cap`,默认各 100;project 只数显式邀请的成员,owner + 自动 viewer 豁免)。server 加载器 `packages/server/src/config/limits.ts`(镜像 `pricing.ts`)|
| `config/models/*.yaml` | AI 模型路由(46 文件,model-centric) |

### Logging

每个服务独立日志目录,主线程 `pino.multistream` 同步写文件 + 控制台(无 worker 线程),文件名 `{service}.{yyyy-MM-dd}.log`,轮转交给容器 log driver / logrotate:

| Service | Directory | Init |
|---|---|---|
| Server | `logs/server/` | 入口 `initLogger("server")` |
| Worker | `logs/worker/` | 入口显式 `initLogger("worker")` |
| Collab | `logs/collab/` | 入口 `initLogger("collab")`(已收编进 core 统一 logger) |
| Nginx | `logs/nginx/` | logrotate,30 天保留 |

每条日志双时间戳:`timestamp`(ISO 8601)+ `time`(epoch ms)。

### Shared HTTP transport

`packages/shared/src/http/` —— 一份带重试的 HTTP 传输,**前后端共用**。走不走它只看一条:**打给谁**。打我们自己后端的(前端全站 API)继续走 web 的 axios 单例(`packages/web/src/data/api/request.ts`);打**外部**的(云存储 / vendor API / 任意网址)走这一层,前后端一致。

对外三个符号:`httpRequest` · `HttpRetryError` · `MAX_TIMER_MS`(前两个是它做的事,第三个是 `timeoutMs` 的上界 —— 让按配置算截止时间的调用方能在加载时判定会不会超范围,而不是等到有人用的时候才发现)。它做六件事、没有第七件:发请求 · 判断该不该重试 · 等多久 · 最多三次 · 交出响应或抛异常 · 事后不持有任何东西。**六件事逐条、调用方要声明什么、为什么写死那两个数,全在 [`packages/shared/CLAUDE.md`](../packages/shared/CLAUDE.md)**,这里不复制(两处维护必失同步)。

| 项 | 内容 |
|---|---|
| 为什么在 `shared` 不在 `core` | 浏览器上传要用,所以必须浏览器安全(零 `node:*`)|
| 调用方要声明 | `replaySafe`(重发这个请求会不会产生第二次副作用,只有调用方知道)· `timeoutMs`(可选,默认 300 秒;一个有限数,1 到 2147483647 毫秒之间,小数照收)|
| 写死不给配 | 最多三次投递 + 退避基数 —— 这两个这一层自己答得出来。原先 worker 和浏览器各配一份,已漂移成两种含义(`http_max_retries: 3` 是四次投递,`client_max_attempts: 3` 是三次)|
| 接入进度 | **第 1 批已接:worker 的全部直连 HTTP vendor 调用(20 个 transport、43 处)走 `httpRequest`**(litellm 经 AI SDK 模型封装发 vendor 请求、不在其列),每处原有超时原样搬进 `timeoutMs`,守卫测试按迁移前清单逐文件钉死(`packages/worker/src/providers/__tests__/transport-timeout-preserved.test.ts`)。**第 2 批已接:素材下载两条路**——worker 的 `downloadToTempDir`(此前裸 `fetch`、自身零重试 —— 抖动靠 BullMQ 整个任务重跑兜住(次数取 worker 配置的 `job_attempts`,默认 3),代价是连转码一起重来、且只在约 12 秒的退避窗口内)与 core 的 `downloadValidated`(此前自建重试循环、认不出连接级断连);两处均声明 `replaySafe: true`(纯幂等 GET),`downloadValidated` 的 120 秒作为单次投递超时原样保留,内容完整性守卫(截断 / 空体 / 编码豁免)留在原地。**第 3 批已接:浏览器上传的 PUT**——`putFileWithRetry` 此前裸 `fetch` + 自建重试循环,改走 `httpRequest`(`replaySafe: true`,停滞守卫算出的截止时间进 `timeoutMs`);**预签名不动**,它打的是我们自己的后端、继续走 web 的 axios 单例。判据是「这是不是我们按自己约定发的 API 调用」而**不是**「这个网址指向谁」——同一个 PUT 在 `STORAGE_PROVIDER=local` 下打的就是本服务器,浏览器只拿到一个字符串、分辨不出。顺带删掉 `assetsApi.putFile`(第二个裸 `fetch`,已无生产调用方)。**第 4 批已接:agent 的两个联网工具**——`web_fetch`(经 `packages/domain/src/agent/tools/safe-fetch.ts`)与 `web_search`,此前各自裸 `fetch`、零重试,一次网络抖动就是一次工具失败(整条线的起因);两处均声明 `replaySafe: true`(纯读),原有 30 秒 / 10 秒原样搬进 `timeoutMs`。同批给 SSRF 守卫补了第一份自动化测试(此前零覆盖),含 IPv6 字面量那条独立分支——`URL.hostname` 保留方括号、`ipaddr.isValid("[::1]")` 因此为 false,所以 IPv4 字面量的用例覆盖不到它。**两个语义变化**:`timeoutMs` 管一次投递不管一跳(一跳可能被投递多次、各拿全额,所以它不再是一跳的上界);读响应正文不再受它管(传输层交出响应前清定时器),归工具级超时统一处理、不在本批改。**第 5 批已接(收尾):`breatic/no-naked-fetch` 守卫**——全仓非测试代码的裸 `fetch` 此时只剩传输层自己那一处,这条规则把它钉死。规则按**作用域解析**判「这个名字指向平台的那个 `fetch` 吗」,不按调用形状匹配。判据只有一条:**解析到平台的 `fetch`,而且在值位置**。所以「不调用只传递」的写法(赋给变量、当简写属性、当实参)一样抓 —— 那正是裸 `fetch` 溜进第三方客户端的真实路径;三个载体(`globalThis` / `window` / `self`)的点号和计算成员两种拼法一样抓。**不抓两类**:局部同名参数(它压根不是那个 `fetch`,这是「问名字指向谁」而不是「看这行长什么样」才免费得到的),以及纯类型位置(`typeof fetch` 编译后就没了、发不出请求)。类型位置的判据是**标识符的语法父节点**,五个节点类型整份抄 ESLint 自己的 `no-restricted-globals` —— 作用域分析在这儿帮不上忙,实测 `typeof fetch` 的引用一样报 `isValueReference === true`,跟真调用没区别。**具体几种写法不写在文档里** —— 规则测试文件的用例列表就是那份清单,写个数字进文档只会过期(实际过期过两次)。**两处声明**——根配置管 6 个后端包,`packages/web/eslint.config.mts` 管 web,因为从 web 启动的 ESLint 根本不读根配置(`no-yjs-documents-outside-repo` 和 `schema-timestamps` 就这么在 web 里静默失效过)。同批删掉三个没有消费方的配置键(`http_max_retries` / `http_retry_base_delay` / `download.*`),并把 core 那份逐字节相同的退避副本折进 `shared/backoff.ts`(core 只留 BullMQ 那个 1 起头到 0 起头的转换)。至此五批接入完成。一批出问题不牵连别批,这正是它跟前一版(一次做完 7456 行,PR #371,已关)的区别 |

### Run

```bash
# 本地:首次复制 .env.dev → .env,docker 起 PG+Redis,pnpm db:migrate;之后 pnpm dev
# Docker 全量:复制 .env.docker → .env,改域名/密钥,docker compose up -d
pnpm dev              # turbo 跑全部服务(自动先 build shared/core,再 watch server/worker/collab)
pnpm db:migrate       # 拉新 migration 后跑
pnpm test / typecheck / lint
```

启动时先 `checkInfraReady()` 验证 PG/Redis 可达;连不上立即退出(避免无声挂死)。Migration 是独立步骤,不绑在 dev 启动里。

## Frontend

`packages/web/` — breatic 的 React 前端 app,跑在浏览器里(后端架构见上面的 [Backend](#backend) 部分)。

> **约束 vs. 细节**:`web` 要满足的约束(TS strict / 零 `any`、`app → pages → spaces → features → stores → domain → data → ui` 单向分层、关键路径 + invariant 测试、a11y、i18n〔ICU〕、设计 token 严格)是 [CLAUDE.md](../CLAUDE.md)「前端工业级标准」里的 mandate;本部分写这些约束**怎么落地**(命名 / 节点模型 / token 桥接 / shadcn vendor 边界 / 各类 trap)。

### Status

v14 全新重写已于 2026-05-19 合入 `main`(PR #103)。对齐 design-baseline mock 的视觉调整在长期分支 `feat/web-visual-alignment` 上进行中。

### Tech stack (frontend)

| 层 | 技术 |
|---|---|
| 框架 | React 19 + TypeScript 5.6 |
| 构建 | Vite 5 |
| UI 原语 | shadcn/ui(Radix + Tailwind) |
| 样式 | Tailwind CSS 3.4 + CSS 变量(浅色 / 深色经 `data-theme` 切换) |
| 状态 | Zustand 5 + immer(需要撤销的 store 用 zundo) |
| 协作 | Yjs 13 + @hocuspocus/provider 4(同步优先,无离线模式) |
| 画布 | @xyflow/react 12 |
| 富文本编辑器 | TipTap 3 |
| 音频 / 视频 | 原生 `<audio>` / `<video>` + 自建统一 `MediaPlayer`(装饰波形,零第三方播放器库) |
| 3D | Three.js + @react-three/fiber |
| 数据请求 | Axios + @microsoft/fetch-event-source(SSE)+ React Query |
| i18n | `intl-messageformat`(ICU)经 shared 的 `t()` + `useTranslation` hook(en / zh-CN / zh-TW / ja / ko);8 产品名词 + 角色名走「不翻译表」全语言英文,见 [packages/web/CLAUDE.md](../packages/web/CLAUDE.md)「产品术语「不翻译表」」。**每条文案必须活在命名空间里**——`locales/*.json` 顶层只许放命名空间对象,不许直接放文案(共用的进 `common`,其余进各功能自己的命名空间);**调用点同样如此**,`t('cancel')` 这种无点 id 一律当场报错。两侧都由 repo-lint 的 `i18n-keys-namespaced` CI 强制。理由是死键守卫 `i18n-no-dead-keys` 靠「在源码里找这个 key 的点分全名」判断有没有人用,**无点的 id 没有形状可找**:放宽成裸词匹配会让 `cancel` / `loading` 这类普通英文词满仓命中(`z.enum(["confirm","cancel"])` / `phase === 'loading'`)、守卫等于作废。**调用点那一半是 2026-08-06 才补上的**,补之前源码写了无点 id 三个守卫全都不响——catalog 装不下它、死键守卫方向相反碰不到它、缺失文案守卫的形状认不出它,于是用户屏幕上直接显示 `cancel` 这串字。**判在形状上、不绕道查 catalog**:查不到虽然也能得出「错了」,但报错信息会指向 catalog(读的人会去 catalog 里加一条,而那条加不进去),而且那条推导依赖「catalog 里绝不会有无点 id」这个由另一个守卫维持的前提,那个守卫一改这里就静默失效。**「key 长什么样」在 `repo-lint/src/message-keys.ts` 一处定义**:`KEY_SEGMENT` 给段的形状(**允许数字开头**,2026-08-06 放宽 —— 此前 `canvas.nodePlaceholder.3d` 五个 catalog 都有却没有任何守卫看得见它),`spelledOutKeys()` 给「怎么在源码里找出一个文案调用、取出括号里的 id」,命名空间守卫和缺失文案守卫共用它、各自套自己的规则。**反方向的守卫是 `i18n-no-missing-keys`**:死键守卫问「catalog 里的文案有没有人读」,它问「源码点名的文案 catalog 答不答得上来」——两个方向都会坏,而早先只看着一个,`t("server.error.notFound")` 就这么发出去过(catalog 里写的是 `not_found`)。它只认「整个参数就是写全的 id」这一种写法,拼接和变量传参一律看不见,边界写在它自己的 docstring 里 |
| 路由 | React Router 7 |
| 测试 | Vitest + Playwright + @testing-library + fast-check |
| 监控 | Sentry |

### Run (web only)

全量起服务(api / worker / collab / web,web 跑在 `VITE_DEV_PORT`,默认 :8000)见 [Backend 的 Run](#run);dev server 的 `/api` `/ws` 代理目标由 `PORT` / `COLLAB_PORT` 推导,前后端端口永远同源。只跑 web 用:

```bash
pnpm -F @breatic/web dev          # 只起 web
pnpm -F @breatic/web test         # vitest
pnpm -F @breatic/web test:smoke   # Playwright 端到端
pnpm -F @breatic/web build        # vite 构建 → dist/breatic/
```

### Layered architecture

依赖严格向下流动,下层永不 import 上层:

```
app/        Vite 入口 · 路由 · Provider 编排 · ErrorBoundary
pages/      路由页 + 页面专属子模块(chrome / chat / members / tweaks)
spaces/     Canvas / Document / Timeline 内容实现(open enum)
features/   真·跨页模块(auth / error-boundary / preferences)
stores/     Zustand store(一文件一 store,互不 import)
domain/     纯业务逻辑(状态机 / 权限 / hook)
data/       I/O 边界(api / yjs / stream / storage)
ui/         跨 feature 的业务原子(Avatar、StatusBadge 等)
components/ui/  shadcn 原语(vendor;ESLint 忽略)
theme/      tokens.css(单一 token 源)+ tailwind 扩展
i18n/       locale-bootstrap + useTranslation hook(引擎在 @breatic/shared/i18n)
lib/        工具(cn / format / env / analytics)
```

### Key conventions

- **shadcn 100%** — `components/ui/` 里每个原语都是 shadcn/ui(底层 Radix)。不用 Headless UI,不用 MUI。
- **单一 token 源** — 所有设计 token(neutral / status / brand / shadcn 别名 / chrome UI 尺度)都在 `src/theme/tokens.css`。shadcn 原语直接消费标准别名,**没有独立 bridge 文件**。**设计系统第九片(2026-06-10 起,2026-06-13 ③ 落 breatic)**:纯中性 R=G=B neutral 12 级 + 离极值有界(2026-06-13 推翻微暖→纯中性:顶 #f5f5f5 永不 #fff / 底 #141414 高于 #121212 下限;文字/边框/ring/input/主按钮全 `var(--neutral-N)` 单一源派生)+ **七彩 palette 单一彩色真相源(#1549,2026-07-03 取代方案 D 五色)**:`--color-palette-{red,orange,green,blue,violet,pink,teal}` **明暗各一套人工定值**(锚 = Radix step 11 双档 = 行业收敛区正中;暗版规律 = 色相不动、变亮变柔;**零对比度公式**,user 拍「对比度计算造成貌似合理但肉眼别扭」—— 守卫从不算对比度(旧 shell 版每次运行打印一张参考表,**迁移时未保留**:没有任何东西 gate 它,而一个没人据以行动的数字只是日志噪音));每彩派生 `-bg` 14% / `-border` 40% `color-mix` tint(经 `var()` 引本色,dark 块只覆盖 7 个 identity、tint 与别名全自动跟);status 五组(`--color-status-*`)是**纯语义别名**(error→红 / warning→橙 / success→绿 / info→蓝 / selected→violet 紫),`-foreground` = identity 本身(方案 D 的计算文字色退役),utility 类名不变消费方零改动;**palette 必须在 `:root` 不在 `@theme`**(粉/青 tint 只经运行时拼名 `var()` 消费、无字面工具类,`@theme` 会被 Tailwind 4 tree-shake —— 2026-07-03 对抗审计在生产构建实证;status 别名留 `@theme` 生成工具类);组背景 = 7 彩 tint + 无色(存 token 名,旧 4-status 名经 `LEGACY_GROUP_BACKGROUND_ALIASES` 归一零迁移;选择器 swatch 用 identity 实色、有色组虚线边跟同彩 40%);MiniMap 节点类型映射 `NODE_TYPE_PALETTE`(text=蓝/image=绿/audio=粉/video=紫/便签=橙,#1548 消费);ConnectionBanner 走 status 三件套(取代旧静态 bg-red-900/amber-700);红收窄延续:全局红只有 palette-red(删除按钮 / 报错走 error 别名淡底形态);节点选中 = 自身 1px 边框染 `border-status-selected`(非 ring 外环,status 同走 border 染色);dark surface 砍 elevated 幽灵层 → 四层 background/canvas/card/popover、浮层回归工业克制(dark popover #262626);全局 hover 统一 `bg-accent`、**选中态也用 `bg-accent`**(同 hover 浅色;rail / 类型选择器 / 语言·主题菜单选中统一,弃 `bg-muted` 凹陷);status 必配图标 + 文字[色盲 WCAG 1.4.1];handling = info 蓝 + spinner,locked = 中性 + 锁图标)+ 字号 10 档(base 15)/ 动效 5 档 / z 阶梯 + radius 拆分(chrome 固定 6px + content sm/md/lg/xl)+ 按钮阶梯 24/28/32/44(chrome)+ **表单控件 36px 共享高度 `--control-height`**(input/select + 表单/对话框主 CTA `size='form'` 齐高;表单控件零阴影)+ brand 限定 logo 一类(`--brand-logo-primary` 实心底 + `--brand-fg` 白字);chrome / canvas / studio 全 neutral。**治理三件套**:① token 唯一源(本文件)② `breatic/no-raw-design-values`(CI 硬失败)拦设计值裸写 —— `text-[Npx]` / 抓原色阶 `[var(--neutral` / 裸 hex / `rounded-[Npx]` / 按钮阶梯 px(logo `BrandMark` + inpaint 笔刷 + `tokens.css` 豁免)③ Playwright 视觉回归基线(`pnpm test:visual`,login/register/primitives × 明暗,本地工具非 CI gate)拦视觉漂移。**2026-06-13 ③ 增 3 刚性守卫接 CI**:repo-lint 的 `token-values`(纯中性 R=G=B + 离极值 + 七彩 palette 结构[恰 7 色 × 明暗必不同 × tint 规范 × :root 位置 × 别名接线];旧版的 `--self-test` 变异 fixture 改成单元测试,**基底仍是真实 tokens.css**、在内存里变异,所以测试不会因为 fixture 恰好漏写被测项而假过)· `breatic/one-px-border`(全边框 / focus ring 1px 实色无光晕)· `breatic/overlay-surface`(**两层浮层表面**:接管式面板 dialog/sheet/alert-dialog `bg-card` · 锚定浮层 popover/dropdown/select `bg-popover`)。非白名单处用 raw brand 另由 repo-lint 的 `no-brand-usage` 拦(chrome-baseline §F10 Monochrome Chrome Rule;逐行判、剥注释,豁免只剩 logo token 与 `brand-guard: allow` 行内标记 —— 旧守卫的 `tokens.css` 整文件豁免与 `pages/studio/` 白名单实测都是死的,前者被 logo 豁免完全覆盖、后者的过滤代码早已删除只剩注释在宣传)。
- **Yjs 单一真相源** — 画布节点数据 + space 元数据走 Yjs(`data/yjs/`)。节点归属(前端独占 create / delete / position、后端只改 `data` 字段)见 [Canvas collaboration](#canvas-collaboration)。
- **ChatPanel 是 per-user、不绑 Yjs** — agent 对话走 SSE 流、只属当前查看者;聊天内容永不进 Yjs。
- **Hover 规范** — `packages/web/src/` 里**禁用** Tailwind 的 `hover:bg-<token>/<两位数>` 透明度修饰(如 `hover:bg-accent/40`、`hover:bg-primary/90`)。透明默认的行 / outline / ghost 按钮用实色 token 切换(`hover:bg-accent`、`hover:bg-muted`),实色 CTA 按钮用 `transition-opacity hover:opacity-90`。**例外:`hover:bg-black/<N>` / `hover:bg-white/<N>` 放行**——black / white 是固定色(非 mode-aware token),alpha 叠加不会随 surface 混色、明暗模式读数一致,用于图片蒙层控件(如卡片缩略图上的 ⋯ 菜单)。由 ESLint 规则 `breatic/hover-pattern`(CI 硬失败,放行规则在规则定义里)+ `components/ui/` 里 shadcn 原语默认值强制。理由:透明 hover 会跟底层 surface 混色、对比度随上下文变;实色切换 + opacity-90 跟 chrome-baseline mock 一致、跨 surface 视觉统一。
- **自绘控件优先 = 禁浏览器/OS 原生渲染的交互控件(2026-07-21,#352)** — 创作类产品各引擎(Chrome/Safari/Firefox)画同一原生控件长得不一样 = 致命;凡视觉皮肤由浏览器/OS 绘制的交互控件(`<input type=color/date/time/range>`、裸 `<select>`、原生滚动条、`<audio/video controls>`、`title` 当 tooltip、原生表单校验气泡)一律禁,必须自绘(primitive 登记表:`Slider` / `Select` / react-colorful 取色 / `ScrollArea` / `MediaPlayer`;缺的先在 `components/ui/` 建)。**这是下面滚动条 + toast/tooltip 单点守卫的总纲**,把「原生渲染=各引擎不一致」泛化,新原生控件机械挡而非每次 review 逮。`pnpm breatic/no-native-rendered-ui`(CI 硬失败,带 matcher 自检 + 跳注释行防自扫描足迹)机械挡可 grep 子集(color/date/time/range/裸 select/同行 media controls),逃生舱同行 `native-ui:allow`+理由;`title`/校验气泡 grep 太吵 = mandate-only(人守)。判定题:**这 UI 的样子是浏览器画的吗?是 → 自绘**。完整 mandate + 登记表在 `packages/web/CLAUDE.md`。
- **滚动条 = 唯一 Scroller 组件(2026-07-15,#326/#327)** — 全站每个可见滚动容器(纵向 + 横向)一律走 `components/ui/scroll-area.tsx`(我们的组件,Radix scroll-area 仅作引擎),**禁止裸 `overflow-*` 滚动容器与任何组件级滚动条样式**(`::-webkit-scrollbar` / `scrollbar-width` / `scrollbar-color` 重声明),由 ESLint 规则 `breatic/no-inline-scrollbar`(CI 硬失败)强制;隐藏滚动条(`[scrollbar-width:none]`,如 SpaceTabBar)豁免。行为契约(全部组件自有、零浏览器依赖——CSS Scrollbars L1 只标准化粗细 + 两静态色,hover 交互是 UA 私有且随浏览器构建漂移):滚动或悬停 rail 区域时出现(150/300ms 透明度过渡)、overlay 零布局占位、hover / 拖拽中只变色不变形(thumb 40%→60%)、指针恒 default 箭头、**滚动条交互永不扰动输入态**(焦点 / 选区 / IME;rail mousedown preventDefault 且调用方摘不掉)、**拖拽自研**(Radix 原生拖拽混用屏幕/布局坐标,在 CSS transform 缩放祖先〔ReactFlow 画布〕内按下即跳——thumb 相对拖动 + 轨道跳位全在布局空间计算、指针距离 ÷ 实测环境缩放)。每轴可滚动性门控(`data-scrollbars` / `data-scrollable-y/x` 戳);竖向滚动器内层 wrapper 强制 `display:block` 修 truncate 断链(嵌套横向滚动器经双 child-combinator 免伤);Radix viewport 内层 `display:table` 自动高度会塌陷 `h-full` 垂直居中 —— **居中空态放 ScrollArea 外面**(StudioRecentPage 模式)。`* { scrollbar-width: thin; scrollbar-color: ... }` + 主题根 `color-scheme`(tokens.css)作为未包裹处(根文档)的原生兜底。画布连接桩热区优先级高于滚动条(可遮挡,user 拍板)。
- **统一类型节点(2026-05-19)** — 每种模态一个节点:`text` / `image` / `audio` / `video` / `3d` / `web`(6 种内容类型)外加 `annotation`(独立的协作便签)和 `group`(容器节点,见下条)。不再分 asset / generator。`@` 引用是边关系 + 快照副本,**不是**一种节点类型。生成功能在节点 toolbar 左区(改当前节点);mini-tool 在右区(建一个新兄弟节点 + primary edge)。
- **文本节点正文 = `Y.XmlFragment` + TipTap(2026-08-05,#1774)** — text 节点的正文存 `data.body`(不可解析的 `Y.XmlFragment`,建节点时就种下),经 TipTap 的 `Collaboration` 绑定编辑,**字符级合并**:两人同时在一个节点里打字互不覆盖(此前正文是 `data.content` 纯字符串、后写覆盖先写 = 丢字)。远端光标经 `CollaborationCaret` 显示对方名字 —— 名字是各端拿光标上的 user id 去项目成员名册查的,**不走线**(#1882);而那个 id 是**服务端**按连接凭证盖上去的,浏览器不自报(#1886,见 collab 段「协作身份」条)。`useCollabCaretPresence` 只发 `focused` 标记让失焦的光标变暗 —— 那是浏览器唯一有资格说的事。**打字不引起别的节点重渲**:节点的视图投影(`node-view.ts` 的 `toNodeView`)**刻意不含 `body`**,正文订阅(`use-text-body.ts`)只在真正需要正文的地方(节点自身 + 复制 / 副本 / 生成面板参考列表)按节点 id 单独订阅。进编辑态三个入口(双击 / 选中按 Enter / 空节点占位符按空格)统一走 `startEdit`,它一处判全部前提(节点锁 · handling · viewer 只读 · 引用拾取会话进行中)。类型定义在 `@breatic/shared` 的 `canvas-node.ts` **只有注释没有字段**——shared 零 yjs 依赖(浏览器安全 + 单入口 bundle),活的协作对象不是 wire 数据,同 `prompt` 的处理。**比这个功能更老的节点正文还在旧字段里,一律不迁移**(pre-launch 老数据不服务),打开它得到一个干净的空白起点。`annotation` 便签的正文仍是纯字符串、有同样的丢字问题,单独排期。
- **节点创建入口 + 名字头(2026-06-15)** — 空节点经两入口建:左浮动菜单「节点库」下拉(4 类型)+ 画布空白处右键(`onPaneContextMenu` → 光标处)。节点库按钮在 chrome、在 `ReactFlowProvider` 外拿不到坐标 → 经 `stores/canvas.ts` 的「待建信箱」把类型传进画布,画布落在视口中心(+ 阶梯防重叠);右键直接落光标处。两入口共用 `CreatableNodeMenuItems` + 创建核心 `useNodeCreation`(工厂 `node-factory.ts` 造空节点 → 前端独占 `addNode`),建完自动选中。每个内容节点带「名字头」(模态图标 + 名,双击改名写回 Yjs;`ContentNodeFrame` 统一套在节点体上方)。viewer 只读经 `SpaceBodyProps.readOnly`(源自项目 `myRole`、经 `SpaceOutlet` 下传)在画布拦创建 / 拖拽 / 连线(ReactFlow `nodesDraggable` / `nodesConnectable` = `!readOnly`)。**前端 readOnly gate 只是纵深 + UX**(避免本地拖动后被服务端拒再弹回);**真正的写入边界在 collab 后端**——viewer 连接 = 连接级 readOnly(`hooks/auth.ts` 必 mutate 入参 `connectionConfig.readOnly`、不能靠 hook 返回值,Hocuspocus 在协议层拒每个 sync-update;**所有文档的写入边界都只靠连接级 readOnly**,没有按字段 gate 的东西:canvas / document / timeline 按角色判,**meta 文档对所有客户端无条件只读** —— 它是项目的目录,改它每一项都带规则(判角色 / 建内容行 / 记账本 / 不许删最后一个),客户端可以选择不执行的规则不算规则,所以一律走 `space:*` / `tab:*` RPC。早先在 `before-handle-message` 里逐字段比对的守卫已删:认出一次写入要精确列举框架内部消息类型,漏一种就静默放行,而它漏了文档名前缀、整个生命周期一次都没执行过)。**选中 / 拖拽是 per-user 本地态**(镜像 Yjs 时按节点 id 保留,不进 Yjs)。
- **画布剪贴板(2026-06-23 重做:组感知 + 居中)** — **系统剪贴板单一来源**:`paste` 标记载荷(`node-clipboard.ts` 的 `CLIPBOARD_MARKER`)→ 克隆;纯文字 → 文本节点。**统一绝对坐标模型**:`captureClipboard(targetIds, allNodes)` **组感知**——选中组连成员一起捕获(成员解算成绝对坐标 + `parentId` 链回组、去重)、记内容节点尺寸;`cloneForPaste(payload, userId, offset, externalParentAbs?)` 克隆——父在载荷内 → 重挂克隆出的新组(offset 抵消、相对布局守恒)·父是载荷外已存在组 → 回原组(`externalParentAbs`)·都不在 → 顶层;**`COPY-` 前缀**只加在「根」克隆(顶层节点 / 组 / 回原组的散成员),组内跟随成员名不变。**节点放置统一居中**:创建(库 / 右键 / 拖放 / 文本粘贴)经 `useNodeCreation` 让节点中心落目标点(`centerToTopLeft` + `EMPTY_NODE_SIZE` 288×192,即空态 `NodeContent` 盒);Cmd+V / 右键粘贴视口感知(`pasteAnchorOffset` + `clipboardBoundingBox`)——内容包围盒**跟真实视口相交**(任一部分可见,缩放无关)→ 落旁 +24;完全滚出视口 → 包围盒**中心**落视口中心 / 光标。复制副本(`duplicateTargets`)进已有组时组自动扩展保 24px(`planGroupGrowth`,与 `addNode` 同一 undo 批次);**锁定组拒绝复制进来的副本**(`externalParentAbs` 跳过锁定组 → 副本顶层)。纯函数脱 DOM 单测;`copy`/`paste` **事件对称用 `clipboardData`**。监听挂 `CanvasSpaceInner`(gate `readOnly` + 可编辑)。**图片粘贴**依赖上传编排(归上传片)。
- **节点分组 group(2026-06-23 转 Figma-Frame 手动画框)** — `group` 是容器节点,**自有权威尺寸**(`data.width`/`height` 存 Yjs,反转旧「派生几何」模型):框选 ≥2 散节点 `Cmd/Ctrl+G` / 浮动菜单成组;`Cmd/Ctrl+Shift+G` / 菜单「取消编组」只释放成员、删组框;菜单「删除编组」连成员一起删(`groupDeletionIds` 级联)。**成员归属经 ReactFlow `parentId`**(成员存相对父组坐标),渲染前 `topoSortByParent` 拓扑排序父先于子,组压成员之下(zIndex 0);**拖组带成员由 ReactFlow `parentId` 原生跟随**(不再 `moveGroup`-delta)。**手动 resize**:选中未锁组渲 `GroupResizer`(8 个 `NodeResizeControl`,4 边 + 4 角),每控件按成员包围盒翻成一个 `minWidth/minHeight`(`groupResizeBounds`)→ ReactFlow **原生几何夹**硬停在「成员 + 24px」、快拖不越界(替掉早期 `shouldResize`+commit 钳位补丁)。**只扩不缩**:成员超框 / drag-stop 时 `expandGroupToWrap` 自动长大保 24px、永不自动缩(`group-geometry.ts` 纯函数)。**入组判定中心点**:节点 drag-stop(`planGroupDragStop`)/ 组 resize-stop(`planResizeJoin`)散节点中心落框 → 进组。组属性:7 彩 palette 背景色(+无色;旧 status token 名零迁移归一)+ 双击改名(默认 `Group`,`useInlineRename` 共用 hook,`displayName` 桥接 commit→Yjs 回流空窗免闪老名)。组保持平铺不嵌套;创建 `GROUP_PADDING=24`、`GROUP_MIN_SIZE=40`。**画布锁语义(两作用域,#350 重定义 2026-07-20)**:① **节点自身锁**(`data.locked`)冻结该节点一切 —— 内容编辑 + 删除 + 改名 + **移动**;内容突变门(编辑 / 生成 / 上传 / 重置空图)读节点自身 own-flag(`isNodeLocked` fresh)。② **group 锁**只冻成员**几何**(移动 `draggable=false`)+ **结构**(增删成员、禁解组、拒拖入新成员、整组移 / 删)+ **组身份**(组名 / 位置 / resize),**不冻**成员内容 / 名字 / 生成 / 上传(那些各走成员自己的 own-flag)。删除守卫 `onBeforeDelete` + `filterGatedDeletion`(veto 锁节点 ∪ 锁组成员 ∪ handling 节点;`lockedNodeIds` = own-locked ∪ 锁组成员,喂移动冻结 + 删除两处)。**边永不锁门控**(节点锁 group 锁都不锁 —— 边是逻辑关系非几何,`onConnect` + 剪刀 `deleteEdge` 皆 ungated)。**复制副本不被锁挡**(副本始终 unlocked)。**撤销不被锁挡**(per-user `Y.UndoManager` 在锁守卫之下);后端不检测(前端 gating)。全部经 Yjs 协作同步。
- **画布右键菜单(2026-06-21)** — 5 场景自定义右键菜单,**范围 A**:画布表面(pane / node / group / selection / edge)`preventDefault` 系统菜单 + 出对应自定义菜单;文字输入区(Chat 输入 / 文本节点编辑态 / Project 标题 / 改名 input)**不拦、保留系统菜单**(`onNodeContextMenu` 经 `isEditableTarget(event.target)` 放行)。菜单项:空白处=新建节点(4 模态)+ 粘贴;单节点=复制 / 复制副本 / 改名 / 锁定 / **删除节点**;单组=**复制 / 复制副本** / 取消编组 / 改名 / 锁定 / **删除编组**(组的复制 / 副本连成员整组克隆);多选=编组 / 复制 / 复制副本 / **删除选中**;连线=删除。组件 `CanvasContextMenu` / `NodeContextMenu` / `SelectionContextMenu` / `EdgeContextMenu`(全用 vendored `dropdown-menu` + 零尺寸光标锚)。**删除文案按目标区分**(`deleteNode` / `deleteGroup` / `deleteSelection` locale 键);**所有删除统一走 `gateBlockedDeletion` 守卫**(`onBeforeDelete` pre-veto → `filterGatedDeletion`;#350 由 `lockBlockedDeletion`/`filterLockedDeletion` 改名)+ **级联**(框选 / 组删经 `selectionDeletionIds` / `groupDeletionIds` 连成员删),锁定项被拦弹 toast,read-only 不被绕过;**边永不锁门控**(删边只跟随端点是否真删,防悬空)。复制 / 粘贴走 `navigator.clipboard`(同 Cmd+C/V),失败弹 toast;复制副本 = `duplicateTargets`(`CanvasSpace` 编排 `captureClipboard`+`cloneForPaste`+`addNode`+组扩展,**组感知 + 居中 + COPY- 前缀**,见画布剪贴板条);**复制副本不被锁挡**(锁定节点 / 组也能复制、副本 unlocked)。改名经 `pendingRename` store 信箱 → `NodeIdContext` → `useInlineRename` 认领(触发推迟到菜单 `onCloseAutoFocus` 避开 Radix focus trap)。**快捷键提示平台感知**(`format-shortcut.ts`:mac `⌘C/⌘D/⌘V/⌫` · Windows `Ctrl+C/Ctrl+D/Ctrl+V/Del`);复制副本接 `Cmd/Ctrl+D` keydown(`matchDuplicateShortcut`,双平台)。**viewer(read-only)右键不出任何菜单**。
- **localStorage key 集中 + 统一前缀(2026-06-08)** — 所有浏览器持久化(localStorage)key 走集中注册表 `src/lib/storage-keys.ts`(`STORAGE_KEYS.*`),全部带 `breatic.` 前缀(防同源下跟浏览器扩展 / 未来兄弟应用静默撞键)。callsite 引 `STORAGE_KEYS.*`、不硬编码裸 key 字面量;新 key 加进注册表。唯一例外:`src/index.html` 的 pre-React inline 主题脚本(模块图加载前跑、无法 import 注册表)硬编码 `breatic.preferences` 字面量,前缀仍受守卫检查。由**两半**强制(CI 硬失败):`.ts/.tsx` 走 ESLint 规则 `breatic/storage-key-prefix`(AST 判定,比旧正则多抓 `localStorage['key']` 括号取值、无插值模板字面量、同行两处访问算两条;测试文件豁免——测试传给 hook 的 key 是测试输入、不是产品持久化 key);`index.html` 走 repo-lint 的 `storage-key-prefix-html`,因为 **ESLint 结构上看不到 html**——而那段 inline 脚本恰好是唯一「结构上无法 import 注册表」的调用点,也就是最可能手写裸 key 的地方。

### Naming conventions

| 文件类型 | 命名 | 例 |
|---|---|---|
| React 组件 `.tsx` | `PascalCase`(= 导出名) | `Button.tsx` `ProjectMembersPanel.tsx` |
| React hook `.ts/.tsx` | `useFooBar`(= 导出名) | `useProjectSpaces.ts` `useCanvasActions.ts` |
| 其他 `.ts`(util / data / config / store) | `kebab-case` | `mini-tools.ts` `oss-client.ts` |
| 测试 | 跟被测对象同名 + `.test`,**放被测对象同级的 `__tests__/` 目录**(不与源码平铺) | `space/__tests__/useProjectSpaces.test.ts` |
| 目录 | `kebab-case` | `data/yjs/` `domain/space/` `features/project-members/` |

**测试文件位置(MANDATORY,2026-07-15 拍板)**:所有 `*.test.{ts,tsx}` / `*.spec.{ts,tsx}` 一律放**被测对象同级的 `__tests__/` 子目录**,禁止与源码平铺 colocated。判定题:**这是测试文件吗?是 → 放同级 `__tests__/`,没有第二个位置**。`breatic/test-file-location` CI 强制(六个后端包 + web + `eslint-rules` + `repo-lint` 的源码树里,出现任何 `__tests__/` 外的测试文件即 fail;规则的保障是它自己的单元测试 —— 旧守卫那个 `--self-test` 第二入口随 shell 脚本一起删了,被测物不再兼任裁判)。命名(`.test` 后缀)与位置(`__tests__/`)是两个正交维度,都强制。

### Routing

- `/` → 重定向 `/studio`
- `/studio/*` — studio layout route(`StudioLayout`):常驻左 rail + 顶栏挂一次,子路由出 `<Outlet/>`,切 studio 不重挂 rail(chrome 改造片)
  - `/studio`(index)— 跨 studio「最近」落地页(`StudioRecentPage`;per-user,无独立分享 URL,URL 设计 §5.7 B 修正:无 `/studio/recent`)。走 `GET /api/v1/studios/recent`(挂复数 `studios` app,非 `/studio/:slug`,避 `:slug` 撞;`project_last_opened` 表按 **本人最后打开时间**倒序、访问过滤=仍可达才返〔有 active `project_members` 行 OR studio-可见且仍是 studio 成员〕,绝不漏别人私有 / 被踢 / 软删),wire `RecentItem` 经 `recent-mapper` 派生成卡片视图(`kind='project'` 常量,资产集 V2 返空)。空态被动(无创建 CTA,rail 才有创建入口)。打开任一项目时项目页挂载 `POST /api/v1/projects/:id/opened`(`recentService.recordOpen`:`assertAccess('viewer')` 门控 + composite-PK upsert `last_opened_at=now()`,StrictMode-safe 单发、best-effort、成功 invalidate recent 查询)→ 该项目浮到「最近」顶部。**建项目落点 = 跳进项目页**(decision B:`useCreateProject` onSuccess `navigate('/project/{slug}-{uuid}')`,进页即记一次打开,新项目自然入「最近」)
  - `/studio/:slug` — studio 容器(`StudioContainerPage`),按 `myStudioRole` 分叉:**成员**(非 null)= 6 tab(项目 / 资产集 / 作品 / 成员 / 积分 / 设置;作品固定第 3 位、空壳;个人 studio 也 6 tab[成员 tab 个人=只读单成员、A 方案];**team studio admin 管理成员**(片3:邀请按邮箱查已注册→建 pending invite(独立 `studio_invitations` 表)+ actionable 铃铛通知(+best-effort 邮件链接),被邀请人经铃铛点确认 / 邮件落地页确认才入伙(admin 在成员 tab 见「邀请中」pending、可撤销),accept CAS 串行化(铃铛+邮件双路只生效一次)、镜像转让握手但真相源是 invite 行非通知 / 移除单事务级联清本 studio 全项目访问+owner 项目转 admin / 改角色 creator↔member / 转让管理员两段式握手经站内通知确认+过期期限读 `config/limits.yaml` 的 `decision_window_days`、不收积分));**非成员**(null,decision A 公开门面 200+null)= 无 tab + 作品空态(`NonMemberView`,不下发私货)。项目 tab 走 `GET /studio/:slug/projects`(开放基线可见性过滤)、成员 tab 走 `GET /studio/:slug/members`(JOIN 各成员个人 studio 显示名;admin viewer 另带 pending invitations)+ 片3 写端点(`POST/DELETE/PATCH /studio/:slug/members` + `POST /studio/:slug/transfer-admin`,`requireStudioRole('admin')` 守门);通知系统(`notifications` per-user inbox,`expires_at` + **11 live type**〔3 access role-upgrade(request/approved/rejected)+ 4 studio(invite_request actionable+TTL / invite_accepted / transfer_request actionable+TTL / transfer_approved)+ 4 project(invite_request/accepted / transfer_request actionable+TTL / transfer_approved〔#1611 owner 转让,migration 0039〕);**死类型 member_invited(0033)/ member_joined(0032)已删**〕+ 铃铛只指路不决策:每条等答复的行带 `share_token`,点开进 `/decision?token=`,studio 顶栏接 project `BellMenu`〔已移 `features/notifications`;**actor-first 标题:每条 payload 冗余操作人名+@handle,名字可点跳 `/studio/{handle}`、实体名跳 `/project/{slug}-{id}` / `/studio/{slug}`,新标签页打开**〕);**答复统一走** `GET /decisions/:token` + `POST /decisions/respond`〔落地页 `/decision?token=`,需登录;五个流同一套〕,另有 `DELETE /studio/:slug/invitations/:id`〔admin 撤销〕;建项目限 admin/creator(studio 积分共享)。**团队 studio 创建**:`POST /api/v1/studios`(`createTeamStudio` 一事务原子建 studio + 创建者 admin / slug 全局唯一 `409` 兜底〔`studios_slug_idx`〕/ per-user 限速 10 个每小时 + 每用户 ≤50 个 team studio 软上限〔按**当前 admin 角色**计数、随转让流动,**非**不可变 `created_by`〕)+ `GET /api/v1/studios/slug-available`(实时查重 `checkStudioSlug`,per-user 限速 60 每分);抽取共享 `rateLimit` middleware(`keyBy: 'ip'|'user'`,auth 8 处复用 ip 不变)。前端 rail「新建 Studio」按钮 → `NewStudioDialog`(名称 + slug 两独立必填框、无 type radio)接共享 `useSlugAvailability`(`useDebounce` 300ms + React Query queryKey 含 slug 防乱序 race + 即时输入≠debounce 时 checking 的 skew 守卫)边打边查;**个人注册设标识 `SlugSetupPage` 同款实时查重**(两处统一一套 hook);未登录受保护路由实测返 `401`(非 404)
- `/project/:projectId` — 项目页(Agent 列 + Space outlet;Space 是 Project 内的 type / 模板,**不是**路由段)
- `/project/:projectId/access` — 无权限落地页(NoAccessPage)
- `/choose-slug` — 注册第二步:选 slug → 建个人 studio(已登录但豁免个人-studio 闸门;显示文案仍叫「网址标识 / Handle」,只 URL 路径改名)
- `/login`、`/register`、`/forgot-password`、`/reset-password`、`/verify-email`、`/decision` — auth + 决策落地页(`/decision?token=`,需登录;五个等答复的流〔两个邀请 / 两个转让 / 角色升级〕的三条通道〔邮件 / 铃铛 / 可复制链接〕全汇聚此页)

### Source layout

```
packages/web/
├── public/                  # 原样提供的静态资源
├── src/
│   ├── app/                 # 入口 + provider + error boundary
│   ├── pages/               # 路由页 + 页面专属子模块
│   ├── spaces/              # Canvas / Document / Timeline
│   ├── features/            # 跨页 feature
│   ├── stores/              # Zustand store(一文件一 store)
│   ├── domain/              # 纯业务逻辑
│   ├── data/                # api / yjs / stream / storage
│   ├── ui/                  # 业务原子
│   ├── components/ui/       # shadcn 原语(vendor)
│   ├── theme/               # tokens.css(单一 token 源)
│   ├── i18n/                # locale-bootstrap + useTranslation(引擎在 @breatic/shared/i18n)
│   ├── lib/                 # 工具(cn 等)
│   ├── styles/              # 全局 css 覆盖
│   ├── App.tsx · index.tsx · index.css · index.html
├── tests/                   # Playwright 端到端
├── components.json          # shadcn 配置
├── vite.config.mts · dev-ports.mts · proxy-targets.mts · tsconfig.json
└── package.json
```

### Environment variables

所有 `VITE_*` 变量从 monorepo 根 `.env` 读。前端经相对 URL(`/api/*`、`/ws`、`/uploads/*`)跟后端通信;一个反向代理(生产用 nginx、dev 用 Vite dev proxy)把它们路由到 api / collab 容器。构建产物里不写死任何 host。

| 变量 | 用途 |
|---|---|
| `VITE_APP_VERSION` | app 版本号字符串 |
| `GOOGLE_CLIENT_ID` | Google OAuth(可选;注入为 `__GOOGLE_CLIENT_ID__`) |
| `VITE_SENTRY_DSN` | Sentry DSN(可选) |

鉴权基于 cookie — 后端在登录 / 注册 / OAuth 时种一个 httpOnly 的 session cookie;前端不在 JS 里读或存任何 token。**cookie 名是部署级的**(`breatic_session_{REDIS_KEY_PREFIX}`,构造在 core 的 `sessionCookieName()`,是唯一一处),因为 **cookie 不按端口隔离**(RFC 6265 §8.5)—— 同机跑两套部署时端口分得开服务、分不开 cookie jar,同名就会互相顶掉登录态。服务端环境变量 `COOKIE_DOMAIN` + `EMAIL_BACKEND` 见 [Configuration files](#configuration-files) 段(后端)。

## Coding standards (function definition format)

本节是 breatic 全栈(`core` / `server` / `worker` / `collab` / `shared` / `web`)的**函数定义格式规范**:一个函数定义"长什么样"——它的文档注释、参数描述、返回类型、异常类型该写在哪、怎么写。规范由 ESLint 在 CI 强制(error 级,违反即 fail)。

这是 CLAUDE.md「代码风格」段 + 禁止清单 #11 的细节展开。CLAUDE.md 写 mandate(红线),本节写完整规则 + 理由 + 示例 + 强制点。

### 核心原则

> **类型信息归签名(代码,显式);功能描述归注释;签名表达不了的那一件事(异常类型)也归注释。**

一个函数定义由两部分组成,各管各的、互不重复:

1. **签名(signature)** —— 携带**全部**类型信息(参数类型、返回类型、生成器 yield/next 类型),全部**显式**写在代码里。TypeScript 能静态检查、能随重构自动跟随,是类型的唯一真相源。
2. **文档注释(TSDoc)** —— 携带**功能描述**(这函数做什么、为什么、每个参数代表什么),外加**唯一一件签名表达不了的类型信息:异常类型**(TS 没有 checked exception,编译器不追踪 `throw` 的类型)。

把类型写进注释(如 `@param {string} name`)是被**禁止**的:类型已经在签名里了,注释里再写一遍就是两个真相源,重构改了签名、注释不改 → "代码 ↔ 注释"长期漂移。注释只做签名做不到的事。

### 信息归属表

| 信息 | TS 签名能表达吗? | 写在哪 | 强制规则 |
|---|---|---|---|
| 参数类型 | 能 | **签名**(显式) | `jsdoc/no-types`(注释里禁写类型) |
| 返回类型 | 能 | **签名**(显式) | `explicit-function-return-type` + `jsdoc/no-types` |
| 生成器 yield / next 类型 | 能(`Generator<Y, R, N>` / `AsyncGenerator<Y, R, N>`) | **签名**(显式) | `explicit-function-return-type`;`require-yields-type` / `require-next-type` 关闭(同返回值,不在注释写) |
| **异常类型** | **不能**(无 checked exception,编译器不追踪) | **注释** `@throws {ErrorType}` | `require-throws-type`(带花括号,error) |
| 功能描述(做什么 / 为什么 / 每个参数含义) | 不能 | **注释** 摘要行 + `@param name - desc` / `@returns desc` | `require-jsdoc` / `require-description` / `require-param` / `require-returns` |

一句话:**能被 TS 签名表达的类型,一律进签名、不进注释;唯独异常类型签名表达不了,进注释 `@throws {ErrorType}`。**

### 5 条规则

#### 规则 1 — 显式返回类型(explicit return type)

每个**命名函数单元**(见「适用范围」)必须在签名里**显式写返回类型**,不依赖 TS 推断。生成器写 `Generator<Y, R, N>` / `AsyncGenerator<Y, R, N>`(yield/next 类型也由此携带)。

```ts
// ✅ 正确:返回类型显式
function computeCredits(usage: Usage): number { ... }
const toEntity = (row: CreditRow): CreditBalance => { ... };
async function* streamTokens(prompt: string): AsyncGenerator<string> { ... }

// ❌ 错误:返回类型靠推断
function computeCredits(usage: Usage) { ... }
```

**内联匿名回调豁免**(`allowExpressions: true`):`arr.map(x => x * 2)`、事件 handler 等不是命名 API 表面,强制反而是噪音。

#### 规则 2 — 文档注释(TSDoc block)

每个命名函数单元必须有 TSDoc 块,且块内必须有**一行摘要描述**(说清这函数做什么)——不能只有 `@param`/`@returns` 标签没摘要(`require-description`,规则只有 0/1,摘要不留"可选"口子)。**不分导出 / 私有**:私有 helper 跟导出函数一样需要文档(不按可见性把同类切两半)。

```ts
/**
 * Deduct credits for one AIGC task, idempotent on refKey.
 *
 * @param userId - owner whose balance is charged
 * @param amount - credits to deduct (must be > 0)
 * @param refKey - idempotency key; a repeat call with the same key is a no-op
 * @returns the balance remaining after deduction
 * @throws {AppError} INSUFFICIENT_CREDITS when balance < amount
 */
async function deductOnce(userId: string, amount: number, refKey: string): Promise<number> { ... }
```

#### 规则 3 — 注释里禁写类型(no-types)

`@param` / `@returns` 只写**描述**,不写类型——类型已在签名里。

```ts
// ✅ 正确
/** @param name - the user's display name */
/** @returns the remaining balance */

// ❌ 错误:类型重复进注释,制造 code↔comment 漂移源
/** @param {string} name - the user's display name */
/** @returns {number} the remaining balance */
```

#### 规则 4 — 异常类型带花括号(`@throws {ErrorType}`)

异常类型是签名表达不了的唯一一件类型信息,所以**写在注释里,且带花括号**结构化标注。

```ts
// ✅ 正确:异常类型签名携带不了,带花括号写进注释
/** @throws {AppError} NOT_FOUND when the project does not exist */

// ❌ 错误:只写散文、没有结构化的异常类型
/** @throws when the project does not exist */
```

这是与规则 3 的**刻意反差**:`@param`/`@returns` 禁类型(签名有),`@throws` 必须有类型(签名没有)。两条规则方向相反,但同一个判定标准——**签名能不能表达**。

#### 规则 5 — 生成器类型不进注释(yields/next 关闭)

`@yields` / `@next` **不要求**写类型,因为 yield/next 类型由 `Generator<Y, R, N>` 签名携带,跟返回值同理(规则 1 已覆盖)。`require-yields-type` / `require-next-type` 关闭。

### 适用范围

#### 命名函数单元(必须遵守)

- 函数声明 `function f() {}`
- 类方法 `class C { method() {} }`
- 类声明 `class C {}`(`require-jsdoc` 要求类有文档)
- 变量赋值的箭头函数 / 函数表达式 `const f = () => {}` / `const f = function () {}`
- 类字段赋值的箭头 / 函数表达式 `class C { f = () => {} }`

#### 豁免

| 豁免项 | 理由 |
|---|---|
| 内联匿名回调(`arr.map(x => ...)`、event handler、`Promise` executor 等) | 父节点是 `CallExpression` 而非 `VariableDeclarator`,不是命名 API 表面;强制是噪音 |
| 测试代码(`*.test.{ts,tsx}` / `*.spec.{ts,tsx}` / `__tests__/`) | 项目既有的 test-fixture 豁免 |
| shadcn vendor(`web` 的 `components/ui/`) | 第三方原语,不按本项目规范改(vendor 边界,见 [Frontend](#frontend)) |

### CI 强制

规范由 ESLint(error 级)在 `pnpm lint` 强制,违反即 CI fail。两套配置分别覆盖:

| 配置文件 | 覆盖包 | ESLint 版本 |
|---|---|---|
| 根 `eslint.config.ts` | `core` / `server` / `worker` / `collab` / `shared` | 根 ESLint |
| `packages/web/eslint.config.mts` | `web` | web 自带 ESLint 9 |

两套配置启用**同一组规则**:

- `eslint-plugin-jsdoc` 的 `flat/recommended-typescript-error` 预设(给 TS 项目:关闭 `require-param-type` / `require-returns-type`、开启 `no-types`)
- `jsdoc/require-jsdoc`:全量(`publicOnly: false`),覆盖上述全部命名函数单元;内联回调经 `contexts` 选择器排除
- `jsdoc/require-description`:`error`——每个块必须有一行摘要描述,不只是标签(规则 2)
- `jsdoc/require-throws-type`:`error`(规则 4)
- `jsdoc/require-yields-type` / `jsdoc/require-next-type`:`off`(规则 5)
- `@typescript-eslint/explicit-function-return-type`:`["error", { allowExpressions: true }]`(规则 1)

这一组规则取代了原先 `eslint-plugin-tsdoc` 单一的 `tsdoc/syntax: warn`(all-or-nothing,挡不住低质量注释)。

### 反例速查

| 反例 | 为什么错 | 改成 |
|---|---|---|
| `function f(x: number) { return x; }`(无返回类型) | 返回类型靠推断 | `function f(x: number): number` |
| `const f = () => {}`(无文档) | 命名函数单元缺 TSDoc | 加 `/** ... */` |
| `/** @param {string} name */` | 类型重复进注释 | `/** @param name - ... */` |
| `/** @throws on error */` | 异常类型没结构化 | `/** @throws {AppError} ... */` |
| 只给导出函数加文档、私有 helper 裸奔 | 按可见性切同类(违反 0/1 原则) | 私有 helper 一样补文档 |

### 文件头:版权 + 许可声明

每个**首方 TypeScript 源文件**(`packages/*/src/**/*.{ts,tsx}`,含测试)顶部必须有两行 SPDX 文件头:

```ts
// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
```

`LicenseRef-BOSL-1.0` = Breatic Open Source License 1.0(改良版 Apache 2.0,见仓库根 `LICENSE`);`LicenseRef-` 前缀是 SPDX 对自定义许可的标准写法。

- **豁免**:shadcn vendor(`web` 的 `components/ui/`)—— 第三方 IP,不挂 Orime 版权。
- **CI 强制**:`breatic/no-missing-license-header`(扫 `packages/*/src` 的 `.ts`/`.tsx` + `eslint-rules/src` 与 `repo-lint/src` 的 `.ts`,排除 vendor;新文件缺头即 fail)。**双行都校验** —— 版权行与许可行都得在、都得在最前两行且顺序正确;只认第一行的话,写错许可证的文件能过。
- **一次性补全**:`pnpm lint:fix`(规则自带 fixer,幂等——已有头的文件不动)。头文本只在规则里定义这一处 —— 许可证字符串存两份必漂,而漂的那份不会有任何东西报错。
