# 头号原则(MANDATORY)

> 解决问题要找根因 — 不在症状上贴补丁,不"先这样后续再改",不拿"工作量大 / 时间紧"当借口。

每个 PR 动手前回答:**这个修改是在解决根因,还是在压住症状?** 答不上来停下来,重新想,或者问用户。

解决后再问:**真的解决了根本问题,还是把症状搬到了别处 / 把问题往后拖了一步 / 让自己看起来像解决了?** 答错就停,先跟用户沟通。

**每次完成任务必须测试 + 同步所有受影响文档:**

| 项 | 内容 |
|---|---|
| 测试 | typecheck + 单测 + smoke / e2e / 浏览器交互。做不了要 explicit 说明,不许跳过 |
| 文档 | ROADMAP / spec / `docs/*` 等所有受影响项。**落后文档比没文档更糟** |

**所有任务必须先列 todo 计划,按计划执行,完成后对照复核**。不分 research / 执行 / 测试 / 文档,**也不分大小** — 哪怕一两步也写。**取消"小任务豁免"**:小任务也写、也复核。

# 项目简介

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo,6 包 + 3 服务。

**架构详见 [docs/architecture.md](./docs/architecture.md)**(backend 全部技术栈 / 包依赖 / 3 服务 / 画布协作 / 三层记忆 / SubAgent / Worker / Mini-Tool / Skill / Agent tools / 配置 / 日志)。**前端详见 [docs/frontend.md](./docs/frontend.md)**(技术栈 / 7 层 layered / 节点模型 / 命名规范 / 路由)。

# 开发命令

```bash
# 本地:首次复制 .env.dev → .env,docker 起 PG+Redis,pnpm db:migrate;之后 pnpm dev
# Docker 全量:复制 .env.docker → .env,改域名/密钥,docker compose up -d
pnpm dev              # turbo 跑全部服务(自动先 build shared/core,再 watch server/worker/collab)
pnpm db:migrate       # 拉新 migration 后跑
pnpm test / typecheck / lint
```

启动时先 `checkInfraReady()` 验证 PG/Redis 可达;连不上立即退出(避免无声挂死)。Migration 是独立步骤,不绑在 dev 启动里。

# 代码风格

- TSDoc(`@param`, `@returns`, `@throws`, `@example`),公共 API 必须有
- TypeScript strict,禁止 `any`(用 `unknown`),禁止 `var`/`require`
- ESLint + eslint-plugin-tsdoc 强制
- 前端命名规范见 [docs/frontend.md#naming-conventions](./docs/frontend.md#naming-conventions)
- 前端 layered 架构以 `app → pages → spaces → features → stores → domain → data → ui` 单向依赖(详见 [docs/frontend.md#layered-architecture](./docs/frontend.md#layered-architecture))

# 关键规范

- **软删除(MANDATORY)**:所有表用 `deleted_at` 标记,FK `restrict`,list 默认过滤 `deleted_at IS NULL`。**禁止硬删除**(GDPR 删号走单独流程)
- **`created_at`(MANDATORY)**:所有 PG 表必须有 `created_at timestamp with time zone DEFAULT now() NOT NULL`。业务实体表用 `timestamps` helper(`created_at` + `updated_at` 一对);append-only 历史 / 事件表只用 `created_at`。Drizzle schema 审查时强制
- **禁止 AI 作者署名(MANDATORY)**:commit 署名禁 AI 工具名,`.husky/commit-msg` + PR CI 强制
- **PostgreSQL**:Drizzle + UUID + JSONB,积分扣费走 `db.transaction()`(扣费+记流水原子)
- **Redis 3 DB**:DB0 session/lock/rate-limit,DB1 BullMQ,DB2 Streams + Hocuspocus pub/sub。Key `{env}:{service}:{entity}:{id}`,**禁止无 TTL**,Stream MAXLEN ~10000
- **Auth 安全**:登录 5/分,注册 10/时,Google OAuth 10/分(Redis 滑窗)。NoAccount 仅 dev,prod 启动拒绝
- **XSS / Prompt**:HTML 渲染走 DOMPurify `sanitizeRichText()`;AIGC prompt 先经 `extractPromptText()` 去 HTML/注释/不可见字符
- **异常**:`AppError(status, msg)` 在 Service 层抛,路由层 handler 处理(NotFound / Conflict / Validation / Forbidden / Unauthorized)
- **SSE**:仅 Agent 聊天 + Text mini-tool,`data` 含 `userId` + `projectId`
- **存储**:Local / S3 / Aliyun OSS。前端走 presigned URL(`GET /assets/presign`,5min 过期,30/分限速)直传
- **支付(积分制非订阅)**:Stripe Checkout 一次性买积分包(5 档),**无会员 tier**。全用户同套功能,只按用量扣积分,积分永不过期。Webhook 幂等(CAS),`deductOnce(refKey)` 保证扣费幂等。`membershipType` / `membershipExpiresAt` 字段是历史遗留,**新代码只按积分余额判断,不做 tier feature gate**
- **服务器端工业级标准(MANDATORY)**:所有 server / collab / worker / core 逻辑按生产级标准实现,**禁止** "dev 阶段先这样后续再补"。**必须有**:

| 项 | 要求 |
|---|---|
| 错误日志(application 层) | **application 层(server route / collab hook / worker job handler 顶层)**所有 `catch` 必 `logger.error({ err, ctx })` 留可追溯链 — 因为只有 application 层知道 `userId` / `requestId` / `projectId` 等上下文,知道该返回什么给 client / 是否需要 alert;禁 silent fail / 裸 `catch (e) {}` |
| 错误日志(library 层禁) | **`@breatic/core` 和 `@breatic/shared` 不调用任何 `logger.*`(包括 `info` / `warn` / `error` / `debug`)**。两条规则:① 默认 `throw`(抛原 error 或 typed `AppError(NOT_FOUND, ...)` / `InfraNotReadyError` 等让上层 catch 时判定);② 无法继续 throw 的场景(HTTP/RPC handler 在 Node 物理 constraint 下必须 catch 否则进程崩;第三方 library 用 exception 表达业务正常态如 S3 `NotFound`),catch 后**返回给上层正确的事件类型 / sentinel**(`{ exists: false }` / `CheckResult{ok:false}` 等)让上层正确处理 — 这是业务转换不是 log。**library 函数体内出现任何 `logger.*` 调用一律违规**:audit log(`user_registered` / `payment_completed` 等)移到 application 层(server route handler 调完 service 后 log);Redis client `.on('error')` 等 EventEmitter listener 由 caller(application entry)attach 而不是 factory 内默认 attach |
| 进程生命周期(library 层禁) | **`@breatic/core` 和 `@breatic/shared` 不调用 `process.exit()` / 不主动终止进程**。library 知道"出错了"但不知道"该不该退" — 只有 application 层(每个 service entry)知道这个进程的生命周期决策(`server` 退就是 503 永不恢复;`worker` 退就是 BullMQ 重试链路;`collab` 退就是 hocuspocus 协作中断)。library 遇到"必须让上层中止进程"的场景(startup connectivity check 失败、env var 缺失等)**抛 typed error**(`InfraNotReadyError` 等),application entry 在 top-level `try/catch` 里接、log 上下文、`process.exit(1)`。`console.error` 也算 log,library 禁用 |
| Connection 健康 | DB(`postgres-js`)/ Redis(`ioredis`)/ 队列 client 必显式配置 `max_lifetime` / `idle_timeout` / `keepAlive` / `reconnectOnError`,**不靠 client 默认**(默认通常不 idle recycle → 长跑后 connection stale,query throw 但 pool 不知道)|
| Health check | 长跑 service(server / collab / worker)必有 `/healthz` endpoint ping 关键依赖(PG + Redis + 队列),LB / docker `healthcheck` 看 N 次 fail kill instance 滚动恢复 |
| 安全监控 | auth / 鉴权失败 / rate-limit 命中 / 异常 query / pool 耗尽 必有结构化日志(json + ctx);生产上报 metrics(error rate / connection pool size / acquire latency)看 trend 提前预警 |
| 守护 | critical path(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)必 alarm 链 + 自动重试 / 降级 fallback;process 收 SIGTERM 必 graceful shutdown(等 in-flight request 完成再退) |

写一行 `try { ... } catch (e) {}` 之前先问:**生产环境 3am 出问题,oncall 能从日志倒推到根因吗?** 答不能就停手,补 log + 监控再写

# 禁止清单

| # | 禁 |
|---|---|
| 1 | 路由层写业务 |
| 2 | Service import hono |
| 3 | Drizzle 类型泄漏 |
| 4 | 硬编码密钥 |
| 5 | `allow_origins: ["*"]` + credentials |
| 6 | 裸 SQL |
| 7 | 非原子积分扣减 |
| 8 | 裸 catch |
| 9 | `any` 类型 |
| 10 | 同步阻塞事件循环 |
| 11 | 公共函数缺 TSDoc |
| 12 | `var` / `require()` |
| 13 | YAML 中文 |
| 14 | AIGC sync 路径 |

# 编码行为准则

减少常见 LLM 编码错误的行为指南。这些准则偏向谨慎而非速度,简单任务自行判断。

## 1. 先想再写

**不假设,不隐藏困惑,主动暴露权衡。** 假设要明说;有多种理解就列选项让用户选,不要默默选一个;有更简单方案要说出来;有不清楚的就停下来问。

## 2. 简单优先

**写能解决问题的最少代码,不做推测性开发。** 不做超出要求的功能,单次使用不抽象,没人要的"灵活性 / 可配置"不加,不可能发生的场景不做错误处理。自检:"高级工程师会说这过度复杂吗?" 会就重写。

## 3. 精准修改

**只改必须改的,只清理自己造的废物。** 不"顺手改进"周围的代码 / 注释 / 格式,不重构没坏的东西。发现无关死代码,提一下不要删。**你的修改**导致无用的 import/变量/函数才删。检验标准:diff 每一行都应直接追溯到用户需求。

## 4. 目标驱动执行

**定义成功标准,循环直到验证通过。** 把任务转化成可验证目标("加验证"→"为非法输入写测试,然后让测试通过";"修 bug"→"写复现测试,然后让测试通过";"重构 X"→"确保重构前后测试通过")。多步任务声明简要计划:每步配验证方式。强标准让你能独立循环,弱标准("让它能跑")需要不断确认。

## 5. 彻底解决,禁止补丁(MANDATORY — 零容忍)

承接头号原则。**方案未经用户确认前不动代码**;方案不唯一时(含治本/治标取舍)列选项让用户选,不自己拍板;拿不准必须问,不猜、不"先实现一版试试";架构有根本缺陷就提架构变更,不打补丁;已有同类模式必须对齐,不发明半套。

**禁止补丁词汇**(任一即违规,立即停手):

| 类 | 词 |
|---|---|
| 兼容层 | compat shim · 兼容层 · 适配层 · legacy mirror · 只读镜像 |
| 跳过修复 | escape hatch · 全局 ref · 单例 |
| 拖延 | 临时 · 过渡 · 暂时 · 先这样 · 后续再改 |
| 范围回避 | 为了不改 N 个 callsite |
| 路径分裂 | 两条路径并存 · hybrid · 双写 |

**动手前三自检**(全过才写):(1) 解决根因还是压症状?(2) 唯一解还是从多个挑了一个?(3) 是否有任一"暂时/兼容/补丁"?

**发现自己写了补丁 → 立即撤回,不辩护、不找理由、不谈工作量。**

# Due Diligence (DD) — 重大决策纪律(MANDATORY)

**决策前的纪律**(跟决策后的 #1~#5 不互替)。完整流程 + 模板 + 反例见 [docs/DD-PROCESS.md](./docs/DD-PROCESS.md)。

**触发**(任一):

- **安全模型**(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)
- **跨界**(跨 ≥ 2 package 接口 / 数据模型 / 协议 / 关键 dep 增删升级)
- **已扩散**(已 merge 入 main / 已落 ADR 被引用 / 已发给用户)
- **架构 / 长期维护**(整体目录结构 / 公共 API / 跨服务边界)

breatic 高频:AIGC provider 选型 · Agent / Skill 定义 · 三层记忆 / Yjs 结构 · 积分计费。

**硬流程**:候选枚举 → 5 维度尽调(实测 / 源码 / 治理 / 安全 / 上游)→ 对比矩阵(每格证据可追溯)→ 推荐 + 理由 → **用户拍板**。

**反 DD 模式**(违规):浅表决策(star / "感觉")· hearsay(AI 对话当 ground truth)· 假对比(候选不全)· 单点论据 · "先用 X 后续再换"(同 #5 补丁)。**未做 DD 就动手 = 当场撤回**(同 #5)。

**轻量 vs 完整**:候选明显 / 单文件 util → 轻量 Research(GitHub search 等);触发命中 → 必须完整 DD。

# Test-Driven Development (TDD) — AI coding 时代(MANDATORY)

业界共识(Anthropic / Kent Beck):TDD 在 AI 时代是关键纪律,但 AI 引入"作弊 / false confidence"风险需专门防御。完整 anti-pattern + invariant 工具见 [docs/TDD-MANDATE.md](./docs/TDD-MANDATE.md)。

**3 条硬约束**(零容忍):

1. **修 bug 必须先写复现测试**(违反 = 同 #5)
2. **重构前测试必须 green**
3. **禁止 AI 通过删除 / 禁用测试通过**(CI 监控 test 总数下降)

**节奏**:红(具体 assertion,禁 `toBeDefined()` 等 weak)→ 绿(最小实现)→ 蓝(重构 + 跑全套)。原型 / 探索期允许后置 test。

**关键路径**(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)→ 100% 覆盖 + 显式 invariant + property-based(`fast-check` / `hypothesis`)。**关键路径裸奔 = P0 BUG**(整体覆盖 < 80% 不 hard block,关键路径必须满)。
