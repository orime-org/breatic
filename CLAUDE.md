# 头号原则(MANDATORY)

> 解决问题要找根因。
> 解决问题要找根因。
> 解决问题要找根因。

不要在症状上贴补丁。不要"先这样后续再改"。不要把"工作量大""时间紧"当借口跳过根因分析。每个 PR 动手前先回答:**这个修改是在解决根因,还是在压住症状?** 答不上来就停下来,重新想,或者问用户。

**解决完毕,再次问自己:这次的修改是不是真的解决了根本问题?** 还是只是把症状从一个地方搬到了另一个地方 / 把问题往后拖了一步 / 让自己看起来像解决了?
答不上来或者答案是后者,停下先跟用户沟通。

# 项目简介

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo，6 个包 + 3 个运行时服务。

# 技术栈

Node.js 22+ | TypeScript 5.x | pnpm | Turborepo | Hono | Drizzle ORM | PostgreSQL (postgres.js) | ioredis | BullMQ | Vercel AI SDK | Hocuspocus 3.4.4 | Zod | Vitest | pino + pino-roll

# 开发命令

```bash
# 本地：首次复制 .env.dev → .env，docker 起 PG+Redis，pnpm db:migrate；之后 pnpm dev
# Docker 全量：复制 .env.docker → .env，改域名/密钥，docker compose up -d
pnpm dev              # turbo 跑全部服务（自动先 build shared/core，再 watch server/worker/collab）
pnpm db:migrate       # 拉新 migration 后跑
pnpm test / typecheck / lint
```

启动时先 `checkInfraReady()` 验证 PG/Redis 可达；连不上立即退出（避免无声挂死）。Migration 是独立步骤，不绑在 dev 启动里。

# 目录结构

```
packages/
├── shared/   # Zod schema + 类型 + 常量(零依赖)
├── core/     # 业务逻辑(barrel @breatic/core)
│   modules/(*.repo.ts + *.service.ts) · agent/(MainAgent + skills-loader) ·
│   db/(schema.ts 19 表) · infra/(redis/pubsub/queue/storage/stripe) · config/
├── server/   # HTTP 壳(Hono):routes/(auth/chat/canvas/mini-tools/projects/skills/tasks/payment/health) + middleware/
├── worker/   # BullMQ 壳:handlers/(5 条路径) + providers/(image/video/audio/tts/three-d/understand)
├── collab/   # Hocuspocus 独立进程:server/auth/persistence/event-stream/task-listener
└── web/      # React + ReactFlow + Yjs(内部 layered:ui/data/domain,详见 docs/FRONTEND.md)
config/ agents/ skills/ locales/ uploads/(git-ignored)
```

**包依赖方向**:`shared(零依赖) ← core, collab(独立进程,只依赖 shared) ← server / worker / web`。**严格边界**:server 不 import worker,worker 不 import server,所有共享业务逻辑在 core。

**Package exports**:shared/core 导出 `./dist/index.js`(行业标准),本地和 Docker 统一走编译产物。路径解析通过 `MONOREPO_ROOT`(向上查找 `pnpm-workspace.yaml`)。

# 架构

## 3 个服务

| 服务 | 端口 | 职责 |
|------|------|------|
| API | 3000 | HTTP 请求 + Agent 聊天 SSE + Text mini-tool SSE |
| Collab | 1234 | Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点 |
| Worker | — | BullMQ 任务执行 → 存 DB → Redis Streams publish NodeEvent → Collab 写 Yjs |

## 画布协作

- 节点 create/delete + position 由**前端独占**；后端只能改 `data` 字段（state/content 等）
- 画布走 Yjs，Agent 聊天走 SSE。无锁：每次 mini-tool 操作产生新兄弟节点（edge 连接），不覆盖源节点
- 事件总线：Redis Streams `${env}:stream:canvas-nodes`（`NodeStateUpdateEvent`，支持 `targetNodeIds: string[]` 1:N），Collab 消费后写 Yjs
- 文档命名 v10 multi-doc：`project-{id}/meta`（含 spaces 列表）+ `project-{id}/canvas-{spaceId}`（每个 Canvas Space 一个）
- 节点状态机：`idle` / `handling`（均在 Yjs）；`localPending` 是本地 React state；失败 = `idle` + `errorMessage`
- Yjs 持久化走 PG `yjs_documents` 表（Hocuspocus Database extension）；跨实例同步走 Redis pub/sub（Hocuspocus Redis extension）
- 节点结构 + 字段归属 + 状态机详细规范见 [docs/YJS.md](./docs/YJS.md)

## 三层记忆 + Turn 压缩

| 层 | 作用域 | 表 |
|---|---|---|
| User | 跨项目偏好 | `user_memories` |
| Project | 协作者共享 | `project_memories` |
| Conversation | 当前对话摘要 | `conversation_memories` |

- **Turn 机制**：每条消息带 `turnIndex`（`role=user` 时递增）。`memory_window`（默认 20）按 Turn 计数，超出时自动归纳旧 Turn 到记忆摘要
- **Context 压缩**：最近 `full_detail_turns`（默认 3）个 Turn 保留完整 step（tool_call + tool_result），更早 Turn 只保留 user + assistant 最终回复。`thinking` 字段永远不发回 LLM
- **消息存储**：`conversations.messages` JSONB 数组，含 `turnIndex`、`thinking?`、`tool_calls?: ToolCallInfo[]`。原始消息不删除，归纳只生成摘要

## SubAgent（spawn tool）

SubAgent 通过 `spawn({ task, agent, skill? })` 调用。每个 Agent 是 `agents/*.md` 中定义的角色（frontmatter: name, description, tools, model, skills + body: system prompt）。Skill 是可选的知识补充（`skills/` 目录）。

**Agent 定义角色（谁来做），Skill 定义知识（怎么做）。** 两者正交、可组合。

内置 4 个 Agent：`researcher`（搜索参考）| `prompt_optimizer`（提示词优化）| `analyst`（多模态分析）| `planner`（项目规划）。

Tools 取并集：Agent 声明的 tools ∪ Skill 声明的 tools，始终排除 spawn（防递归）。SubAgent 通过 `AsyncLocalStorage` 继承请求上下文（三层记忆 + 压缩对话历史 + userId），在内部直接扣费。

## 任务执行（Worker 5 条路径）

1. **AIGC Mini-Tool**（source="mini_tool"）→ toolName 查表 → provider 直调
2. **Understand**（task_type="understand"）→ 多模态理解 / ASR 转写
3. **AIGC 直达**（image/audio/video/3d/tts）→ provider `generateAsync()`
4. **Skill（显式）** → 指定 skillName → AI SDK Agent 执行
5. **Skill（自动选）** → 按 category 合并 Skills → LLM 选

## Mini-Tool（两种模式）

| | AIGC (image/video/audio) | Text |
|---|---|---|
| Endpoint | `POST /mini-tools/{image\|video\|audio}` | `POST /mini-tools/text` |
| 执行 | BullMQ Worker（异步） | API 直接 streamText（同步 SSE） |
| 结果交付 | Redis → Hocuspocus → Yjs（协作者可见） | SSE 流给请求者（私有，接受后才写 Yjs） |
| 用户交互 | 等待 → 结果出现 | 打字机效果，可随时 abort |
| 积分 | 按 API cost | 按 token 消耗 |
| 并发 | Worker concurrency 控制 | 每用户 1 个（Redis 锁） |

Text 工具（10 个）：polish / expand / summarize / translate / rewrite / continue / generate / character / storyboard / script。操作类发完整 `document` + `selection` 保证上下文。自动匹配输入语言回复。

## Skill 系统

**两区边界**：Agent（多轮对话，注入上下文）| Canvas（Worker 单次执行，必须生成）。文本编辑器（TipTap）独立运行，不使用 Skill。

**metadata.json**：仅 `name` / `description` 必填；其他字段（`scope`/`category`/`tools`/`output_type`/`requires`/...）`skills-loader.ts` 都有 default 兜底（`scope` 默认 `["agent"]`，`category` 默认 `"default"`）。建议显式填 `scope`/`category` 避免读代码才知行为。完整字段表见 [docs/PRODUCT.md §6.2](./docs/PRODUCT.md#62-metadatajson-specification)。禁用 npm 字段（version/author/license/engines/files/main）。

## Agent Tools（9 个）

`run_script` | `read_file` | `write_file` | `edit_file` | `list_dir` | `web_search` | `web_fetch` | `ask_user_question` | `spawn`

**无通用 shell 执行器**。`run_script` 只能执行 `skills/{name}/scripts/` 下的脚本，路径防穿越，按扩展名选解释器（.py → python3, .sh → sh, .js → node）。

# 配置

| 文件 | 用途 |
|------|------|
| `.env` | 运行时配置（从 `.env.dev` 或 `.env.docker` 复制） |
| `.env.dev` | 本地开发模板（localhost URLs） |
| `.env.docker` | Docker 部署模板（容器名 URLs） |
| `config/agent.yaml` | Agent 模型、归纳模型、loop 次数、memory Turn 窗口（20）、Turn 压缩（3） |
| `config/text-tools.yaml` | Text mini-tool 模型 |
| `config/worker.yaml` | Worker 并发、重试、轮询 |
| `config/collab.yaml` | Hocuspocus debounce、限流、文档大小限制 |
| `config/pricing.yaml` | 积分**购买包**(5 档一次性购买,不是订阅/会员,test+live Stripe ID) |
| `config/models/*.yaml` | AI 模型路由（46 文件，model-centric） |

# 日志

每个服务独立日志目录，pino-roll 每日轮转：

| 服务 | 目录 | 初始化 |
|------|------|--------|
| API | `logs/api/` | 默认 `initLogger("api")` |
| Worker | `logs/worker/` | 入口显式 `initLogger("worker")` |
| Collab | `logs/collab/` | 独立 logger（不依赖 core） |
| Nginx | `logs/nginx/` | logrotate，30 天保留 |

每条日志双时间戳：`timestamp`（ISO 8601）+ `time`（epoch ms）。

# 代码风格

- TSDoc（`@param`, `@returns`, `@throws`, `@example`），公共 API 必须有
- TypeScript strict，禁止 `any`（用 `unknown`），禁止 `var`/`require`
- ESLint + eslint-plugin-tsdoc 强制

## Web 命名规范（`packages/web/src/`）

| 文件类型 | 命名 | 例 |
|---|---|---|
| React 组件 `.tsx` | `PascalCase`（= export 名） | `Button.tsx` `ProjectMembersPanel.tsx` |
| React Hook `.ts/.tsx` | `useFooBar`（= export 名） | `useProjectSpaces.ts` `useCanvasActions.ts` |
| 其他 `.ts`（util / data / config / store） | `kebab-case` | `mini-tools.ts` `oss-client.ts` |
| 测试 | 与主文件同名加 `.test` | `useProjectSpaces.test.ts` |
| 目录 | `kebab-case` | `data/yjs/` `domain/space/` `features/project-members/` |

详细前端架构（layer 划分、目录结构、Yjs 集成）见 [docs/FRONTEND.md](./docs/FRONTEND.md)。

# 关键规范

- **软删除(MANDATORY)**:所有表用 `deleted_at` 标记,FK `restrict`,list 默认过滤 `deleted_at IS NULL`。**禁止硬删除**(GDPR 删号走单独流程)
- **禁止 AI 作者署名(MANDATORY)**:commit 署名禁 AI 工具名,`.husky/commit-msg` + PR CI 强制
- **PostgreSQL**:Drizzle + UUID + JSONB,积分扣费走 `db.transaction()`(扣费+记流水原子)
- **Redis 3 DB**:DB0 session/lock/rate-limit,DB1 BullMQ,DB2 Streams + Hocuspocus pub/sub。Key `{env}:{service}:{entity}:{id}`,**禁止无 TTL**,Stream MAXLEN ~10000
- **Auth 安全**:登录 5/分,注册 3/时,Google OAuth 10/分(Redis 滑窗)。NoAccount 仅 dev,prod 启动拒绝
- **XSS / Prompt**:HTML 渲染走 DOMPurify `sanitizeRichText()`;AIGC prompt 先经 `extractPromptText()` 去 HTML/注释/不可见字符
- **异常**:`AppError(status, msg)` 在 Service 层抛,路由层 handler 处理(NotFound / Conflict / Validation / Forbidden / Unauthorized)
- **SSE**:仅 Agent 聊天 + Text mini-tool,`data` 含 `userId` + `projectId`
- **存储**:Local / S3 / Aliyun OSS。前端走 presigned URL(`GET /assets/presign`,5min 过期,30/分限速)直传
- **支付(积分制非订阅)**:Stripe Checkout 一次性买积分包(5 档),**无会员 tier**。全用户同套功能,只按用量扣积分,积分永不过期。Webhook 幂等(CAS),`deductOnce(refKey)` 保证扣费幂等。`membershipType` / `membershipExpiresAt` 字段是历史遗留,**新代码只按积分余额判断,不做 tier feature gate**

# 禁止清单

路由层写业务 | Service import hono | Drizzle 类型泄漏 | 硬编码密钥 | `allow_origins: ["*"]` + credentials | 裸 SQL | 非原子积分扣减 | 裸 catch | `any` 类型 | 同步阻塞事件循环 | 公共函数缺 TSDoc | `var` / `require()` | YAML 中文 | AIGC sync 路径

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

## 5. 彻底解决，禁止补丁(MANDATORY — 零容忍)

**定位根因,提彻底方案。方案不彻底 = 违规,**给出不彻底方案就是对用户时间的犯罪。

**硬性规则**:方案未经用户确认前不动代码;方案不唯一时(含治本/治标取舍)列选项让用户选,不自己拍板;自己拿不准必须问,不猜、不"先实现一版试试";架构有根本缺陷就提架构变更,不打补丁;已有同类模式(主 canvas / Yjs / undo)必须对齐,不发明半套。

**禁止补丁词汇**(任一即违规,立即停手):"compat shim / 兼容层 / 适配层"、"legacy mirror / 只读镜像"、"escape hatch / 全局 ref / 单例"、"临时/过渡/暂时/先这样/后续再改"、"为了不改 N 个 callsite"、"两条路径并存 / hybrid / 双写"。出现上面任意词 = 方案不彻底,回到白板重想。

**动手前三自检**(全通过才写):(1) 解决根因还是压症状?(2) 唯一解还是从多个挑了一个?(3) 是否有任一"暂时/兼容/补丁"?任一 fail 都停下来重想或问用户。

**发现自己写了补丁 → 立即撤回,不辩护、不找理由、不谈工作量。**

# Due Diligence (DD) — 重大决策纪律(MANDATORY)

**决策前的纪律**(跟决策后的 #1~#5 不互替)。完整流程见 [docs/DD-PROCESS.md](./docs/DD-PROCESS.md)。

**触发**(任一):安全模型 / 长期维护负担 / 跨包接口 / 反悔代价 > 1 周。breatic 高频:AIGC provider 选型 / Agent-Skill 定义 / 三层记忆 / Yjs 结构 / 积分计费。

**5 步硬流程**:候选枚举 → 5 维度尽调(实测 / 源码 / 治理 / 安全 / 上游)→ 对比矩阵(每格证据可追溯)→ 推荐 + 理由 → **用户拍板**。

**反 DD 模式**(违规):浅表决策(star / "感觉")· hearsay(AI 对话当 ground truth)· 假对比(候选不全)· 单点论据 · "先用 X 后续再换"(同 #5 治标补丁)。**未做 DD 就动手 = 违反纪律 = 当场撤回**(同 #5)。

**轻量 vs 完整**:小变化(单文件 util / 候选明显)→ 走 GitHub search 等轻量 Research;触发条件命中 → 必须完整 DD。报告:`docs/dd/<YYYY-MM-DD>-<topic>.md`(公开技术选型);敏感内容放私有 channel。

# Test-Driven Development (TDD) — AI coding 时代版(MANDATORY)

业界共识(Anthropic 官方 / Kent Beck):**TDD 在 AI 时代是关键纪律**,但 AI 引入"作弊 / false confidence"风险需专门防御。完整细节见 [docs/TDD-MANDATE.md](./docs/TDD-MANDATE.md)。

**5 条硬约束**(零容忍):(1) 修 bug 必须先写复现测试(违反 = 同 #5);(2) spec 由 audit / 人写,test code 由 dev 写(Writer/Reviewer 反闭环);(3) 重构前测试必须 green;(4) 禁止 AI 通过删除 / 禁用测试通过(CI 监控 test 总数 > 10% 下降 alert);(5) 单一 AI session 不能同时写 spec + test + 实现(强制反闭环)。

**节奏**:红(具体 assertion,禁 `toBeDefined()` 等 weak assertion)→ 绿(最小实现)→ 蓝(重构 + 跑全套)。原型/探索期允许后置 test。

**关键路径**(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)→ 100% 覆盖 + 显式 invariant + property-based(`fast-check` / `hypothesis`)。**关键路径裸奔 = P0 BUG**(覆盖率 < 80% 不是 hard block,但关键路径必须满)。
