# 项目简介

面向内容创作者的 AI 无限画布协作平台。3 个服务：API（Hono）+ Collab（Hocuspocus/Yjs）+ Worker（BullMQ）。全栈 TypeScript monorepo。

# 项目规范

## 代码风格

- TSDoc（`@param`, `@returns`, `@throws`, `@example`），公共 API 必须有
- TypeScript strict，禁止 `any`（用 `unknown`），禁止 `var`/`require`
- ESLint + eslint-plugin-tsdoc 强制

## 技术栈

Node.js 22+ | TypeScript 5.x | pnpm | Turborepo | Hono | Drizzle ORM | PostgreSQL (postgres.js) | ioredis | BullMQ | Vercel AI SDK | Hocuspocus 3.4.4 | Zod | Vitest | pino

## 开发命令

```bash
pnpm dev              # API (port 3000)
pnpm dev:collab       # Hocuspocus (port 1234)
pnpm dev:worker       # BullMQ Worker
pnpm test             # 单元测试 (150 个，mock，无需外部依赖)
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
```

## 目录结构

```
packages/
├── server/            # API 服务 + Worker
│   ├── routes/        #   HTTP 路由 (auth, chat, canvas, mini-tools, text-tools, projects, skills, tasks, payment, health)
│   ├── middleware/     #   auth, cors, logger, error-handler
│   ├── agent/          #   MainAgent (AI SDK streamText), tools/ (含 spawn 子代理), skills-loader
│   ├── providers/      #   AIGC 双层架构：image/ video/ audio/ tts/ three-d/ understand/ (models/ + transports/)
│   ├── worker/         #   BullMQ handlers (5 条执行路径)
│   ├── modules/        #   业务层：*.repo.ts (Drizzle) + *.service.ts (逻辑)
│   ├── db/             #   schema.ts (15 表) + client.ts
│   ├── infra/          #   redis, pubsub, queue, session-store, storage (S3/OSS), stripe
│   └── config/         #   env.ts, loader.ts, pricing.ts, worker.ts, text-tools.ts
├── collab/            # Hocuspocus 独立进程
│   └── src/           #   server, auth, persistence (PG), event-stream (Streams 消费器), task-listener (NodeEvent → Yjs), config
├── shared/            # Zod schema + TypeScript 类型 + 常量
└── web/               # 前端 (placeholder)
config/                # YAML 配置 (agent, collab, worker, pricing, text-tools, models/)
agents/                # SubAgent 角色定义 (*.md, frontmatter + system prompt)
skills/                # 内置 Skill 目录 (SKILL.md + metadata.json + scripts/)
locales/               # 统一 i18n JSON（前后端共用，4 种语言）
uploads/               # AIGC 生成文件本地存储（git-ignored，从 uploads.example/ 重命名）
logs/                  # 服务日志（per-service 子目录，daily rotation）
```

## 架构

依赖方向：`routes/ → modules/ ← infra/`

### 3 个服务

| 服务 | 端口 | 职责 |
|------|------|------|
| API | 3000 | HTTP 请求 + Agent 聊天 SSE + Text mini-tool SSE |
| Collab | 1234 | Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点 |
| Worker | — | BullMQ 任务执行 → 存 DB → Redis Streams publish NodeEvent → Collab 写 Yjs |

### 画布协作

- 节点创建/布局：**前端控制**，后端只更新节点 data 字段
- 画布事件：**全走 Yjs**（不走 SSE），Agent 聊天流保留 SSE
- 并发生成冲突：**后端 Redis SETNX 锁**（`${env}:canvas:lock:{projectId}:{nodeId}` TTL 2h），API 在 `/canvas/tasks` 或 `/assets/upload/prepare` 取锁成功后 publish `handling` 事件，前端只读 state 不写
- 事件总线：**Redis Streams** `${env}:stream:canvas-nodes`，NodeEvent 类型（handling/completed/failed），Collab 消费后写 canvas Y.Map 里的 nodes 数组
- 文档命名：`project-{id}/canvas`（画布），`project-{id}/node/{nodeId}`（节点编辑器）
- 完整规范见 [docs/YJS.md](./docs/YJS.md)

### 三层记忆 + Turn 压缩

| 层 | 作用域 | 表 |
|---|---|---|
| User | 跨项目偏好 | `user_memories` |
| Project | 协作者共享 | `project_memories` |
| Conversation | 当前对话摘要 | `conversation_memories` |

**Turn 机制**：每条消息带 `turnIndex`（`role=user` 时递增）。`memory_window`（默认 20）按 Turn 计数，超出时自动归纳旧 Turn 到记忆摘要。

**Context 压缩**：构建 LLM 上下文时，最近 `full_detail_turns`（默认 3）个 Turn 保留完整 step（tool_call + tool_result），更早 Turn 只保留 user + assistant 最终回复。`thinking` 字段永远不发回 LLM。

**消息存储**：`conversations.messages` JSONB 数组，含 `turnIndex`、`thinking?`、`tool_calls?: ToolCallInfo[]`。原始消息不删除，归纳只生成摘要。

### SubAgent（spawn tool）

SubAgent 通过 `spawn({ task, agent, skill? })` 调用。每个 Agent 是 `agents/*.md` 中定义的角色（frontmatter: name, description, tools, model, skills + body: system prompt）。Skill 是可选的知识补充（`skills/` 目录）。

**Agent 定义角色（谁来做），Skill 定义知识（怎么做）。** 两者正交、可组合。

内置 4 个 Agent：`researcher`（搜索参考）| `prompt_optimizer`（提示词优化）| `analyst`（多模态分析）| `planner`（项目规划）。

Tools 取并集：Agent 声明的 tools ∪ Skill 声明的 tools，始终排除 spawn（防递归）。SubAgent 通过 `AsyncLocalStorage` 继承请求上下文（三层记忆 + 压缩对话历史 + userId），在内部直接扣费。

### 任务执行（Worker 5 条路径）

1. **AIGC Mini-Tool**（source="mini_tool"）→ toolName 查表 → provider 直调
2. **Understand**（task_type="understand"）→ 多模态理解 / ASR 转写
3. **AIGC 直达**（image/audio/video/3d/tts）→ provider `generateAsync()`
4. **Skill（显式）** → 指定 skillName → AI SDK Agent 执行
5. **Skill（自动选）** → 按 category 合并 Skills → LLM 选

### Mini-Tool（两种模式）

| | AIGC (image/video/audio) | Text |
|---|---|---|
| Endpoint | `POST /mini-tools/{image\|video\|audio}` | `POST /mini-tools/text` |
| 执行 | BullMQ Worker（异步） | API 直接 streamText（同步 SSE） |
| 结果交付 | Redis → Hocuspocus → Yjs（协作者可见） | SSE 流给请求者（私有，接受后才写 Yjs） |
| 用户交互 | 等待 → 结果出现 | 打字机效果，可随时 abort |
| 积分 | 按 API cost | 按 token 消耗 |
| 并发 | Worker concurrency 控制 | 每用户 1 个（Redis 锁） |

Text 工具（10 个）：polish / expand / summarize / translate / rewrite / continue / generate / character / storyboard / script。操作类发完整 `document` + `selection` 保证上下文。自动匹配输入语言回复。

### Skill 系统

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

## 配置

| 文件 | 用途 |
|------|------|
| `.env` | 密钥、DB/Redis 连接（Zod 校验，启动即检查） |
| `config/agent.yaml` | Agent 模型、归纳模型、loop 次数、memory Turn 窗口（20）、Turn 压缩（3） |
| `config/text-tools.yaml` | Text mini-tool 模型 |
| `config/worker.yaml` | Worker 并发、重试、轮询 |
| `config/collab.yaml` | Hocuspocus debounce、限流、文档大小限制 |
| `config/pricing.yaml` | 积分套餐（5 tier，test+live Stripe ID） |
| `config/models/*.yaml` | AI 模型路由（46 文件，model-centric） |

## 关键规范

- **软删除（MANDATORY）**：所有数据库删除一律软删除，**禁止硬删除**。每张表用 `deleted_at: timestamp` 列标记；list 查询默认过滤 `deleted_at IS NULL`；service/repo 提供 `softDelete()` 方法而非 `delete()`；删除后文件/存储资源**永不清理**。例外：GDPR 删号、合规清理走单独管理流程，不在常规代码路径。理由：支持撤销、审计、恢复，避免用户丢失创作资产。
- **禁止 AI 作者署名（MANDATORY）**：commit 的 author / committer / `Co-Authored-By` / `Signed-off-by` 里**禁止**出现 Claude / Anthropic / GPT / Copilot / Cursor / ChatGPT / Codex 等 AI 工具名。在 commit body 里描述"使用 AI 辅助开发"没问题，**但署名字段不行**。理由：美国版权法不承认 AI 生成内容的版权，AI 作为开源项目的 contributor 会造成许可证授权歧义。强制手段：`.husky/commit-msg` 本地 hook + `.github/workflows/no-ai-attribution.yml` PR CI。详见 `CONTRIBUTING.md`。
- **PostgreSQL**：Drizzle ORM，UUID 主键，JSONB，积分原子操作
- **Redis**：Key 格式 `{env}:{service}:{entity}:{id}`，禁止无 TTL
- **异常**：AppError(status, msg) → NotFound/Conflict/Validation/Forbidden/Unauthorized，Service 层抛，路由层 handler 处理
- **SSE**：仅 Agent 聊天 + Text mini-tool，`data` 含 `userId` + `projectId`
- **Yjs**：canvas 文档结构 `canvas: Y.Map { nodes, edges, newResultsFlag }`，节点 `data` 字段：`{ name, content, cover_url?, state: "idle"|"handling", handlingBy?: {userId,username}, nodeRuntimeData }`。**Yjs 持久化**走 PG `yjs_documents` 表（Hocuspocus Database extension），**跨实例同步**走 Redis pub/sub（Hocuspocus Redis extension）。详见 [docs/YJS.md](./docs/YJS.md)
- **存储**：Local（默认）/ S3 / Aliyun OSS。AIGC 结果从临时 CDN 下载到永久存储。`uploads/` 在根目录
- **支付**：Stripe Checkout 积分购买，永不过期，Webhook 幂等

### Agent Tools（9 个）

`run_script` | `read_file` | `write_file` | `edit_file` | `list_dir` | `web_search` | `web_fetch` | `ask_user_question` | `spawn`

**无通用 shell 执行器**。`run_script` 只能执行 `skills/{name}/scripts/` 下的脚本，路径防穿越，按扩展名选解释器（.py → python3, .sh → sh, .js → node）。

## 禁止

路由层写业务 | Service import hono | Drizzle 类型泄漏 | 硬编码密钥 | `allow_origins: ["*"]` + credentials | 裸 SQL | 非原子积分扣减 | 裸 catch | `any` 类型 | 同步阻塞事件循环 | 公共函数缺 TSDoc | `var` / `require()` | YAML 中文 | AIGC sync 路径
