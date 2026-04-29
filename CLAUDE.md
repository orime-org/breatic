# 项目简介

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo，6 个包 + 3 个运行时服务。

# 技术栈

Node.js 22+ | TypeScript 5.x | pnpm | Turborepo | Hono | Drizzle ORM | PostgreSQL (postgres.js) | ioredis | BullMQ | Vercel AI SDK | Hocuspocus 3.4.4 | Zod | Vitest | pino + pino-roll

# 开发命令

```bash
# 本地开发（首次或拉取新 migration 后）
docker compose up -d postgres redis
cp .env.dev .env                       # 首次
pnpm db:migrate                        # 首次或有新 migration 时

pnpm dev              # turbo 启动所有服务（自动先 build shared/core）
pnpm dev:collab       # Hocuspocus (port 1234)
pnpm dev:worker       # BullMQ Worker

# Docker 全量部署
cp .env.docker .env        # 首次，改域名和密钥
docker compose up -d       # migrate 容器先跑，再启动 6 个服务

# 质量检查
pnpm test             # 单元测试 (mock，无需外部依赖)
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
```

> **启动行为**：服务（API/Worker/Collab）启动时先调 `checkInfraReady()` 验证 PG/Redis 可达，连不上**立即退出**并打印清晰错误（避免无声挂死）。Migration 是独立步骤（`pnpm db:migrate` 或 Docker 的 `migrate` 服务），**不绑在 dev 启动里**。
>
> `pnpm dev` 通过 turbo `dependsOn: ["^build"]` 自动先编译 shared → core，再启动 server/worker/collab（tsup --watch / tsc --watch）。

# 目录结构

```
packages/
├── shared/            # Zod schema + TypeScript 类型 + 常量（零依赖）
├── core/              # 所有业务逻辑（barrel export @breatic/core）
│   ├── modules/       #   *.repo.ts (Drizzle) + *.service.ts (逻辑)
│   ├── agent/         #   MainAgent (AI SDK streamText), tools/, skills-loader
│   ├── db/            #   schema.ts (15 表) + client.ts + migrations
│   ├── infra/         #   redis, pubsub, queue, session-store, storage (S3/OSS), stripe
│   └── config/        #   env.ts, loader.ts, pricing.ts, model-catalog.ts
├── server/            # HTTP 壳（Hono routes + middleware，不含业务逻辑）
│   ├── routes/        #   auth, chat, canvas, mini-tools, text-tools, projects, skills, tasks, payment, health
│   └── middleware/    #   auth, cors, logger, error-handler
├── worker/            # BullMQ 壳 + AIGC providers
│   ├── handlers/      #   任务执行（5 条路径）
│   └── providers/     #   AIGC 双层架构：image/ video/ audio/ tts/ three-d/ understand/ (models/ + transports/)
├── collab/            # Hocuspocus 独立进程
│   └── src/           #   server, auth, persistence (PG), event-stream, task-listener, config
└── web/               # 前端 React + ReactFlow + Yjs
config/                # YAML 配置 (agent, collab, worker, pricing, text-tools, models/)
agents/                # SubAgent 角色定义 (*.md, frontmatter + system prompt)
skills/                # 内置 Skill 目录 (SKILL.md + metadata.json + scripts/)
locales/               # 统一 i18n JSON（前后端共用，4 种语言）
uploads/               # AIGC 生成文件本地存储（git-ignored）
```

## 包依赖方向

```
shared（零依赖）
  ↑           ↑
core        collab（只依赖 shared，不依赖 core）
  ↑
server / worker / web
```

**严格边界**：server 不 import worker，worker 不 import server。所有共享业务逻辑在 core。collab 是独立进程，只依赖 shared 类型。

**Package exports**：shared/core 导出 `./dist/index.js`（行业标准），本地开发和 Docker 统一走编译产物。路径解析通过 `MONOREPO_ROOT`（向上查找 `pnpm-workspace.yaml`），不依赖 `import.meta.dirname` 相对层级。

# 架构

## 3 个服务

| 服务 | 端口 | 职责 |
|------|------|------|
| API | 3000 | HTTP 请求 + Agent 聊天 SSE + Text mini-tool SSE |
| Collab | 1234 | Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点 |
| Worker | — | BullMQ 任务执行 → 存 DB → Redis Streams publish NodeEvent → Collab 写 Yjs |

## 画布协作

- 节点创建/布局：**前端控制**，后端只更新节点 `data` 字段
- 画布事件：**全走 Yjs**（不走 SSE），Agent 聊天流保留 SSE
- 并发生成冲突：**后端 Redis SETNX 锁**（`${env}:canvas:lock:{projectId}:{nodeId}` TTL 2h），前端只读 state 不写
- 事件总线：**Redis Streams** `${env}:stream:canvas-nodes`，NodeEvent 类型（handling/completed/failed），Collab 消费后通过 `nodesMap.get(nodeId).get("data").set(field, value)` 写目标节点的嵌套 data Y.Map
- 文档命名：`project-{id}/canvas`（画布），`project-{id}/node/{nodeId}`（节点编辑器）
- Yjs 节点结构镜像 ReactFlow `{ id, type, position, data }`：`id/type/position` 顶层，`name/content/state/handlingBy/prompt/attachments/params` 在嵌套 `data: Y.Map` 内
- 前端 Yjs-first 架构：写操作直接写 Yjs，增量 observe 只重建变更节点
- **Yjs 持久化**走 PG `yjs_documents` 表（Hocuspocus Database extension），**跨实例同步**走 Redis pub/sub（Hocuspocus Redis extension）
- 完整规范见 [docs/YJS.md](./docs/YJS.md)

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

**三区边界**：Agent（多轮对话，注入上下文）| Canvas（Worker 单次执行，必须生成）| Editor（不用 Skill）

**metadata.json 字段规范**：

| 字段 | 必须 | 类型 | 说明 |
|------|:---:|------|------|
| `name` | ✅ | string | 唯一标识 |
| `description` | ✅ | string | LLM 判断何时使用的描述 |
| `scope` | ✅ | string[] | `["agent"]` / `["canvas"]` / `["agent", "canvas"]` |
| `category` | ✅ | string | 分类（image/video/audio/tts/3d/text/understand/creative/research/default） |
| `tools` | | string[] | 需要的 LLM 工具（默认 `[]`） |
| `output_type` | | string | `"task_plan"` / `"canvas"` / `"inline"`（默认 `"canvas"`） |
| `keywords` | | string[] | 搜索匹配关键词 |
| `requires` | | object | `{ env: [...], bins: [...] }` 依赖检查 |
| `disable_model_invocation` | | bool | 仅用户可调用（默认 `false`） |
| `always` | | bool | 始终注入 system prompt（默认 `false`） |

禁止出现 npm 字段（version/author/license/engines/files/main）。

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

# 关键规范

- **软删除（MANDATORY）**：所有数据库删除一律软删除，**禁止硬删除**。每张表用 `deleted_at: timestamp` 列标记；list 查询默认过滤 `deleted_at IS NULL`；所有 FK 约束为 `restrict`（硬删父记录会被数据库阻止）。例外：GDPR 删号走单独管理流程
- **禁止 AI 作者署名（MANDATORY）**：commit 署名字段禁止 AI 工具名。强制手段：`.husky/commit-msg` + PR CI
- **PostgreSQL**：Drizzle ORM，UUID 主键，JSONB，积分原子操作（`db.transaction()` 包裹扣费+记流水）
- **Redis**：3 个逻辑 DB（`REDIS_URL` DB0 session/lock/rate-limit, `REDIS_QUEUE_URL` DB1 BullMQ, `REDIS_STREAM_URL` DB2 Streams+Hocuspocus pub/sub）。Key 格式 `{env}:{service}:{entity}:{id}`，禁止无 TTL。Stream MAXLEN ~ 10000
- **Auth 安全**：登录 5 次/分钟、注册 3 次/小时、Google OAuth 10 次/分钟（Redis 滑窗限速）。NoAccount 模式仅 dev 环境可用（ENV=prod 时启动拒绝）
- **XSS 防护**：所有 HTML 渲染走 DOMPurify `sanitizeRichText()`。粘贴内容、LLM 输出、prompt 预览均清洗
- **Prompt 安全**：发给 AIGC 的 prompt 先经 `extractPromptText()` 去除 HTML/注释/不可见字符
- **异常**：AppError(status, msg) → NotFound/Conflict/Validation/Forbidden/Unauthorized，Service 层抛，路由层 handler 处理
- **SSE**：仅 Agent 聊天 + Text mini-tool，`data` 含 `userId` + `projectId`
- **存储**：Local（默认）/ S3 / Aliyun OSS。上传走 presigned URL（`GET /assets/presign`，5 分钟过期，30 次/分钟限速），前端直传
- **支付(积分制,非订阅)**：Stripe Checkout 一次性购买积分包(`config/pricing.yaml` 5 档),**没有会员/订阅/功能分级**——所有用户享受同一套功能,只按实际用量扣积分。积分永不过期。Webhook 幂等(CAS 原子状态转换)。Mini-tool 入队前预检余额(402)。`deductOnce()` 保证同 refKey 只扣一次。用户对象上的 `membershipType` / `membershipExpiresAt` 字段是历史遗留,**新代码不要按 tier 做 feature gate**,只按积分余额判断

# 禁止清单

路由层写业务 | Service import hono | Drizzle 类型泄漏 | 硬编码密钥 | `allow_origins: ["*"]` + credentials | 裸 SQL | 非原子积分扣减 | 裸 catch | `any` 类型 | 同步阻塞事件循环 | 公共函数缺 TSDoc | `var` / `require()` | YAML 中文 | AIGC sync 路径

# 编码行为准则

减少常见 LLM 编码错误的行为指南。**权衡**：这些准则偏向谨慎而非速度，对简单任务可自行判断。

## 1. 先想再写

**不要假设，不要隐藏困惑，主动暴露权衡。**

- 明确说出你的假设。不确定时，先问
- 存在多种理解时，列出选项——不要默默选一个
- 存在更简单方案时，说出来。该推回时就推回
- 有任何不清楚的地方，停下来，指出困惑，提问

## 2. 简单优先

**写能解决问题的最少代码。不做推测性开发。**

- 不做超出要求的功能
- 单次使用的代码不做抽象
- 没人要求的"灵活性"和"可配置"不加
- 不可能发生的场景不做错误处理
- 如果写了 200 行但 50 行就够，重写

自检："一个高级工程师会说这过度复杂吗？" 如果会，简化。

## 3. 精准修改

**只改必须改的。只清理自己制造的废物。**

- 不要"顺手改进"周围的代码、注释或格式
- 不要重构没有坏的东西
- 代码风格以项目规范为准，发现不一致时主动修正
- 发现无关的死代码，提一下——不要删它
- 删除**你的修改**导致无用的 import/变量/函数
- 不要删除修改前就存在的死代码（除非被要求）

检验标准：diff 中每一行改动都应直接追溯到用户的需求。

## 4. 目标驱动执行

**定义成功标准，循环直到验证通过。**

将任务转化为可验证目标：
- "加验证" → "为非法输入写测试，然后让测试通过"
- "修 bug" → "写复现测试，然后让测试通过"
- "重构 X" → "确保重构前后测试通过"

多步任务需声明简要计划：
```
1. [步骤] → 验证：[检查方式]
2. [步骤] → 验证：[检查方式]
```

强成功标准让你能独立循环。弱标准（"让它能跑"）需要不断确认。

## 5. 彻底解决，禁止补丁（MANDATORY — 零容忍）

**定位根因、提彻底方案；禁止头疼医头、脚疼医脚。方案不彻底 = 违规。**

### 硬性规则

- **方案未经用户确认前，不动代码**
- **方案不唯一时**（含治本/治标的取舍）：列每个选项的复杂度、回归面、架构影响，让用户选；不许自己拍板
- **自己拿不准时**：必须问；不许猜、不许"先实现一版试试"
- **架构有根本缺陷**：提架构变更，不在缺陷上打补丁
- **已有同类系统的现成模式**（主 canvas / canvas Yjs / 主 canvas undo 等）：彻底方案必须对齐，不许新发明半套
- 参考成熟产品（飞书、Google Docs 等）的做法

### 明令禁止的补丁词汇

一旦出现以下任意一种,立即停手,重新设计:

- "作为 compat shim / 兼容层 / 适配层"（保留老 API 绕过重构）
- "作为 legacy mirror / 只读镜像"（旧数据源副本救老代码）
- "作为 escape hatch / 全局 ref / 单例"（绕 Context 边界）
- "临时/过渡/暂时/先这样/后续再改"（技术债登记，不是解决方案）
- "为了不改 XX 个 callsite / 工作量考虑"（把工作量当借口换架构妥协）
- "两条路径并存 / hybrid / 双写"（违反单一真相源）

出现上面任意词汇后的方案 = **不彻底**,不许提交给用户,必须回到白板重想到彻底为止。

### 动手前三条自检（全通过才写代码）

1. 在解决**根因**，还是只压症状？后者 → 停下来重想
2. 方案是**唯一解**，还是我在多个里挑了一个？后者 → 停下来问用户
3. 方案里有**任何一处"暂时/兼容/补丁"**？有 → 该处就是下次要返工的地方,现在重做

### 违规成本

给出不彻底方案 → 用户耗费精力识别、拆穿、重提需求。
**这是对用户时间的犯罪**，不是工程瑕疵。
发现自己写了补丁 → 立即撤回、重做，**不许辩护、不许找理由、不许谈工作量**。

# Due Diligence (DD) — 重大决策纪律(MANDATORY)

DD 是**决策前**的纪律,#1~#5 是**决策后实施**的纪律,不互替。完整流程 / 5 维度尽调 / 报告骨架见 [docs/DD-PROCESS.md](./docs/DD-PROCESS.md)。

**触发条件**(任一即触发):安全模型 / 长期维护负担 / 跨包接口 / 反悔代价 > 1 周。breatic 高频场景:AIGC provider 选型 / Agent-Skill 定义 / 三层记忆 / Yjs 结构 / 积分计费。

**5 步硬流程**:候选枚举 → 5 维度尽调(实测/源码/治理/安全/上游)→ 对比矩阵(每格证据可追溯)→ 推荐 + 理由 → 用户拍板。

**反 DD 模式**(违规):浅表决策(star/README/"感觉")· hearsay 升格(AI 对话当 ground truth)· 假对比(候选不全)· 单点论据 · "先用 X 后续再换"(治标补丁,同 #5)。

**违规成本**:未做 DD 就动手 = **违反纪律 = 当场撤回**(同 #5)。

**DD vs 轻量 Research 边界**:小变化(单文件 util / 候选明显)→ Research(GitHub search / 包注册表);重大决策(满足触发任一)→ **必须 DD**。

**报告位置**:`docs/dd/<YYYY-MM-DD>-<topic>.md`(公开技术选型);敏感内容(vendor / 安全模型)放团队私有 channel,不入公开仓库。

# Test-Driven Development (TDD) — AI coding 时代版(MANDATORY)

业界共识(Anthropic 官方 / Kent Beck):**TDD 在 AI 时代是关键纪律**,但 AI 引入"作弊 / false confidence"风险需专门防御。**完整 anti-pattern / property-based 工具 / 衔接细节见 [docs/TDD-MANDATE.md](./docs/TDD-MANDATE.md)**。DD-TDD 衔接见 [docs/DD-PROCESS.md](./docs/DD-PROCESS.md) 第 10 节。

**5 条硬约束**(零容忍):

1. **修 bug 必须先写复现测试**(防 AI 补丁式修复 → 违反 #5)
2. **spec 由 audit / 人写,test code 由 dev 写** —— Writer/Reviewer 反闭环(同 [Anthropic 官方](https://code.claude.com/docs/en/best-practices))
3. **重构前测试必须 green**(防 AI 偷换语义)
4. **禁止 AI 通过删除 / 禁用测试通过** —— Kent Beck cheating warning;CI 监控 test 总数 > 10% 下降 alert
5. **单一 AI session 不能同时写 spec + test + 实现**(强制反闭环)

**节奏**:红(具体 assertion,禁 `toBeDefined()` 等 weak assertion)→ 绿(最小实现)→ 蓝(重构 + 跑全套)。原型 / explore 阶段允许后置 test。

**关键路径**(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作同步)→ **100% 覆盖 + 显式 invariant + property-based**(`fast-check` / `hypothesis`)。覆盖率 < 80% 不是 hard block,**关键路径裸奔 = P0 BUG**。
