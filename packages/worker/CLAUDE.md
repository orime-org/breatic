# @worker — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/architecture.md](../../docs/architecture.md)。

## 角色
**BullMQ 壳**:把队列任务翻译成 provider / core 调用。只它认识 BullMQ。

## 分层(包内)
- `handlers/` = 任务路由层,**不写业务**,翻译 job ↔ 调用
- `providers/` = AIGC 各模态(image / video / audio / tts / 3d / understand)+ 本包私有逻辑(如 video-cover)
- `index.ts` = composition root,启动 `initCore(process.env)`,唯一读 env 处

## 可 import 谁
- ✅ `@breatic/core` · `@breatic/shared` · 外部 npm
- ❌ `@server` / `@collab` —— 服务之间互不 import
- 本包内部用 `@worker/*` 前缀

## 怎么拿配置
入口注入后,经 core `getConfig()` / `env` Proxy 读;worker 配置走 `getWorkerConfig()`。本包逻辑不直接读 `process.env`。

## 关键路径
积分扣减(job 完成时按真实成本 `markCompletedAndBill`)+ AI tool call 走 worker,必 100% TDD;job handler 顶层 catch 必 `logger.error({ err, ctx })`,失败进 BullMQ 重试链。
