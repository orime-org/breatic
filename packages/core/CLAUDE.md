# @breatic/core — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**后端共享内核**(仅后端共用,可用 node API)。**不是所有业务的默认堆放处** —— 只装真·跨服务共享的东西。

## 进本包判定题
是不是 —— ① 共享 DB schema / ② 跨服务事件协议 / ③ **collab 也要用且 ≥1 其他服务也用的跨切面**(鉴权 · 会话 · 角色 · 成员事件)/ ④ 基础设施(连接·日志·配置)?是 → core。**只 server+worker 共用的 AIGC 业务(钱 · 任务 · agent 等)→ `@breatic/domain`;只一个服务用 → 那个服务(`@server` 等)。**

## 装啥(PR4 二次调整后)
共享鉴权内核(`auth/`:projectMembers.repo + projectAuth.service + loadProjectRole)· 基础设施(`infra/`:redis〔**ioredis 驱动 + `createRedisClient` 工厂 + 四延迟单例(getRedis DB0 / getQueueRedis DB1 / getStreamRedis DB2 跨服务 Streams / getCollabRedis DB3 collab 实例间协调:Hocuspocus pub/sub + space-delete 锁)+ `pingRedis` 探针 + re-export `Redis` 类型——全项目唯一 ioredis 家,`lint:no-ioredis-outside-core` 强制;Redis 多连接按协议必须独占 socket,连接数不收**〕 / 队列 / 存储 / event-stream〔含 `taskEventsStreamKey` + `lifecycleStreamKey` 跨服务流 key 单一来源〕 / control-events / session-store / rate-limiter / health / logger)· db(**两个 PG 库**:① 业务库 schema(`schema.ts`,含 `project_lifecycle_outbox` 发件箱表)/ 迁移(`migrations/`)· ② yjs 库 schema(`yjs-schema.ts` 的 `yjsDocuments` 表)/ 独立迁移(`migrations-yjs/` + 独立 journal)· client〔**postgres.js 驱动 + 连接池工厂 + `db`/`rawPg`(业务)+ `yjsDb`/`yjsRawPg`(yjs 库,`YJS_DATABASE_URL`)双延迟单例 + `pingDb` 探针 + `checkInfraReady`(双库探针)——全项目唯一 postgres.js 家,`lint:no-postgres-outside-core` 强制**〕)· config · i18n · `app-errors`(AppError 体系)· 跨服务事件契约。**注**:`yjs_documents` 查询 repo **已搬 collab**(2026-06-03 两 PG 库切换,collab 是 yjs 库唯一运行时用户)—— core 只留表结构 + 驱动/池/迁移;`lint:no-yjs-documents-sql-outside-repo` allowlist 现指向 collab repo + core `yjs-schema.ts`。

**已搬走、不再在 core**:AIGC 业务(credit / task / node-history / agent / model-catalog / canvas-lock)→ `@breatic/domain`;user.repo / stripe / mailer / pricing / text-tools → `@server`。

## 可 import 谁
- ✅ `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@collab` —— **库不能 import 应用层**(`lint:dependency-cruiser` 的 `library-no-app-import` 规则 CI 强制)
- 本包内部用 `@core/*` 前缀

## 怎么拿配置
经 `env` Proxy / `getConfig()` / `getRawEnvVar()` 读**注入**的配置;**禁读 `process.env` / 禁 load `.env`**(配置 ACQUISITION 是 application 决策,见根 CLAUDE.md 环境变量注入)。`lint:no-core-process-env` 强制。

## 出错怎么办
**只 throw**(原 error 或 typed `AppError` / `InfraNotReadyError`),或返回 sentinel(`{ exists:false }` 等);**禁调 logger.\*、禁 `process.exit()`**(库不决定记日志 / 退进程,抛给应用层)。`lint:no-library-logger` 强制。
