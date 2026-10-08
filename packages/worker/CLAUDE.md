# @worker — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**BullMQ 壳**:把队列任务翻译成 provider / core 调用。只它认识 BullMQ。

## 分层(包内)
- `handlers/` = 任务路由层,**不写业务**,翻译 job ↔ 调用;`dispatch.ts`(BullMQ job 入口,4 路分发:mini-tool / understand / aigc-direct / skill-explicit(都不匹配则抛错,不再按 category 自动选 skill) + 任务行结算;成败都经 `settleTaskForNode` 把这条任务行落成 `done` / `failed`,并经 `emitNodeTaskCounts` 重发该节点的四个计数)+ `container/run-container-job.ts`(容器类 mini-tool:作业交给 ingest Worker 在 Cloudflare 容器里跑 ffmpeg,本包不在本地处理媒体;每次取出只查一次作业,还在跑就 `job.moveToDelayed` + `DelayedError` 放回队列、不消耗重试次数,截止时间取任务行的两小时预算)+ `failed-job-cleanup.ts`(跨进程兜底:`reclaimFailedJobById` 由 core `createQueueEvents('tasks')` 的 **`QueueEvents.on('failed')`** 跨进程驱动〔非进程内 `worker.on('failed')` —— 崩溃 worker 跑不了自己回调,QueueEvents 每个活实例都收到〕,事件只给 jobId → 用 `queue.getJob` 取回 job〔`removeOnFail` 保留 24h〕,**终态失败**〔靠 `job.finishedOn` 判,不靠 attemptsMade —— stalled 判死不递增它〕才结算那条没人收尾的任务行;`worker.on('failed')` 只留本地日志)。**原 `handlers.ts` 文件已并进 `handlers/dispatch.ts` 消除"文件 vs 目录同名"歧义**
- `providers/` = AIGC 生成。**图片 / 视频 / 音频 / 语音四个模态走同一条路,全部跑在 WaveSpeed 上**:`generate.ts`(目录条目 + 参数校验)→ `run-steps.ts`(按 `task_upstream_steps` 逐步提交、按存下的 prediction id 续轮询、已完成的步骤复用答复,计费合计每次 prediction)· `plan-steps.ts`(模型 `extra_steps` 排成的上游调用顺序)· `upstream-body.ts`(按 yaml 里每个参数的 `upstream` 声明拼请求体,我们的参数名换成端点字段名只在这一处;声明了 `joins` 的槽位经 shared 的 `joinSlotFiles` 并进它点名的池子、提示词后面接上 `prompt_note`)· `wavespeed.ts`(唯一上游的提交与轮询)· `families/`(请求不止字段映射的两个模型:minimax-speech / nano-banana)。3D 仍走自己的 `three-d/`。理解(understand)不在这里,在 `handlers/dispatch.ts` 调 domain 的 `understandMediaAt`
- `index.ts` = composition root,启动 `initCore(process.env)`;`voice-samples.ts` = 第二个入口(它用 `runtime/` 的 spawn / tempdir 在本机跑 ffmpeg),维护样音的人在目录新增音色时本地跑 `pnpm voice-samples`,把目录里点名、固定样音地址(`config/voice-samples.json` 的 `base_url`)还没有的音色样音和运镜指令预览片段(`voice-samples/camera-previews.ts`)生成上去;不在任何部署里跑。两个入口都经 `bootstrap-config.ts` 读 env,别处不读。`sentry.ts` = 错误上报,只有 `index.ts` 调 `initSentry()`(在第一条日志之前);`index.ts` 在它启动之后的退出都经 `exitProcess(code)` 先 flush;`bootstrap-config.ts` 配置校验失败时它还没启动,直接 `process.exit(1)`

## 可 import 谁
- ✅ `@breatic/core` · `@breatic/domain` · `@breatic/shared` · 外部 npm
- ❌ `@server` / `@collab` —— 服务之间互不 import(server+worker 共享的 AIGC 业务沉 domain)
- 本包内部用 `@worker/*` 前缀

## 怎么拿配置
入口注入后,经 core `getConfig()` / `env` Proxy 读;worker 配置走 `getWorkerConfig()`。本包逻辑不直接读 `process.env`。

## 关键路径
积分扣减(job 完成时按真实成本 `markCompletedAndBill`)+ AI tool call 走 worker,必 100% TDD;job handler 顶层 catch 必 `logger.error({ err, ctx })`,失败进 BullMQ 重试链。
