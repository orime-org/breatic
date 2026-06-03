# @breatic/domain — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**server + worker 共享的业务内核**(AIGC 业务大脑)。装两个服务都要用、但 **collab 永不触碰**的共享业务。

## 进本包判定题
是不是 —— 只有 server + worker 共享、collab 绝不碰的业务(积分"花" / 任务 / 节点历史 / agent / model-catalog / canvas-lock)?是 → domain。若 collab 也要用 → 进 core;若只一个服务用 → 留那个服务。

## 装啥
积分"花"侧(credit + `markCompletedAndBill` 原子扣费)· 任务 · 节点历史 · agent(模型 / 工具 / skill 加载 / extract-prompt / llm)· model-catalog(含每次成本)· canvas-lock(节点覆盖锁)。

## 可 import 谁
- ✅ `@breatic/core` · `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@collab` / `@web` —— 库不能 import 应用层(`lint:dependency-cruiser` 的 `library-no-app-import` 规则把 domain 一并扫描强制)
- 本包内部用 `@domain/*` 前缀

## 谁能 import 我
- ✅ `@server` / `@worker`
- ❌ `@collab` —— collab 是 server+worker 之外的进程,绝不碰 AIGC 业务(`lint:dependency-cruiser` 的 `collab-no-domain-import` 规则强制)

## 怎么拿配置
经 core 的 `env` Proxy / `getConfig()` / `getRawEnvVar()` 读**注入**的配置;**禁读 `process.env` / 禁 load `.env`**(同 core 纪律,`lint:no-core-process-env` 把 domain 一并扫描强制)。

## 出错怎么办
**只 throw**(原 error 或 typed `AppError` / `InfraNotReadyError`),或返回 sentinel;**禁调 `logger.*` / `console.*`、禁 `process.exit()`**(同 core 纪律,抛给应用层;`lint:no-library-logger`(含 `console.*`)+ `lint:no-library-process-exit` 把 domain 一并扫描强制)。
