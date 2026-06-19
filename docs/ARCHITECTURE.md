# Architecture

breatic monorepo 的完整工程参考,合三份文档于一处:**Backend** 架构(7 package + 3 服务)、**Frontend**(`packages/web`)、以及全栈**函数定义编码规范**。行为 mandate(头号原则 / DD / TDD / 红线 / 判定题)在仓库根 [`CLAUDE.md`](../CLAUDE.md);本文写"怎么做的细节"(技术栈 / 包依赖 / 数据流 / 命名 / 节点模型 / token / 函数注释格式),mandate 指向这里。

- [Backend](#backend) — 技术栈 / 7 package / 3 服务 / 画布协作 / 三层记忆 / SubAgent / Worker / Mini-Tool / Skill / Agent tools / 配置 / 日志
- [Frontend](#frontend) — `packages/web` 技术栈 / 7 层 layered / 节点模型 / 命名规范 / 路由 / 源码布局
- [Coding standards (function definition format)](#coding-standards-function-definition-format) — 函数注释 / 显式返回类型 / 异常类型格式 + CI 强制

## Backend

### Product

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo,7 个 package + 3 个运行时服务。

### Tech stack (backend)

| Layer | Tech |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript 5.x strict |
| Monorepo | pnpm workspaces + Turborepo |
| HTTP | Hono |
| ORM | Drizzle ORM |
| DB | PostgreSQL (postgres.js driver) |
| Cache / Queue / PubSub | Redis (ioredis) + BullMQ |
| AI | Vercel AI SDK |
| Realtime collab | Hocuspocus 3.4.4 (Yjs server) |
| Validation | Zod |
| Test | Vitest |
| Logging | pino (main-thread `multistream`) |

Frontend stack: see [Tech stack (frontend)](#tech-stack-frontend).

### 7 packages

```
packages/
├── shared/   # Zod schema + 类型 + 常量 (零依赖)
├── core/     # 后端共享内核 barrel (@breatic/core) — 纯地基,零 AIGC 业务
│              auth/(共享鉴权内核:projectMembers.repo + projectAuth.service〔loadProjectRole〕,collab+server 共用) ·
│              db/(schema.ts 25 表) · i18n/(node 适配器 loadLocales/runWithLocale) · infra/(redis/pubsub/queue/storage/session-store/control-events) · config/
├── domain/   # server+worker 共享 AIGC 业务内核 (@breatic/domain,collab 永不碰) — credit · task(含 markCompletedAndBill 任务·积分跨表原子扣费)· node-history · agent(loader/skills/tools/llm)· model-catalog · canvas-lock(PR4 自 core 迁入,各域 *.repo/*.service 功能文件夹)
├── server/   # HTTP 壳 (Hono): routes/(auth/chat/canvas/mini-tools/projects/members/project-invitations/notifications/skills/tasks/payment) + middleware/(路由层=接线员,不写业务) + modules/(server 私有领域,**按域分功能文件夹**,每域 service+repo+test:auth〔含 user.repo + recovery-code〕/conversation/memory/notification/payment/project〔含 projectMembers〕/project-invite〔含 project-invite-mail〕/role-upgrade-request/studio/skill/text-tool/yjs-doc,barrel index.ts re-export) + infra/(stripe/mailer) + config/(pricing/text-tools)(healthz 走独立 :3001 进程,见 DEPLOY.md)
├── worker/   # BullMQ 壳: handlers/(dispatch.ts=5 路分发 + local/{runtime,video} 本地 ffmpeg 执行) + providers/(image/video/audio/tts/three-d/understand) + 根(index 入口 / mini-tool-registry / bootstrap-config)
├── collab/   # Hocuspocus 独立进程: hooks/(auth/before-handle-message/awareness/disconnect) + services/(persistence/event-stream/space-rpc/task-listener/members-sync) + infra/(logger/health/connectivity) + 根(index/hocuspocus 装配/config)
└── web/      # React app — see the [Frontend](#frontend) part
config/ agents/ skills/ locales/ (git-tracked); uploads/ + sandbox/ (git-ignored; sandbox/ = agent file-tool sandbox root)
```

**包依赖方向:** `shared(零依赖,前后端共用) ← core(后端共享内核) ← {domain, collab}`;`domain(server+worker 共享 AIGC 业务) ← server / worker`;前端 `web ← shared` 不依赖 core/server。**二次调整(2026-05-31)新增 `@breatic/domain`**:server+worker 共享、collab 永不碰的 AIGC 业务(积分花 / 任务 / 节点历史 / agent / model-catalog / canvas-lock)单独成包,`lint:dependency-cruiser` 的 `collab-no-domain-import` 规则守卫 collab 不 import domain(**PR4 已自 core 迁入业务**:credit/task/node-history/agent/model-catalog/canvas-lock + 各自 repo;同期 user.repo/stripe/mailer/pricing/text-tools 迁 server,core 回归纯地基)。**严格边界**:server 不 import worker,worker 不 import server;**模块化单体(2026-05-31)+ 二次调整 PR4**:core 只放全后端共享内核(共享鉴权 + infra + schema + 跨服务事件协议;AIGC 业务钱/任务/节点历史/agent 等已迁 `@breatic/domain`),**服务私有领域逻辑归各自服务**(server 私有业务在 `server/src/modules`,经三层边界:路由层=接线员 → 业务 service 层 → core 共享内核;`lint:dependency-cruiser` 的 `library-no-app-import` 规则守卫 core/shared 不反向 import 服务包)。collab 历史上独立部署"不依赖 core",2026-05-27 PR `feat/2026-05-27-collab-infra-resilience` 修订为依赖 core infrastructure(`createRedisClient` / 日志 / 配置),production-safety 配置不再 raw 实例化漂离。**二次调整(2026-05-31)重定义**:鉴权 / 会话 / 成员事件这类**全后端(含 collab)必须一致**的逻辑属 core 共享内核,collab 用 core 的统一鉴权;**鉴权已统一(PR2 #179)**:collab `hooks/auth.ts` 调 core 的 `getSession` + `projectAuthService.loadProjectRole`,跟 server 共用同一套原语,不再手写裸 `redis.get(:session:)` / 裸 SQL `loadProjectRole`。旧「collab 只借 core infra、业务不引入」表述作废 —— 它把鉴权漂移当成了设计。**DB 适配统一(2026-06-02)**:collab 也不再手搓 postgres.js 连接池——`yjs_documents` 的持久化(`persistence`)/ 空间存在性读(`auth`)/ space-rpc 软删·恢复全走 core 的 `yjsDocumentsRepo`(那张共享表的**唯一 repo 家**),经 core 的 `db` 单例(per 进程自动建池,同 server/worker);健康探针走 `pingDb()`、boot 连通性走统一的 core `checkInfraReady(redisClients)`(各服务传自己依赖的 Redis 单例:server/worker `{general,queue,stream}`、collab `{general,stream}`;2026-06-03 收编 collab 旧的 `checkCollabInfraReady` + `checkPgReachable`,collab 也走单例式),`postgres` 直接依赖已从 collab 移除。**全项目 postgres.js 驱动只在 core,Drizzle 是唯一查询适配层**;CI 守卫 `lint:no-postgres-outside-core`(驱动只许 core)+ `lint:no-yjs-documents-sql-outside-repo`(一表一 repo)+ `lint:no-raw-sql-outside-repo`(现扫 collab,本包零裸 SQL)。**Redis 适配同理统一(2026-06-02)**:`ioredis` 驱动也只在 core(工厂 + 单例 + `pingRedis` + re-export `Redis` 类型),collab/domain 删直接依赖、`Redis` 类型从 core 拿;collab 会话查走 `getRedis()` 单例,**但订阅 / 阻塞流 / Hocuspocus pub-sub 等专用连接保持独立**(Redis 协议要求每角色独占 socket,连接数收不了,跟 postgres 单池本质不同);跨服务 stream key `:stream:task-events` 收成 core 的 `taskEventsStreamKey()` 单一来源(消灭 worker 发布侧 + collab 消费侧各造的静默断风险);CI 守卫 `lint:no-ioredis-outside-core`。

**Package exports:** shared/core 导出 `./dist/index.js`(行业标准),本地和 Docker 统一走编译产物。路径解析通过 `MONOREPO_ROOT`(向上查找 `pnpm-workspace.yaml`)。

### 3 services

| Service | Port | Responsibility |
|---|---|---|
| API | 3000 | HTTP 请求 + Agent 聊天 SSE + Text mini-tool SSE |
| Collab | 1234 | Yjs 文档同步 + PG 持久化 + Redis 跨实例 + 消费 Redis Streams 写 canvas 节点 |
| Worker | — | BullMQ 任务执行 → 存 DB → Redis Streams publish NodeEvent → Collab 写 Yjs |

### Canvas collaboration

- 节点 create/delete + position 由**前端独占**;后端只能改 `data` 字段(state/content 等)
- 画布走 Yjs,Agent 聊天走 SSE。无锁:每次 mini-tool 操作产生新兄弟节点(edge 连接),不覆盖源节点
- 事件总线:Redis Streams `${env}:stream:canvas-nodes`(`NodeStateUpdateEvent`,支持 `targetNodeIds: string[]` 1:N),Collab 消费后写 Yjs
- 文档命名 v10 multi-doc:`project-{id}/meta`(含 spaces 列表)+ `project-{id}/canvas-{spaceId}`(每个 Canvas Space 一个)
- 节点状态机:`idle` / `handling`(均在 Yjs);`localPending` 是本地 React state;失败 = `idle` + `errorMessage`
- Yjs 持久化走 PG `yjs_documents` 表(Hocuspocus Database extension);跨实例同步走 Redis pub/sub(Hocuspocus Redis extension)
- 节点结构 + 字段归属 + 状态机详细规范跟 `@breatic/shared/types/canvas-node.ts` 类型定义保持一致

### Three-layer memory + Turn compression

| Layer | Scope | Table |
|---|---|---|
| User | 跨项目偏好 | `user_memories` |
| Project | 协作者共享 | `project_memories` |
| Conversation | 当前对话摘要 | `conversation_memories` |

- **Turn 机制**:每条消息带 `turnIndex`(`role=user` 时递增)。`memory_window`(默认 20)按 Turn 计数,超出时自动归纳旧 Turn 到记忆摘要
- **Context 压缩**:最近 `full_detail_turns`(默认 3)个 Turn 保留完整 step(tool_call + tool_result),更早 Turn 只保留 user + assistant 最终回复。`thinking` 字段永远不发回 LLM
- **消息存储**:`conversations.messages` JSONB 数组,含 `turnIndex`、`thinking?`、`tool_calls?: ToolCallInfo[]`。原始消息不删除,归纳只生成摘要

### SubAgent (spawn tool)

SubAgent 通过 `spawn({ task, agent, skill? })` 调用。每个 Agent 是 `agents/*.md` 中定义的角色(frontmatter: name, description, tools, model, skills + body: system prompt)。Skill 是可选的知识补充(`skills/` 目录)。

**Agent 定义角色(谁来做),Skill 定义知识(怎么做)。** 两者正交、可组合。

内置 4 个 Agent:`researcher`(搜索参考)| `prompt_optimizer`(提示词优化)| `analyst`(多模态分析)| `planner`(项目规划)。

Tools 取并集:Agent 声明的 tools ∪ Skill 声明的 tools,始终排除 spawn(防递归)。SubAgent 通过 `AsyncLocalStorage` 继承请求上下文(三层记忆 + 压缩对话历史 + userId),在内部直接扣费。

### Worker 5 paths

1. **AIGC Mini-Tool**(source="mini_tool")→ toolName 查表 → provider 直调
2. **Understand**(task_type="understand")→ 多模态理解 / ASR 转写
3. **AIGC 直达**(image/audio/video/3d/tts)→ provider `generateAsync()`
4. **Skill(显式)** → 指定 skillName → AI SDK Agent 执行
5. **Skill(自动选)** → 按 category 合并 Skills → LLM 选

### Mini-Tool (two modes)

| | AIGC (image/video/audio) | Text |
|---|---|---|
| Endpoint | `POST /mini-tools/{image\|video\|audio}` | `POST /mini-tools/text` |
| 执行 | BullMQ Worker(异步) | API 直接 streamText(同步 SSE) |
| 结果交付 | Redis → Hocuspocus → Yjs(协作者可见) | SSE 流给请求者(私有,接受后才写 Yjs) |
| 用户交互 | 等待 → 结果出现 | 打字机效果,可随时 abort |
| 积分 | 按 API cost | 按 token 消耗 |
| 并发 | Worker concurrency 控制 | 每用户 1 个(Redis 锁) |

Text 工具(10 个):polish / expand / summarize / translate / rewrite / continue / generate / character / storyboard / script。操作类发完整 `document` + `selection` 保证上下文。自动匹配输入语言回复。

### Skill system

**两区边界**:Agent(多轮对话,注入上下文)| Canvas(Worker 单次执行,必须生成)。文本编辑器(TipTap)独立运行,不使用 Skill。

**metadata.json**:仅 `name` / `description` 必填;其他字段(`scope`/`category`/`tools`/`output_type`/`requires`/...)`skills-loader.ts` 都有 default 兜底(`scope` 默认 `["agent"]`,`category` 默认 `"default"`)。建议显式填 `scope`/`category` 避免读代码才知行为。完整字段表见 `packages/core/src/agent/skills-loader.ts` 的 schema 定义。禁用 npm 字段(version/author/license/engines/files/main)。

### Agent tools (9)

`run_script` | `read_file` | `write_file` | `edit_file` | `list_dir` | `web_search` | `web_fetch` | `ask_user_question` | `spawn`

**无通用 shell 执行器**。`run_script` 只能执行 `skills/{name}/scripts/` 下的脚本,路径防穿越,按扩展名选解释器(.py → python3, .sh → sh, .js → node)。

### Configuration files

| File | Use |
|---|---|
| `.env` | 运行时配置(从 `.env.dev` 或 `.env.docker` 复制) |
| `.env.dev` | 本地开发模板(localhost URLs) |
| `.env.docker` | Docker 部署模板(容器名 URLs) |
| `config/agent.yaml` | Agent 模型、归纳模型、loop 次数、memory Turn 窗口(20)、Turn 压缩(3) |
| `config/text-tools.yaml` | Text mini-tool 模型 |
| `config/worker.yaml` | Worker 并发、重试、轮询 |
| `config/collab.yaml` | Hocuspocus debounce、限流、文档大小限制、单文档连接数上限(`max_connections_per_document`,默认 100;满了**降级只读**非拒绝) |
| `config/pricing.yaml` | 积分**购买包**(5 档一次性购买,不是订阅/会员,test+live Stripe ID) |
| `config/limits.yaml` | 成员容量**业务软上限**(`studio_member_cap` / `project_collaborator_cap`,默认各 100;project 只数显式邀请的成员,owner + 自动 viewer 豁免)。server 加载器 `packages/server/src/config/limits.ts`(镜像 `pricing.ts`)|
| `config/models/*.yaml` | AI 模型路由(46 文件,model-centric) |

### Logging

每个服务独立日志目录,主线程 `pino.multistream` 同步写文件 + 控制台(无 worker 线程),文件名 `{service}.{yyyy-MM-dd}.log`,轮转交给容器 log driver / logrotate:

| Service | Directory | Init |
|---|---|---|
| Server | `logs/server/` | 入口 `initLogger("server")` |
| Worker | `logs/worker/` | 入口显式 `initLogger("worker")` |
| Collab | `logs/collab/` | 入口 `initLogger("collab")`(已收编进 core 统一 logger) |
| Nginx | `logs/nginx/` | logrotate,30 天保留 |

每条日志双时间戳:`timestamp`(ISO 8601)+ `time`(epoch ms)。

### Run

```bash
# 本地:首次复制 .env.dev → .env,docker 起 PG+Redis,pnpm db:migrate;之后 pnpm dev
# Docker 全量:复制 .env.docker → .env,改域名/密钥,docker compose up -d
pnpm dev              # turbo 跑全部服务(自动先 build shared/core,再 watch server/worker/collab)
pnpm db:migrate       # 拉新 migration 后跑
pnpm test / typecheck / lint
```

启动时先 `checkInfraReady()` 验证 PG/Redis 可达;连不上立即退出(避免无声挂死)。Migration 是独立步骤,不绑在 dev 启动里。

## Frontend

`packages/web/` — breatic 的 React 前端 app,跑在浏览器里(后端架构见上面的 [Backend](#backend) 部分)。

> **约束 vs. 细节**:`web` 要满足的约束(TS strict / 零 `any`、`app → pages → spaces → features → stores → domain → data → ui` 单向分层、关键路径 + invariant 测试、a11y、i18n〔ICU〕、设计 token 严格)是 [CLAUDE.md](../CLAUDE.md)「前端工业级标准」里的 mandate;本部分写这些约束**怎么落地**(命名 / 节点模型 / token 桥接 / shadcn vendor 边界 / 各类 trap)。

### Status

v14 全新重写已于 2026-05-19 合入 `main`(PR #103)。对齐 design-baseline mock 的视觉调整在长期分支 `feat/web-visual-alignment` 上进行中。

### Tech stack (frontend)

| 层 | 技术 |
|---|---|
| 框架 | React 19 + TypeScript 5.6 |
| 构建 | Vite 5 |
| UI 原语 | shadcn/ui(Radix + Tailwind) |
| 样式 | Tailwind CSS 3.4 + CSS 变量(浅色 / 深色经 `data-theme` 切换) |
| 状态 | Zustand 5 + immer(需要撤销的 store 用 zundo) |
| 协作 | Yjs 13 + @hocuspocus/provider 3(同步优先,无离线模式) |
| 画布 | @xyflow/react 12 |
| 富文本编辑器 | TipTap 3 |
| 音频 / 视频 | WaveSurfer.js / video.js |
| 3D | Three.js + @react-three/fiber |
| 数据请求 | Axios + @microsoft/fetch-event-source(SSE)+ React Query |
| i18n | `intl-messageformat`(ICU)经 shared 的 `t()` + `useTranslation` hook(en / zh-CN / zh-TW / ja / ko);8 产品名词 + 角色名走「不翻译表」全语言英文,见 [packages/web/CLAUDE.md](../packages/web/CLAUDE.md)「产品术语「不翻译表」」 |
| 路由 | React Router 7 |
| 测试 | Vitest + Playwright + @testing-library + fast-check |
| 监控 | Sentry |

### Run (web only)

全量起服务(api / worker / collab / web,web 跑在 :8000)见 [Backend 的 Run](#run);只跑 web 用:

```bash
pnpm -F @breatic/web dev          # 只起 web
pnpm -F @breatic/web test         # vitest
pnpm -F @breatic/web test:smoke   # Playwright 端到端
pnpm -F @breatic/web build        # vite 构建 → dist/breatic/
```

### Layered architecture

依赖严格向下流动,下层永不 import 上层:

```
app/        Vite 入口 · 路由 · Provider 编排 · ErrorBoundary
pages/      路由页 + 页面专属子模块(chrome / chat / members / tweaks)
spaces/     Canvas / Document / Timeline 内容实现(open enum)
features/   真·跨页模块(auth / error-boundary / preferences)
stores/     Zustand store(一文件一 store,互不 import)
domain/     纯业务逻辑(状态机 / 权限 / hook)
data/       I/O 边界(api / yjs / stream / storage)
ui/         跨 feature 的业务原子(Avatar、StatusBadge 等)
components/ui/  shadcn 原语(vendor;ESLint 忽略)
theme/      tokens.css(单一 token 源)+ tailwind 扩展
i18n/       locale-bootstrap + useTranslation hook(引擎在 @breatic/shared/i18n)
lib/        工具(cn / format / env / analytics)
```

### Key conventions

- **shadcn 100%** — `components/ui/` 里每个原语都是 shadcn/ui(底层 Radix)。不用 Headless UI,不用 MUI。
- **单一 token 源** — 所有设计 token(neutral / status / brand / shadcn 别名 / chrome UI 尺度)都在 `src/theme/tokens.css`。shadcn 原语直接消费标准别名,**没有独立 bridge 文件**。**设计系统第九片(2026-06-10 起,2026-06-13 ③ 落 breatic)**:纯中性 R=G=B neutral 12 级 + 离极值有界(2026-06-13 推翻微暖→纯中性:顶 #f5f5f5 永不 #fff / 底 #141414 高于 #121212 下限;文字/边框/ring/input/主按钮全 `var(--neutral-N)` 单一源派生)+ status **5 色 · 方案 D**(2026-06-11 定稿:身份亮色 hue + bg 14% / border 40% `color-mix` 明暗同值,`foreground` 文字**明暗分值**[亮模深字 / 暗模亮字]保可读 —— 旧"淡底 + 同色彩字"info 仅 2.03:1 不可读,D 两态全过 AA;在 `@theme` 走干净工具类 `bg-status-error-bg` / `text-status-success-foreground` 等,早期"`@theme` tree-shake color-mix"经受控编译实测推翻、是误诊;红收窄(2026-06-13):删 destructive 实色第 6 色,全局红统一 status-error 珊瑚淡底(删除按钮 / 报错都走它,不另算红;实色错误边框[input invalid / 危险区]用 `-foreground` 深红、跟错误文字同色);节点选中 = 自身 1px 边框染 `border-status-selected`(非 ring 外环,status 同走 border 染色);dark surface 砍 elevated 幽灵层 → 四层 background/canvas/card/popover、浮层回归工业克制(dark popover #262626);全局 hover 统一 `bg-accent`、**选中态也用 `bg-accent`**(同 hover 浅色;rail / 类型选择器 / 语言·主题菜单选中统一,弃 `bg-muted` 凹陷);status 必配图标 + 文字[色盲 WCAG 1.4.1];handling = info 蓝 + spinner,locked = 中性 + 锁图标)+ 字号 10 档(base 15)/ 动效 5 档 / z 阶梯 + radius 拆分(chrome 固定 6px + content sm/md/lg/xl)+ 按钮阶梯 24/28/32/44(chrome)+ **表单控件 36px 共享高度 `--control-height`**(input/select + 表单/对话框主 CTA `size='form'` 齐高;表单控件零阴影)+ brand 限定 logo 一类(`--brand-logo-primary` 实心底 + `--brand-fg` 白字);chrome / canvas / studio 全 neutral。**治理三件套**:① token 唯一源(本文件)② `lint:no-raw-design-values`(CI 硬失败)拦设计值裸写 —— `text-[Npx]` / 抓原色阶 `[var(--neutral` / 裸 hex / `rounded-[Npx]` / 按钮阶梯 px(logo `BrandMark` + inpaint 笔刷 + `tokens.css` 豁免)③ Playwright 视觉回归基线(`pnpm test:visual`,login/register/primitives × 明暗,本地工具非 CI gate)拦视觉漂移。**2026-06-13 ③ 增 3 刚性守卫接 CI**:`lint:no-extreme-token-value`(纯中性 R=G=B + 离极值 + status WCAG AA)· `lint:1px-border`(全边框 / focus ring 1px 实色无光晕)· `lint:overlay-surface`(**两层浮层表面**:接管式面板 dialog/sheet/alert-dialog `bg-card` · 锚定浮层 popover/dropdown/select `bg-popover`)。非白名单处用 raw brand 另由 `lint:no-brand-usage` 拦(chrome-baseline §F10 Monochrome Chrome Rule)。
- **Yjs 单一真相源** — 画布节点数据 + space 元数据走 Yjs(`data/yjs/`)。节点归属(前端独占 create / delete / position、后端只改 `data` 字段)见 [Canvas collaboration](#canvas-collaboration)。
- **ChatPanel 是 per-user、不绑 Yjs** — agent 对话走 SSE 流、只属当前查看者;聊天内容永不进 Yjs。
- **Hover 规范** — `packages/web/src/` 里**禁用** Tailwind 的 `hover:bg-<token>/<两位数>` 透明度修饰(如 `hover:bg-accent/40`、`hover:bg-primary/90`)。透明默认的行 / outline / ghost 按钮用实色 token 切换(`hover:bg-accent`、`hover:bg-muted`),实色 CTA 按钮用 `transition-opacity hover:opacity-90`。**例外:`hover:bg-black/<N>` / `hover:bg-white/<N>` 放行**——black / white 是固定色(非 mode-aware token),alpha 叠加不会随 surface 混色、明暗模式读数一致,用于图片蒙层控件(如卡片缩略图上的 ⋯ 菜单)。由 `pnpm lint:hover`(CI 硬失败,放行规则在守卫脚本里)+ `components/ui/` 里 shadcn 原语默认值强制。理由:透明 hover 会跟底层 surface 混色、对比度随上下文变;实色切换 + opacity-90 跟 chrome-baseline mock 一致、跨 surface 视觉统一。
- **统一类型节点(2026-05-19)** — 每种模态一个节点:`text` / `image` / `audio` / `video` / `3d` / `web`(6 种内容类型)外加 `annotation`(独立的协作便签)和 `group`(容器节点,见下条)。不再分 asset / generator。`@` 引用是边关系 + 快照副本,**不是**一种节点类型。生成功能在节点 toolbar 左区(改当前节点);mini-tool 在右区(建一个新兄弟节点 + primary edge)。
- **节点创建入口 + 名字头(2026-06-15)** — 空节点经两入口建:左浮动菜单「节点库」下拉(4 类型)+ 画布空白处右键(`onPaneContextMenu` → 光标处)。节点库按钮在 chrome、在 `ReactFlowProvider` 外拿不到坐标 → 经 `stores/canvas.ts` 的「待建信箱」把类型传进画布,画布落在视口中心(+ 阶梯防重叠);右键直接落光标处。两入口共用 `CreatableNodeMenuItems` + 创建核心 `useNodeCreation`(工厂 `node-factory.ts` 造空节点 → 前端独占 `addNode`),建完自动选中。每个内容节点带「名字头」(模态图标 + 名,双击改名写回 Yjs;`ContentNodeFrame` 统一套在节点体上方)。viewer 只读经 `SpaceBodyProps.readOnly`(源自项目 `myRole`、经 `SpaceOutlet` 下传)在画布拦创建 / 拖拽 / 连线(ReactFlow `nodesDraggable` / `nodesConnectable` = `!readOnly`)。**前端 readOnly gate 只是纵深 + UX**(避免本地拖动后被服务端拒再弹回);**真正的写入边界在 collab 后端**——viewer 连接 = 连接级 readOnly(`hooks/auth.ts` 必 mutate 入参 `connectionConfig.readOnly`、不能靠 hook 返回值,Hocuspocus 在协议层拒每个 sync-update;canvas / document / timeline 内容文档只读**只靠连接级 readOnly**,不走 `before-handle-message` 的 `checkWriteAuthz` 按路径 gate)。**选中 / 拖拽是 per-user 本地态**(镜像 Yjs 时按节点 id 保留,不进 Yjs)。
- **画布剪贴板(2026-06-16)** — **系统剪贴板单一来源**:画布有焦点、未编辑节点时 `paste` 事件 → 若是标记载荷(`node-clipboard.ts` 的 `CLIPBOARD_MARKER`)→ 克隆节点(新 id + 偏移 24px,多选保相对位置、整组选中);否则纯文字 → 建文本节点(content = 粘的字、落视口中心)。`copy` 事件序列化选中节点(`copy`/`paste` **事件对称用 `clipboardData`**,免异步剪贴板权限弹窗)。纯函数 `node-clipboard.ts`(`serializeNodes`/`parseClipboardNodes`/`cloneForPaste`/`textToNode`)脱 DOM 单元测;userId 注入 + `addNode` 复用 `useNodeCreation`(`pasteTextAt`/`pasteNodesAt`),节点构造仍走 2a 的 `createEmptyNode`。监听挂 `CanvasSpaceInner`(document 级,gate `readOnly` + `activeElement` 可编辑)。**图片粘贴不在本片**(依赖上传编排,归上传片)。
- **节点分组 group(2026-06-19)** — `group` 是容器节点:框选 ≥2 个散节点后浮动菜单(`NodeToolbar`,锚定选区上方)点「编组」或按 `Cmd/Ctrl+G` 成组;选中一个组按 `Cmd/Ctrl+Shift+G` 或浮动菜单「取消编组」解组(只删组节点、子节点留存)。**组无权威尺寸**——容器几何在渲染层由成员包围盒 + 24px padding **派生**(`group-geometry.ts` 纯函数,不存 width/height;无手动拉伸手柄),组**渲染压在成员之下**。**拖组带子节点**:组节点本身无权威位置,拖它经 `onNodeDragStart/Drag/DragStop` 把位移 delta 施加到全部成员(`moveGroup`,一次拖一个 undo 项;**不用 ReactFlow `parentId`**、纯绝对坐标 + 派生几何)。**拖单个节点进 / 出组**:drag-end 用成员中心点对各组派生矩形碰撞判定(`group-membership.ts` 的 `resolveGroupDrop`)→ `addToGroup` / `removeFromGroup`。组属性:可选 4 个 status 背景色 + 无色(纯人工分类标签,存 token 名、渲染 `var()`)、双击改名(默认固定英文 `Group`,复用 `useInlineRename` 共用 hook、跟内容节点名字头同一套)。三条不变量:组至少 1 个子(删空自动删组)/ 成员不相交 / 组不嵌套(组保持平铺)。**组无 lock**(打组 / 解组本身就是组织维度,跟节点内容 lock 正交)。全部经 Yjs 协作同步。
- **localStorage key 集中 + 统一前缀(2026-06-08)** — 所有浏览器持久化(localStorage)key 走集中注册表 `src/lib/storage-keys.ts`(`STORAGE_KEYS.*`),全部带 `breatic.` 前缀(防同源下跟浏览器扩展 / 未来兄弟应用静默撞键)。callsite 引 `STORAGE_KEYS.*`、不硬编码裸 key 字面量;新 key 加进注册表。唯一例外:`src/index.html` 的 pre-React inline 主题脚本(模块图加载前跑、无法 import 注册表)硬编码 `breatic.preferences` 字面量,前缀仍受守卫检查。由 `lint:storage-key-prefix`(CI 硬失败)强制。

### Naming conventions

| 文件类型 | 命名 | 例 |
|---|---|---|
| React 组件 `.tsx` | `PascalCase`(= 导出名) | `Button.tsx` `ProjectMembersPanel.tsx` |
| React hook `.ts/.tsx` | `useFooBar`(= 导出名) | `useProjectSpaces.ts` `useCanvasActions.ts` |
| 其他 `.ts`(util / data / config / store) | `kebab-case` | `mini-tools.ts` `oss-client.ts` |
| 测试 | 跟被测对象同名 + `.test` | `useProjectSpaces.test.ts` |
| 目录 | `kebab-case` | `data/yjs/` `domain/space/` `features/project-members/` |

### Routing

- `/` → 重定向 `/studio`
- `/studio/*` — studio layout route(`StudioLayout`):常驻左 rail + 顶栏挂一次,子路由出 `<Outlet/>`,切 studio 不重挂 rail(chrome 改造片)
  - `/studio`(index)— 跨 studio「最近」落地页(`StudioRecentPage`;per-user,无独立分享 URL,URL 设计 §5.7 B 修正:无 `/studio/recent`)。走 `GET /api/v1/studios/recent`(挂复数 `studios` app,非 `/studio/:slug`,避 `:slug` 撞;`project_last_opened` 表按 **本人最后打开时间**倒序、访问过滤=仍可达才返〔有 active `project_members` 行 OR studio-可见且仍是 studio 成员〕,绝不漏别人私有 / 被踢 / 软删),wire `RecentItem` 经 `recent-mapper` 派生成卡片视图(`kind='project'` 常量,资产集 V2 返空)。空态被动(无创建 CTA,rail 才有创建入口)。打开任一项目时项目页挂载 `POST /api/v1/projects/:id/opened`(`recentService.recordOpen`:`assertAccess('viewer')` 门控 + composite-PK upsert `last_opened_at=now()`,StrictMode-safe 单发、best-effort、成功 invalidate recent 查询)→ 该项目浮到「最近」顶部。**建项目落点 = 跳进项目页**(decision B:`useCreateProject` onSuccess `navigate('/project/{slug}-{uuid}')`,进页即记一次打开,新项目自然入「最近」)
  - `/studio/:slug` — studio 容器(`StudioContainerPage`),按 `myStudioRole` 分叉:**成员**(非 null)= 6 tab(项目 / 资产集 / 作品 / 成员 / 积分 / 设置;作品固定第 3 位、空壳;个人 studio 也 6 tab[成员 tab 个人=只读单成员、A 方案];**team studio admin 管理成员**(片3:邀请按邮箱查已注册→建 pending invite(独立 `studio_invitations` 表)+ actionable 铃铛通知(+best-effort 邮件链接),被邀请人经铃铛点确认 / 邮件落地页确认才入伙(admin 在成员 tab 见「邀请中」pending、可撤销),accept CAS 串行化(铃铛+邮件双路只生效一次)、镜像转让握手但真相源是 invite 行非通知 / 移除单事务级联清本 studio 全项目访问+owner 项目转 admin / 改角色 creator↔member / 转让管理员两段式握手经站内通知确认+7天TTL、不收积分));**非成员**(null,decision A 公开门面 200+null)= 无 tab + 作品空态(`NonMemberView`,不下发私货)。项目 tab 走 `GET /studio/:slug/projects`(开放基线可见性过滤)、成员 tab 走 `GET /studio/:slug/members`(JOIN 各成员个人 studio 显示名;admin viewer 另带 pending invitations)+ 片3 写端点(`POST/DELETE/PATCH /studio/:slug/members` + `POST /studio/:slug/transfer-admin`,`requireStudioRole('admin')` 守门);通知系统(`notifications` per-user inbox,`expires_at` + 5 studio type〔invite_request actionable+TTL / invite_accepted / transfer_request actionable+TTL / transfer_approved / member_invited(legacy,邀请改用 invite_request)〕+ `POST /users/me/notifications/:id/action` confirm/cancel〔transfer 与 invite 共用,按通知类型分支成功 toast〕,studio 顶栏接 project `BellMenu`〔已移 `features/notifications`〕);**invite-confirm 握手**另有 `GET /studio-invitations/:token` + `POST /studio-invitations/respond`〔邮件落地页 `/studio-invite?token=`,需登录〕+ `DELETE /studio/:slug/invitations/:id`〔admin 撤销〕;建项目限 admin/creator(studio 积分共享)。**团队 studio 创建**:`POST /api/v1/studios`(`createTeamStudio` 一事务原子建 studio + 创建者 admin / slug 全局唯一 `409` 兜底〔`studios_slug_idx`〕/ per-user 限速 10 个每小时 + 每用户 ≤50 个 team studio 软上限〔按**当前 admin 角色**计数、随转让流动,**非**不可变 `created_by`〕)+ `GET /api/v1/studios/slug-available`(实时查重 `checkStudioSlug`,per-user 限速 60 每分);抽取共享 `rateLimit` middleware(`keyBy: 'ip'|'user'`,auth 8 处复用 ip 不变)。前端 rail「新建 Studio」按钮 → `NewStudioDialog`(名称 + slug 两独立必填框、无 type radio)接共享 `useSlugAvailability`(`useDebounce` 300ms + React Query queryKey 含 slug 防乱序 race + 即时输入≠debounce 时 checking 的 skew 守卫)边打边查;**个人注册设标识 `SlugSetupPage` 同款实时查重**(两处统一一套 hook);未登录受保护路由实测返 `401`(非 404)
- `/project/:projectId` — 项目页(Agent 列 + Space outlet;Space 是 Project 内的 type / 模板,**不是**路由段)
- `/project/:projectId/access` — 无权限落地页(NoAccessPage)
- `/choose-slug` — 注册第二步:选 slug → 建个人 studio(已登录但豁免个人-studio 闸门;显示文案仍叫「网址标识 / Handle」,只 URL 路径改名)
- `/login`、`/register`、`/forgot-password`、`/reset-password`、`/verify-email`、`/studio-invite`、`/project-invite` — auth + 邀请落地页(`?token=`,均需登录;project 邀请三通道汇聚此页)

### Source layout

```
packages/web/
├── public/                  # 原样提供的静态资源
├── src/
│   ├── app/                 # 入口 + provider + error boundary
│   ├── pages/               # 路由页 + 页面专属子模块
│   ├── spaces/              # Canvas / Document / Timeline
│   ├── features/            # 跨页 feature
│   ├── stores/              # Zustand store(一文件一 store)
│   ├── domain/              # 纯业务逻辑
│   ├── data/                # api / yjs / stream / storage
│   ├── ui/                  # 业务原子
│   ├── components/ui/       # shadcn 原语(vendor)
│   ├── theme/               # tokens.css(单一 token 源)
│   ├── i18n/                # locale-bootstrap + useTranslation(引擎在 @breatic/shared/i18n)
│   ├── lib/                 # 工具(cn 等)
│   ├── styles/              # 全局 css 覆盖
│   ├── App.tsx · index.tsx · index.css · index.html
├── tests/                   # Playwright 端到端
├── components.json          # shadcn 配置
├── tailwind.config.ts · vite.config.ts · tsconfig.json · postcss.config.js
└── package.json
```

### Environment variables

所有 `VITE_*` 变量从 monorepo 根 `.env` 读。前端经相对 URL(`/api/*`、`/ws`、`/uploads/*`)跟后端通信;一个反向代理(生产用 nginx、dev 用 Vite dev proxy)把它们路由到 api / collab 容器。构建产物里不写死任何 host。

| 变量 | 用途 |
|---|---|
| `VITE_APP_VERSION` | app 版本号字符串 |
| `GOOGLE_CLIENT_ID` | Google OAuth(可选;注入为 `__GOOGLE_CLIENT_ID__`) |
| `VITE_SENTRY_DSN` | Sentry DSN(可选) |

鉴权基于 cookie — 后端在登录 / 注册 / OAuth 时种一个 httpOnly 的 `breatic_session` cookie;前端不在 JS 里读或存任何 token。服务端环境变量 `COOKIE_DOMAIN` + `EMAIL_BACKEND` 见 [Configuration files](#configuration-files) 段(后端)。

## Coding standards (function definition format)

本节是 breatic 全栈(`core` / `server` / `worker` / `collab` / `shared` / `web`)的**函数定义格式规范**:一个函数定义"长什么样"——它的文档注释、参数描述、返回类型、异常类型该写在哪、怎么写。规范由 ESLint 在 CI 强制(error 级,违反即 fail)。

这是 CLAUDE.md「代码风格」段 + 禁止清单 #11 的细节展开。CLAUDE.md 写 mandate(红线),本节写完整规则 + 理由 + 示例 + 强制点。

### 核心原则

> **类型信息归签名(代码,显式);功能描述归注释;签名表达不了的那一件事(异常类型)也归注释。**

一个函数定义由两部分组成,各管各的、互不重复:

1. **签名(signature)** —— 携带**全部**类型信息(参数类型、返回类型、生成器 yield/next 类型),全部**显式**写在代码里。TypeScript 能静态检查、能随重构自动跟随,是类型的唯一真相源。
2. **文档注释(TSDoc)** —— 携带**功能描述**(这函数做什么、为什么、每个参数代表什么),外加**唯一一件签名表达不了的类型信息:异常类型**(TS 没有 checked exception,编译器不追踪 `throw` 的类型)。

把类型写进注释(如 `@param {string} name`)是被**禁止**的:类型已经在签名里了,注释里再写一遍就是两个真相源,重构改了签名、注释不改 → "代码 ↔ 注释"长期漂移。注释只做签名做不到的事。

### 信息归属表

| 信息 | TS 签名能表达吗? | 写在哪 | 强制规则 |
|---|---|---|---|
| 参数类型 | 能 | **签名**(显式) | `jsdoc/no-types`(注释里禁写类型) |
| 返回类型 | 能 | **签名**(显式) | `explicit-function-return-type` + `jsdoc/no-types` |
| 生成器 yield / next 类型 | 能(`Generator<Y, R, N>` / `AsyncGenerator<Y, R, N>`) | **签名**(显式) | `explicit-function-return-type`;`require-yields-type` / `require-next-type` 关闭(同返回值,不在注释写) |
| **异常类型** | **不能**(无 checked exception,编译器不追踪) | **注释** `@throws {ErrorType}` | `require-throws-type`(带花括号,error) |
| 功能描述(做什么 / 为什么 / 每个参数含义) | 不能 | **注释** 摘要行 + `@param name - desc` / `@returns desc` | `require-jsdoc` / `require-description` / `require-param` / `require-returns` |

一句话:**能被 TS 签名表达的类型,一律进签名、不进注释;唯独异常类型签名表达不了,进注释 `@throws {ErrorType}`。**

### 5 条规则

#### 规则 1 — 显式返回类型(explicit return type)

每个**命名函数单元**(见「适用范围」)必须在签名里**显式写返回类型**,不依赖 TS 推断。生成器写 `Generator<Y, R, N>` / `AsyncGenerator<Y, R, N>`(yield/next 类型也由此携带)。

```ts
// ✅ 正确:返回类型显式
function computeCredits(usage: Usage): number { ... }
const toEntity = (row: CreditRow): CreditBalance => { ... };
async function* streamTokens(prompt: string): AsyncGenerator<string> { ... }

// ❌ 错误:返回类型靠推断
function computeCredits(usage: Usage) { ... }
```

**内联匿名回调豁免**(`allowExpressions: true`):`arr.map(x => x * 2)`、事件 handler 等不是命名 API 表面,强制反而是噪音。

#### 规则 2 — 文档注释(TSDoc block)

每个命名函数单元必须有 TSDoc 块,且块内必须有**一行摘要描述**(说清这函数做什么)——不能只有 `@param`/`@returns` 标签没摘要(`require-description`,规则只有 0/1,摘要不留"可选"口子)。**不分导出 / 私有**:私有 helper 跟导出函数一样需要文档(不按可见性把同类切两半)。

```ts
/**
 * Deduct credits for one AIGC task, idempotent on refKey.
 *
 * @param userId - owner whose balance is charged
 * @param amount - credits to deduct (must be > 0)
 * @param refKey - idempotency key; a repeat call with the same key is a no-op
 * @returns the balance remaining after deduction
 * @throws {AppError} INSUFFICIENT_CREDITS when balance < amount
 */
async function deductOnce(userId: string, amount: number, refKey: string): Promise<number> { ... }
```

#### 规则 3 — 注释里禁写类型(no-types)

`@param` / `@returns` 只写**描述**,不写类型——类型已在签名里。

```ts
// ✅ 正确
/** @param name - the user's display name */
/** @returns the remaining balance */

// ❌ 错误:类型重复进注释,制造 code↔comment 漂移源
/** @param {string} name - the user's display name */
/** @returns {number} the remaining balance */
```

#### 规则 4 — 异常类型带花括号(`@throws {ErrorType}`)

异常类型是签名表达不了的唯一一件类型信息,所以**写在注释里,且带花括号**结构化标注。

```ts
// ✅ 正确:异常类型签名携带不了,带花括号写进注释
/** @throws {AppError} NOT_FOUND when the project does not exist */

// ❌ 错误:只写散文、没有结构化的异常类型
/** @throws when the project does not exist */
```

这是与规则 3 的**刻意反差**:`@param`/`@returns` 禁类型(签名有),`@throws` 必须有类型(签名没有)。两条规则方向相反,但同一个判定标准——**签名能不能表达**。

#### 规则 5 — 生成器类型不进注释(yields/next 关闭)

`@yields` / `@next` **不要求**写类型,因为 yield/next 类型由 `Generator<Y, R, N>` 签名携带,跟返回值同理(规则 1 已覆盖)。`require-yields-type` / `require-next-type` 关闭。

### 适用范围

#### 命名函数单元(必须遵守)

- 函数声明 `function f() {}`
- 类方法 `class C { method() {} }`
- 类声明 `class C {}`(`require-jsdoc` 要求类有文档)
- 变量赋值的箭头函数 / 函数表达式 `const f = () => {}` / `const f = function () {}`
- 类字段赋值的箭头 / 函数表达式 `class C { f = () => {} }`

#### 豁免

| 豁免项 | 理由 |
|---|---|
| 内联匿名回调(`arr.map(x => ...)`、event handler、`Promise` executor 等) | 父节点是 `CallExpression` 而非 `VariableDeclarator`,不是命名 API 表面;强制是噪音 |
| 测试代码(`*.test.{ts,tsx}` / `*.spec.{ts,tsx}` / `__tests__/`) | 项目既有的 test-fixture 豁免 |
| shadcn vendor(`web` 的 `components/ui/`) | 第三方原语,不按本项目规范改(vendor 边界,见 [Frontend](#frontend)) |

### CI 强制

规范由 ESLint(error 级)在 `pnpm lint` 强制,违反即 CI fail。两套配置分别覆盖:

| 配置文件 | 覆盖包 | ESLint 版本 |
|---|---|---|
| 根 `eslint.config.mjs` | `core` / `server` / `worker` / `collab` / `shared` | 根 ESLint |
| `packages/web/eslint.config.mts` | `web` | web 自带 ESLint 9 |

两套配置启用**同一组规则**:

- `eslint-plugin-jsdoc` 的 `flat/recommended-typescript-error` 预设(给 TS 项目:关闭 `require-param-type` / `require-returns-type`、开启 `no-types`)
- `jsdoc/require-jsdoc`:全量(`publicOnly: false`),覆盖上述全部命名函数单元;内联回调经 `contexts` 选择器排除
- `jsdoc/require-description`:`error`——每个块必须有一行摘要描述,不只是标签(规则 2)
- `jsdoc/require-throws-type`:`error`(规则 4)
- `jsdoc/require-yields-type` / `jsdoc/require-next-type`:`off`(规则 5)
- `@typescript-eslint/explicit-function-return-type`:`["error", { allowExpressions: true }]`(规则 1)

这一组规则取代了原先 `eslint-plugin-tsdoc` 单一的 `tsdoc/syntax: warn`(all-or-nothing,挡不住低质量注释)。

### 反例速查

| 反例 | 为什么错 | 改成 |
|---|---|---|
| `function f(x: number) { return x; }`(无返回类型) | 返回类型靠推断 | `function f(x: number): number` |
| `const f = () => {}`(无文档) | 命名函数单元缺 TSDoc | 加 `/** ... */` |
| `/** @param {string} name */` | 类型重复进注释 | `/** @param name - ... */` |
| `/** @throws on error */` | 异常类型没结构化 | `/** @throws {AppError} ... */` |
| 只给导出函数加文档、私有 helper 裸奔 | 按可见性切同类(违反 0/1 原则) | 私有 helper 一样补文档 |

### 文件头:版权 + 许可声明

每个**首方 TypeScript 源文件**(`packages/*/src/**/*.{ts,tsx}`,含测试)顶部必须有两行 SPDX 文件头:

```ts
// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
```

`LicenseRef-BOSL-1.0` = Breatic Open Source License 1.0(改良版 Apache 2.0,见仓库根 `LICENSE`);`LicenseRef-` 前缀是 SPDX 对自定义许可的标准写法。

- **豁免**:shadcn vendor(`web` 的 `components/ui/`)—— 第三方 IP,不挂 Orime 版权。
- **CI 强制**:`lint:no-missing-license-header`(扫 `packages/*/src` 的 `.ts`/`.tsx`,排除 vendor + `dist` + `node_modules`;新文件缺头即 fail)。
- **一次性补全**:`scripts/add-license-headers.sh`(幂等——已有头的文件跳过,可随时重跑)。
