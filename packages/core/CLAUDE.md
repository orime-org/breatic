# @breatic/core — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/architecture.md](../../docs/architecture.md)。

## 角色
**后端共享内核**(仅后端共用,可用 node API)。**不是所有业务的默认堆放处** —— 只装真·跨服务共享的东西。

## 进本包判定题
是不是 —— ① 共享 DB schema / ② 跨服务事件协议 / ③ ≥2 个服务共用的关键业务(钱·任务)/ ④ 基础设施(连接·日志·配置)?是 → core;否 → 放用它的那个服务(`@server` 等)。

## 装啥(收敛后)
共用业务(credit / task / node-history + `user.repo`)· 基础设施(redis / 队列 / 存储 / stripe / 邮件 / 会话)· db(schema / 迁移 / client)· agent(模型 / 工具 / skill 加载)· i18n · config · 异步事件契约。

## 可 import 谁
- ✅ `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@collab` —— **库不能 import 应用层**(`lint:no-app-import-in-core` CI 强制)
- 本包内部用 `@core/*` 前缀

## 怎么拿配置
经 `env` Proxy / `getConfig()` / `getRawEnvVar()` 读**注入**的配置;**禁读 `process.env` / 禁 load `.env`**(配置 ACQUISITION 是 application 决策,见根 CLAUDE.md 环境变量注入)。`lint:no-core-process-env` 强制。

## 出错怎么办
**只 throw**(原 error 或 typed `AppError` / `InfraNotReadyError`),或返回 sentinel(`{ exists:false }` 等);**禁调 logger.\*、禁 `process.exit()`**(库不决定记日志 / 退进程,抛给应用层)。`lint:no-library-logger` 强制。
