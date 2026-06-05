# 头号原则(MANDATORY)

> 解决问题要找根因 — 不在症状上贴补丁,不"先这样后续再改",不拿"工作量大 / 时间紧"当借口。

每个 PR 动手前回答:**这个修改是在解决根因,还是在压住症状?** 答不上来停下来,重新想,或者问用户。

解决后再问:**真的解决了根本问题,还是把症状搬到了别处 / 把问题往后拖了一步 / 让自己看起来像解决了?** 答错就停,先跟用户沟通。

**每次完成任务必须测试 + 同步所有受影响文档:**

| 项 | 内容 |
|---|---|
| 测试 | typecheck + 单测 + smoke / e2e / 浏览器交互。做不了要 explicit 说明,不许跳过。**smoke / e2e 操作规范见 [docs/TEST-MANDATE.md](./docs/TEST-MANDATE.md)**(测试五层 / smoke 定义 / 关键路径 E2E / 边界)|
| 文档 | ROADMAP / spec / `docs/*` 等所有受影响项。**落后文档比没文档更糟** |

**所有任务必须先列 todo 计划,按计划执行,完成后对照复核**。不分 research / 执行 / 测试 / 文档,**也不分大小** — 哪怕一两步也写。**取消"小任务豁免"**:小任务也写、也复核。

# 项目简介

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo,7 包 + 3 服务。

**架构详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**(backend 全部技术栈 / 包依赖 / 3 服务 / 画布协作 / 三层记忆 / SubAgent / Worker / Mini-Tool / Skill / Agent tools / 配置 / 日志)。**前端详见 [docs/ARCHITECTURE.md#frontend](./docs/ARCHITECTURE.md#frontend)**(技术栈 / 7 层 layered / 节点模型 / 命名规范 / 路由)。

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

- **函数定义格式规范(MANDATORY)**:命名函数单元(函数声明 / 类方法 / 类 / 变量赋值的箭头·函数表达式)必须有 TSDoc 文档注释 + 显式返回类型 + `@throws {ErrorType}` 异常类型;类型信息归签名(显式)、注释禁写类型,唯异常类型签名表达不了归注释。**不分导出 / 私有**(规则只有 0/1);内联匿名回调 + 测试豁免。详见 [docs/ARCHITECTURE.md#coding-standards-function-definition-format](./docs/ARCHITECTURE.md#coding-standards-function-definition-format)
- **文件头版权声明(MANDATORY)**:每个首方 TypeScript 源文件(`packages/*/src/**/*.{ts,tsx}`,含测试)顶部必须有 SPDX 双行头(`// Copyright (c) 2026 Orime, Inc.` + `// SPDX-License-Identifier: LicenseRef-BOSL-1.0`);shadcn vendor(`web` 的 `components/ui/`)豁免(第三方 IP,不挂 Orime 版权)。CI `lint:no-missing-license-header` 强制;一次性补全走 `scripts/add-license-headers.sh`(幂等)。详见 [docs/ARCHITECTURE.md#coding-standards-function-definition-format](./docs/ARCHITECTURE.md#coding-standards-function-definition-format)
- TypeScript strict,禁止 `any`(用 `unknown`),禁止 `var`/`require`
- ESLint + eslint-plugin-jsdoc 强制(`recommended-typescript-error` + require-jsdoc 全量 + explicit-function-return-type)
- 前端命名规范见 [docs/ARCHITECTURE.md#naming-conventions](./docs/ARCHITECTURE.md#naming-conventions)
- 前端 layered 架构以 `app → pages → spaces → features → stores → domain → data → ui` 单向依赖(详见 [docs/ARCHITECTURE.md#layered-architecture](./docs/ARCHITECTURE.md#layered-architecture))

# 关键规范

- **`@shared` vs `@core` 内容归属(MANDATORY)**:`@breatic/shared` = **web + 后端共用**的东西,**必须浏览器安全**(零 `node:*` / `fs` / `async_hooks` 等依赖,`sideEffects: false`);`@breatic/core` = **仅后端共用**(可用 node API)。判定题:**web 用得到吗?用得到 → `shared`;用不到 → `core`**。后端专用的东西(doc-name 构造、node i18n 适配器等)放 `core`,不许塞进 `shared`。`shared` 单入口(`tsup src/index.ts` 全 bundle),不开多 subpath 入口——多入口会把内部别名 `@shared/*` 泄漏进 dist 解析不了
- **后端两个维度:包归属 + 包内分层(MANDATORY)**:**① 包归属(看「谁用」,决定进哪个包)** —— `@breatic/core` = 全后端(含 collab)共享内核(基础设施 / DB schema / 跨服务事件 / 统一鉴权);`@breatic/domain` = 只 server+worker 共享、collab 永不碰的 AIGC 业务(积分花 / 任务 / 节点历史 / agent / model-catalog / canvas-lock);**只一个服务用 → 那个服务**(如 `server/src/modules/`)。判定题:collab 用 且 ≥1 其他后端也用(鉴权 / 会话 / 角色 / 成员事件)· 或 基础设施 / 共享 DB schema / 跨服务事件 → core;只 server+worker 用 → domain;只一个服务用 → 那个服务。**core / domain 都不是业务的默认堆放处**。依赖图 `shared ← core ← {domain, collab};domain ← server / worker`。**② 包内分层(看「翻译还是写业务」,决定进哪一层)** —— 路由层(server route / worker handler / collab hook)只把协议翻译成业务调用、**不写领域业务**(禁止清单 #1);领域 service 层写业务逻辑、**不 import 协议框架**(禁止清单 #2)。**两维度正交不冲突**(例「只 server 用的业务」= 包归属在 server + 写在 server 的 service 层而非 route 层)。**一张表一个 repo 家**:一张表的数据访问(repo)只在一个模块,service 调 repo、不写 SQL。跨服务通信:同步要答案 → 函数调用(类型安全);异步 / 跨进程 / 扇出 → Redis 事件(数据契约在 core/shared)。CI 强制(`lint:dependency-cruiser` 声明式规则):`library-no-app-import`(core / shared / domain 出现 import `@server` / `@worker` / `@collab` / `@web` 即 fail)+ `collab-no-domain-import`(collab import `@breatic/domain` 即 fail)。每个包根有独立 `CLAUDE.md` 写该包的角色 + 可 import 谁 + 暴露啥 + 怎么拿配置。细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **环境变量注入(MANDATORY)**:`@breatic/core` / `@breatic/shared` / `@breatic/domain` **不读 `process.env`、不 load `.env`**(配置 ACQUISITION 是 application 决策,同 logger / `process.exit()` 的 library 边界原则)。**application entry(server / worker / collab = composition root)**启动时第一件事 `dotenv` + `initCore(process.env)` 一次,core 的 **zod schema** 校验后存住;library 经 **`env` Proxy / `getConfig()` / `getRawEnvVar()`** 读注入的配置,源码零 `process.env`。**db / Redis / LLM provider / logger 全延迟单例**(模块 import 时不读 env,首次用时才建,确保 `@breatic/core` barrel 在 `initCore` 前可安全 import)。3 个 healthz 端口(`SERVER_HEALTH_PORT` 3001 / `WORKER_HEALTH_PORT` 9101 / `COLLAB_HEALTH_PORT` 1235)统一进 core schema,从 `env.*` 读;`PATH` / `HOME` **不入 schema**(自动继承宿主,agent 脚本沙箱经 `getRawEnvVar` 取)。`lint:no-core-process-env` CI 强制(`src/` 出现任何 `process.env` 即 fail;`process.cwd()` 不算)。entry 读 env 是 composition root 的本职,不算违规
- **软删除(MANDATORY)**:所有表用 `deleted_at` 标记,FK `restrict`,list 默认过滤 `deleted_at IS NULL`。**禁止硬删除**(GDPR 删号走单独流程)
- **`created_at`(MANDATORY)**:所有 PG 表必须有 `created_at timestamp with time zone DEFAULT now() NOT NULL`。业务实体表用 `timestamps` helper(`created_at` + `updated_at` 一对);append-only 历史 / 事件表只用 `created_at`。Drizzle schema 审查时强制
- **禁止 AI 作者署名(MANDATORY)**:commit 署名禁 AI 工具名,`.husky/commit-msg` + PR CI 强制
- **语言(MANDATORY)**:breatic 是全球开源项目,贡献者来自世界各地 → **代码 + 注释必须英文**(给人读,方便全球协作)。三类例外可非英文:① i18n 多语言文案(`locales/*.json` + 语言原生名等故意产品数据)· ② 测试 fixtures(`*.test.*` / `__tests__/` 的 Unicode / locale 测试逻辑)· ③ `lint:no-cjk` allowlist 里的故意产品数据字符串。**规范文档(`CLAUDE.md` / `docs/*` / 各包 `CLAUDE.md` 等 `.md`)是给机器(AI)读的,中文 OK、不强制英文** —— 代码给人看(英文)、文档给机器读(中文)是两个层面。判定题:**这内容会编译进产物 / 被开发者直接读吗?会 → 英文(代码 + 注释);只是给 AI 读的规范说明 → 中文 OK**。`lint:no-cjk` CI 强制(扫 `.ts/.tsx/.css` 含注释 + `.yaml/.yml` 配置 + `scripts/*.sh` 守卫脚本;唯 `lint-no-cjk.sh` 自身因内含 CJK 检测正则而排除)
- **PostgreSQL**:Drizzle + UUID + JSONB,积分扣费走 `db.transaction()`(扣费+记流水原子)
- **Redis 3 DB**:DB0 session/lock/rate-limit,DB1 BullMQ,DB2 Streams + Hocuspocus pub/sub。Key `{env}:{service}:{entity}:{id}`,**禁止无 TTL**,Stream MAXLEN ~10000
- **Auth 安全**:登录 5/分,注册 10/时,Google OAuth 10/分(Redis 滑窗)。NoAccount 仅 dev,prod 启动拒绝
- **XSS / Prompt**:HTML 渲染走 DOMPurify `sanitizeRichText()`;AIGC prompt 先经 `extractPromptText()` 去 HTML/注释/不可见字符
- **异常**:`AppError(status, msg)` 在 Service 层抛,路由层 handler 处理(NotFound / Conflict / Validation / Forbidden / Unauthorized)
- **SSE**:仅 Agent 聊天 + Text mini-tool,**per-request 私有流**(前端 `fetchEventSource` POST,每次请求各开各的流、靠回调对账)。**事件 `data` 不携带归属 ID** —— 对话归属由 `conversations` 表的 `user_id` / `project_id` 列兜底(SSE 片段不落库、前端不读、每 chunk 重复 = 冗余无消费方);要审计单次操作走 application 层 `logger`,不塞进 wire
- **存储**:Local / S3 / Aliyun OSS。前端走 presigned URL(`GET /assets/presign`,5min 过期,30/分限速)直传
- **支付(积分制非订阅)**:Stripe Checkout 一次性买积分包(5 档),**无会员 tier**。全用户同套功能,只按用量扣积分,积分永不过期。Webhook 幂等(CAS),`deductOnce(refKey)` 保证扣费幂等。**只按积分余额判断,不做 tier feature gate**
- **服务器端工业级标准(MANDATORY)**:所有 server / collab / worker / core 逻辑按生产级标准实现,**禁止** "dev 阶段先这样后续再补"。**必须有**:

| 项 | 要求 |
|---|---|
| 错误日志(application 层) | **application 层(server route / collab hook / worker job handler 顶层)**所有 `catch` 必 `logger.error({ err, ctx })` 留可追溯链 — 因为只有 application 层知道 `userId` / `requestId` / `projectId` 等上下文,知道该返回什么给 client / 是否需要 alert;禁 silent fail / 裸 `catch (e) {}` |
| 错误日志(library 层禁) | **`@breatic/core` / `@breatic/shared` / `@breatic/domain` 不调用任何 `logger.*`(包括 `info` / `warn` / `error` / `debug`)或 `console.*`**。两条规则:① 默认 `throw`(抛原 error 或 typed `AppError(NOT_FOUND, ...)` / `InfraNotReadyError` 等让上层 catch 时判定);② 无法继续 throw 的场景(HTTP/RPC handler 在 Node 物理 constraint 下必须 catch 否则进程崩;第三方 library 用 exception 表达业务正常态如 S3 `NotFound`),catch 后**返回给上层正确的事件类型 / sentinel**(`{ exists: false }` / `CheckResult{ok:false}` 等)让上层正确处理 — 这是业务转换不是 log。**library 函数体内出现任何 `logger.*` 调用一律违规**:audit log(`user_registered` / `payment_completed` 等)移到 application 层(server route handler 调完 service 后 log);Redis client `.on('error')` 等 EventEmitter listener 由 caller(application entry)attach 而不是 factory 内默认 attach。`lint:no-library-logger`(扫 core / shared / domain,含 `console.*`)CI 强制 |
| 进程生命周期(library 层禁) | **`@breatic/core` / `@breatic/shared` / `@breatic/domain` 不调用 `process.exit()` / 不主动终止进程**。library 知道"出错了"但不知道"该不该退" — 只有 application 层(每个 service entry)知道这个进程的生命周期决策(`server` 退就是 503 永不恢复;`worker` 退就是 BullMQ 重试链路;`collab` 退就是 hocuspocus 协作中断)。library 遇到"必须让上层中止进程"的场景(startup connectivity check 失败、env var 缺失等)**抛 typed error**(`InfraNotReadyError` 等),application entry 在 top-level `try/catch` 里接、log 上下文、`process.exit(1)`。`console.error` 也算 log,library 禁用(归 `lint:no-library-logger` 守卫)。`lint:no-library-process-exit`(扫 core / shared / domain)CI 强制 |
| 环境变量(library 层禁) | **`@breatic/core` / `@breatic/shared` / `@breatic/domain` 不读 `process.env` / 不 load `.env`**(配置 ACQUISITION 是 application 决策,跟 logger / `process.exit()` 同一条 library 边界)。**entry(server / worker / collab)**第一件事 `dotenv` + `initCore(process.env)`,core 的 zod schema 校验后存住;library 经 **`env` Proxy / `getConfig()` / `getRawEnvVar()`** 读注入的配置。**db / Redis / LLM provider / logger 必延迟单例**(import 时不读 env;首次用时建),否则 `@breatic/core` barrel 在 `initCore` 前被 import 就抛。healthz 端口进 core schema 从 `env.*` 读;`PATH` / `HOME` 不入 schema(继承宿主,沙箱经 `getRawEnvVar`)。`lint:no-core-process-env` 强制 |
| Connection 健康 | DB(`postgres-js`)/ Redis(`ioredis`)/ 队列 client 必显式配置 `max_lifetime` / `idle_timeout` / `keepAlive` / `reconnectOnError`,**不靠 client 默认**(默认通常不 idle recycle → 长跑后 connection stale,query throw 但 pool 不知道)|
| Health check | 长跑 service(server / collab / worker)必有 `/healthz` endpoint ping 关键依赖(PG + Redis + 队列),LB / docker `healthcheck` 看 N 次 fail kill instance 滚动恢复 |
| 安全监控 | auth / 鉴权失败 / rate-limit 命中 / 异常 query / pool 耗尽 必有结构化日志(json + ctx);生产上报 metrics(error rate / connection pool size / acquire latency)看 trend 提前预警 |
| 守护 | critical path(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)必 alarm 链 + 自动重试 / 降级 fallback;process 收 SIGTERM 必 graceful shutdown(等 in-flight request 完成再退) |

写一行 `try { ... } catch (e) {}` 之前先问:**生产环境 3am 出问题,oncall 能从日志倒推到根因吗?** 答不能就停手,补 log + 监控再写

- **前端工业级标准(MANDATORY)**:`web` 同样按生产级实现,跟后端一个门槛,**禁止** "原型先这样后续再补"。整体约束:TS strict 零 `any` · layered 单向依赖(`app → pages → spaces → features → stores → domain → data → ui`)· 关键路径 / invariant(StrictMode-safe resource hook、Yjs 协作、optimistic update race 等)100% test · a11y(语义 HTML / focus-visible / 键盘可达)· i18n(ICU,5 locale,禁硬编码文案)· 设计 token 严格(禁 raw brand / 静态 palette,走语义 token;`lint:no-brand-usage` CI 强制,studio 容器是单色规矩唯一例外)· 视觉改动必有 ground truth + 小批 ship + 真浏览器 verify。**细节实现规范见 [docs/ARCHITECTURE.md#frontend](./docs/ARCHITECTURE.md#frontend)**(命名 / 节点模型 / token 桥接 / shadcn vendor 边界 / 各 trap)

- **CLAUDE.md ↔ 细节文档边界(MANDATORY)**:**CLAUDE.md 写 mandate(整体约束 + 红线 + 判定题),不写实现细节**;细节落 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)(Backend 后端 / 跨服务 / 数据流 · Frontend 前端实现 · Coding standards 函数定义规范,三部分合一)。判定题:**这是"必须遵守的约束"还是"怎么做的细节"?** 约束 → CLAUDE.md;细节 → ARCHITECTURE.md。CLAUDE.md 提到某机制时只给一句 mandate + 指向细节文档的链接,不复制细节(细节会 drift,两处维护必失同步)

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
| 11 | 命名函数缺 TSDoc / 显式返回类型(详见 [coding-standards](./docs/ARCHITECTURE.md#coding-standards-function-definition-format))|
| 12 | `var` / `require()` |
| 13 | YAML 中文 |
| 14 | AIGC sync 路径 |
| 15 | 非测试代码用相对路径 import(`./` / `../`)— 一律走 path alias:每个包用**全局唯一前缀** `@shared` / `@core` / `@domain` / `@collab` / `@worker` / `@server` / `@web`,**全项目无 `@/`**(规则零例外:任一包源码被另一包 resolution 上下文 import 时,`@/` 会撞车,唯一前缀消除歧义)。测试代码豁免。CI `lint:no-relative-import` 强制 |

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
