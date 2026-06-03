# @worker — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**BullMQ 壳**:把队列任务翻译成 provider / core 调用。只它认识 BullMQ。

## 分层(包内)
- `handlers/` = 任务路由层,**不写业务**,翻译 job ↔ 调用;`dispatch.ts`(BullMQ job 入口,5 路分发:mini-tool / understand / aigc-direct / skill-explicit / skill-auto + 节点状态回写)+ `local/`(本地 ffmpeg 执行:`runtime/` 下载/上传/spawn/tempdir + `video/` 8 个视频操作)。**原 `handlers.ts` 文件已并进 `handlers/dispatch.ts` 消除"文件 vs 目录同名"歧义**
- `providers/` = AIGC 各模态(image / video / audio / tts / 3d / understand)+ 本包私有逻辑(如 video-cover)
- `index.ts` = composition root,启动 `initCore(process.env)`,唯一读 env 处

## 可 import 谁
- ✅ `@breatic/core` · `@breatic/domain` · `@breatic/shared` · 外部 npm
- ❌ `@server` / `@collab` —— 服务之间互不 import(server+worker 共享的 AIGC 业务沉 domain)
- 本包内部用 `@worker/*` 前缀

## 怎么拿配置
入口注入后,经 core `getConfig()` / `env` Proxy 读;worker 配置走 `getWorkerConfig()`。本包逻辑不直接读 `process.env`。

## 关键路径
积分扣减(job 完成时按真实成本 `markCompletedAndBill`)+ AI tool call 走 worker,必 100% TDD;job handler 顶层 catch 必 `logger.error({ err, ctx })`,失败进 BullMQ 重试链。
