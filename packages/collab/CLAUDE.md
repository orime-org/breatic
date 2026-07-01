# @collab — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**Hocuspocus 独立进程**:Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点。只它认识 Hocuspocus。

## 分层(包内,目录即分层)
- `hooks/`(`auth` / `before-handle-message` / `awareness-meta-users` / `disconnect-cleanup`)= Hocuspocus 生命周期钩子,协作事件适配,翻译 Yjs 事件 ↔ 持久化/流
- `services/`(`persistence`〔含懒种子 fetchDoc 兜底〕 / `yjs-documents.repo`〔yjs 库唯一 repo〕 / `lazy-seed` / `lifecycle-listener`〔删除/复制命令消费者〕 / `event-stream` / `space-rpc` / `task-listener` / `members-sync`)= collab **自带的协作业务**(本质是协作适配,跟 Hocuspocus 绑死,留本包)
- `infra/`(`logger` / `health-checks` / `connectivity-check`)= 本包支撑设施(对齐 core/server 的 `infra/`)
- 根:`index.ts` = composition root(启动 `initCore(process.env)`,唯一读 env 处)· `hocuspocus.ts` = Hocuspocus 装配(把 hooks + services 接进 Server)· `bootstrap-config.ts` / `config.ts` = 引导 + 配置

## 可 import 谁
- ✅ `@breatic/core` 的**基础设施**(`getRedis` / `getStreamRedis` / `getCollabRedis` / `createRedisClient` / `pingDb` / `pingRedis` / `checkInfraReady` / `taskEventsStreamKey` / `startHealthServer` / `initCore` / `MONOREPO_ROOT`,以及 `Redis` 类型)+ `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@breatic/domain` —— 服务之间互不 import;**collab 绝不依赖 domain**(server+worker-only 的 AIGC 业务,`lint:dependency-cruiser` 的 `collab-no-domain-import` 规则强制)
- ⚠️ **但 collab ≠ 只用 core infra**:鉴权 / 会话 / 成员事件这类**全后端(含 collab)必须一致**的逻辑属 core 共享内核,collab 用 core 的统一鉴权。**鉴权已统一(二次调整 PR2)**:`hooks/auth.ts` 调 core 的 `getSession` + `projectAuthService.loadProjectRole`,跟 server 共用同一套原语,不再手写 `redis.get(:session:)` / 裸 SQL `loadProjectRole`。旧表述「collab 只借 core infra、业务不引入」**已作废**(它把鉴权漂移当成了设计)
- 🗄️ **DB 适配(2026-06-03 两 PG 库切换后)**:collab **不碰 postgres.js 驱动、不手搓连接池**,但**是 yjs 库的唯一运行时用户**——`yjs_documents` 查询 repo 已从 core 搬到本包 `services/yjs-documents.repo.ts`(一表一 repo,家搬了),经 core 的 **`yjsDb` 单例**(`YJS_DATABASE_URL`,独立 PG 库)跑 Drizzle 查询;驱动/池/表结构(`yjs-schema.ts`)/迁移仍只在 core。本包持久化(`persistence`,含懒种子)/ 空间存在性读(`auth`)/ space-rpc 软删·恢复 / 生命周期消费者(`lifecycle-listener`)全走这个本地 repo。`postgres` 驱动包仍不在本包 deps,但**新增 `drizzle-orm`**(同 core 版本)跑查询。健康探针 `pingDb()`(双库都探),boot 连通性检查走 core `checkInfraReady`(双库)。CI 强制:`lint:no-postgres-outside-core`(驱动只许 core)+ `lint:no-yjs-documents-sql-outside-repo`(allowlist 指向本包 repo + core `yjs-schema.ts`)+ `lint:no-raw-sql-outside-repo`(本包裸 SQL 只在 `*.repo.ts`)
- 🔴 **Redis 适配统一(2026-06-02)**:collab **不直接依赖 ioredis 驱动**。`Redis` 类型从 core re-export 拿(`import type { Redis } from "@breatic/core"`);会话查的 Redis 改用进程 `getRedis()` 单例(DB0,同 server/worker);**订阅 / 阻塞流 / Hocuspocus pub-sub 等专用连接**仍经 core 的 `createRedisClient` 工厂建——Redis 协议要求每个角色独占 socket,**连接数收不了**(跟 postgres 单池多路复用本质不同)。**Redis 拆 4 连接(2026-07-01):Hocuspocus 跨实例 pub-sub 连接 + `space:delete` 分布式锁走 `getCollabRedis()`(DB3 `REDIS_COLLAB_URL`,collab 实例间协调库,与跨服务 Streams DB2 分开,以后可整体拆独立 Redis 实例)。删除守卫 = fencing 锁(唯一 token + Lua check-and-del,TTL 兜底)串行化 + 锁内读 PG 权威 space 数(`countLiveSpaceDocs`),防多实例并发删除把 space 删到 0;细节见 DD 2026-07-01**。stream key `:stream:task-events` 从 core 的 `taskEventsStreamKey()` 拿(跟 worker 发布同源,消灭两处各造的静默断风险);健康探针走 `pingRedis()`。`ioredis` 包已从本包 `dependencies` 移除。CI 强制:`lint:no-ioredis-outside-core`(驱动只许 core)
- 本包内部用 `@collab/*` 前缀

## 怎么拿配置
入口注入后经 core 读;collab 配置走 `config.ts`。本包逻辑不直接读 `process.env`。

## 关键路径
Yjs 协作 = 关键路径,必 100% TDD;hook 顺序坑(`onConnect` 在 `onAuthenticate` 前 fire,`context.user` 未就绪)等已知陷阱见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。改 collab 源码(或依赖 `core/dist` 重建)tsx watch 自动重启拾取,不需手动 kill;优雅关闭先关 WS 监听端口 + 整体超时兜底(`runGracefulShutdown`),重启不撞 EADDRINUSE。
