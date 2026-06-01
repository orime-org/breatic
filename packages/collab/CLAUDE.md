# @collab — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/architecture.md](../../docs/architecture.md)。

## 角色
**Hocuspocus 独立进程**:Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点。只它认识 Hocuspocus。

## 分层(包内,目录即分层)
- `hooks/`(`auth` / `before-handle-message` / `awareness-meta-users` / `disconnect-cleanup`)= Hocuspocus 生命周期钩子,协作事件适配,翻译 Yjs 事件 ↔ 持久化/流
- `services/`(`persistence` / `event-stream` / `space-rpc` / `task-listener` / `members-sync`)= collab **自带的协作业务**(本质是协作适配,跟 Hocuspocus 绑死,留本包)
- `infra/`(`logger` / `health-checks` / `connectivity-check`)= 本包支撑设施(对齐 core/server 的 `infra/`)
- 根:`index.ts` = composition root(启动 `initCore(process.env)`,唯一读 env 处)· `hocuspocus.ts` = Hocuspocus 装配(把 hooks + services 接进 Server)· `bootstrap-config.ts` / `config.ts` = 引导 + 配置

## 可 import 谁
- ✅ `@breatic/core` 的**基础设施**(`createPgClient` / `createRedisClient` / `HealthCheck` / `initCore` / `MONOREPO_ROOT`)+ `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@breatic/domain` —— 服务之间互不 import;**collab 绝不依赖 domain**(server+worker-only 的 AIGC 业务,`lint:dependency-cruiser` 的 `collab-no-domain-import` 规则强制)
- ⚠️ **但 collab ≠ 只用 core infra**:鉴权 / 会话 / 成员事件这类**全后端(含 collab)必须一致**的逻辑属 core 共享内核,collab 用 core 的统一鉴权。**鉴权已统一(二次调整 PR2)**:`hooks/auth.ts` 调 core 的 `getSession` + `projectAuthService.loadProjectRole`,跟 server 共用同一套原语,不再手写 `redis.get(:session:)` / 裸 SQL `loadProjectRole`(collab 仅剩对自己 `yjs_documents` 表的空间存在性查询)。旧表述「collab 只借 core infra、业务不引入」**已作废**(它把鉴权漂移当成了设计)
- 本包内部用 `@collab/*` 前缀

## 怎么拿配置
入口注入后经 core 读;collab 配置走 `config.ts`。本包逻辑不直接读 `process.env`。

## 关键路径
Yjs 协作 = 关键路径,必 100% TDD;hook 顺序坑(`onConnect` 在 `onAuthenticate` 前 fire,`context.user` 未就绪)等已知陷阱见 [docs/architecture.md](../../docs/architecture.md);改 collab 源码无 hot-reload,必手动重启。
