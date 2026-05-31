# @collab — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/architecture.md](../../docs/architecture.md)。

## 角色
**Hocuspocus 独立进程**:Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点。只它认识 Hocuspocus。

## 分层(包内)
- hook 层(`auth` / `before-handle-message` / `awareness-meta-users` / `disconnect-cleanup` 等)= 协作事件适配,翻译 Yjs 事件 ↔ 持久化/流
- `persistence` / `event-stream` / `space-rpc` / `task-listener` / `members-sync` = collab **自带的协作业务**(本质是协作适配,跟 Hocuspocus 绑死,留本包)
- `index.ts` = composition root,启动 `initCore(process.env)`,唯一读 env 处

## 可 import 谁
- ✅ `@breatic/core` 的**基础设施**(`createPgClient` / `createRedisClient` / `HealthCheck` / `initCore` / `MONOREPO_ROOT`)+ `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@breatic/domain` —— 服务之间互不 import;**collab 绝不依赖 domain**(server+worker-only 的 AIGC 业务,`lint:no-domain-import-in-collab` 强制)
- ⚠️ **但 collab ≠ 只用 core infra**:鉴权 / 会话 / 成员事件这类**全后端(含 collab)必须一致**的逻辑属 core 共享内核,collab 就该用 core 的统一鉴权。**现状漂移(待鉴权统一 PR 消灭)**:collab 当前**自己手写** `redis.get(:session:)` 查会话 + 裸 SQL `loadProjectRole` 查角色,没走 core —— 跟 server 各写一套、易失同步;鉴权统一 PR 后改调 core 的 `session-store` + `projectMembers` repo。旧表述「collab 只借 core infra、业务不引入」**已作废**(把漂移当成了设计)
- 本包内部用 `@collab/*` 前缀

## 怎么拿配置
入口注入后经 core 读;collab 配置走 `config.ts`。本包逻辑不直接读 `process.env`。

## 关键路径
Yjs 协作 = 关键路径,必 100% TDD;hook 顺序坑(`onConnect` 在 `onAuthenticate` 前 fire,`context.user` 未就绪)等已知陷阱见 [docs/architecture.md](../../docs/architecture.md);改 collab 源码无 hot-reload,必手动重启。
