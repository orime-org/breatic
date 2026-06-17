# Roadmap

## Alpha — Core Flow（让整个链路跑通）

**目标**：一个用户能打开画布 → 和 Agent 对话 → 生成 AIGC 内容 → 看到结果。

### API + Worker

- [x] 前后端 API 对接：shared Zod schemas，8 个前端 API 文件，类型共享
- [x] API key 配置 + Agent 聊天验证：OpenRouter + WaveSpeed 实测通过
- [x] AIGC 图片生成全链路：canvas/tasks → Worker → WaveSpeed → 下载 → 本地存储
- [x] Storage 统一重构：Transport 返回 raw bytes，Worker 统一 persist（buffer 上传 + CDN 下载）
- [x] 模型目录精简：~102 → 50 个模型，只保留顶尖模型
- [x] AIGC 调用耗时记录：tasks 表 duration_ms 列，performance.now() 计时
- [x] 阿里云 OSS 存储：AIGC 结果上传 OSS，CDN 前缀 resource.visiony.cc
- [x] WaveSpeed 参数修复：null 值过滤 + MiniMax lyrics fallback
- [x] Image + Audio 模态验证：nano-banana-pro (54s) + minimax-music-2.5 (119s) 全链路通过
- [x] 全模态 AIGC 验证：Video/TTS/3D 全部通过，含 OSS 存储 + durationMs
- [x] 视频封面提取：ffmpeg 抽首帧上传为 cover_url
- [x] Drizzle migration：last_consolidated_turn、tokens_used、model、provider 已就位
- [ ] 集成测试：testcontainers 真实 PG + Redis，覆盖核心链路

### Collab

- [x] Yjs 文档结构规范：canvas Map-of-Maps schema、状态机、事件流、锁语义已落地；CanvasNodeFields + AttachRef 共享类型在 @breatic/shared
- [x] Canvas 节点同步：Redis Streams + 节点锁，API/Worker/Collab 三方事件驱动写入 canvas.nodesMap
- [x] Canvas Yjs-first 同步架构：前端写操作直接写 Yjs nodesMap/edgesMap，observe 回调同步 Redux（只读缓存），删除旧的 Redux↔Yjs 双向桥
- [x] Canvas 嵌套 data Y.Map：节点结构镜像 ReactFlow `{ id, type, position, data }`，增量 observe 只重建变更节点
- [ ] Awareness 集成：光标位置、在线用户列表、正在编辑的节点高亮

### Frontend

- [x] 前端组件迁移：27 组件从 useProjectStore 迁移到 useCanvasData/Actions/UI
- [x] 安全加固：XSS 清洗（DOMPurify）、Auth 限速、FK restrict、锁 CAS 验证、presign 安全、prompt 提取
- [x] 测试覆盖恢复：17 文件 65 测试（从 5 文件 21 测试）
- [ ] 前后端联调：SSE 流式聊天跑通，AIGC 任务状态同步
- [ ] 模型参数动态表单：根据 `GET /api/v1/models` 返回的 params 动态渲染 UI（模态模板 + tier 过滤）
- [ ] 认证页面：登录 / 注册 / Google OAuth 对接后端 auth 路由
- [ ] Agent 聊天界面：SSE 流式输出 + plan 确认交互

### DevOps

- [x] Docker build 验证通过（CI + 本地）
- [x] 日志系统：pino-roll daily rotation，per-service 子目录（api/worker/collab/nginx），双时间戳（ISO + epoch）
- [x] Logger 改为 initLogger(serviceName) 模式，Worker 显式调用 initLogger("worker")
- [x] Nginx 日志轮转：logrotate，30 天保留，日志写到 logs/nginx/
- [x] Pre-commit hook：拦截 .env 和密钥文件
- [x] Docker 镜像优化：pnpm deploy --filter，1.12GB → 357MB（-68%）
- [x] DB auto-migrate：API + Worker 启动时自动运行 Drizzle migration
- [x] Nginx 反向代理：前端容器 73MB，统一入口 port 80，SSE + WebSocket proxy
- [x] Nginx SSL auto-detect：entrypoint.sh 检测证书，自动选择 HTTP/HTTPS
- [x] VITE_* build-arg：Docker build 时从 .env 传入前端环境变量
- [x] Redis 拆分为 3 个逻辑 DB（REDIS_URL/REDIS_QUEUE_URL/REDIS_STREAM_URL）
- [x] Package exports → dist/，turbo dev dependsOn ^build，消除 import.meta.dirname 脆弱性
- [x] .env.dev + .env.docker 双模板，替代 .env.example
- [x] 登录页完整修复：response parsing、用户信息显示、Google OAuth 头像同步、401 循环修复
- [ ] CD pipeline：GitHub Actions → Docker build → 自动部署

---

## Beta — User Ready（用户可以日常使用）

**目标**：创作者能注册、充值、创作完整的多模态项目。

### 产品功能

- [ ] 积分购买页面：Stripe Checkout 跳转 + 余额显示 + 购买历史
- [ ] 项目管理：创建/删除/重命名项目、项目列表、缩略图
- [ ] 节点交互（canvas-native，PR-C 起）：
  - text 富文本：✅ TipTap 富文本编辑器（左侧全屏面板，绑定 `data.prompt` Y.XmlFragment）
  - canvas-native mini-tools：image.crop / image.adjust / image.remove-bg / video tools / audio tools 逐条接入（前端 `new/` 分支开发中）
  - 节点悬浮菜单（selected 节点上方）+ 底部工具栏：PR-C 范畴
  - text mini-tools UI：10 个 text mini-tool 的 slash-menu 接入待确认
- [x] **i18n 前端接入（PR #117, 2026-05-22）**：前后端共享 `@breatic/shared/i18n`（`intl-messageformat` / ICU 引擎），web 通过 `useTranslation` hook + `locale-bootstrap` (`localStorage` → `navigator.languages` → `en`)；TopBar `LangSwitcher` 切换语言；`pnpm lint:no-cjk` CI gate 防 hardcoded CJK 回潮

### 画布协作

- [x] 节点编辑器文档（Phase 1）：per-node Yjs 文档 `project-{id}/node/{nodeId}` 支持文本/混合编辑器 —— PR #138 + #140。已在 Phase 2 替换为 canvas-native 模型（见下方 Phase 2）
- [x] **Phase 2: canvas-native 架构前向修复（PR #13 后端 + PR #14 前端）**：单项目 Yjs 文档（`project-{id}`），取消 per-node 编辑器子文档；NodeStateUpdateEvent 统一事件形态（替代 handling/completed/failed 三事件）；节点状态机 idle/handling（Yjs）+ localPending（本地）；后端不再持有 per-node Redis 锁；操作产生新兄弟节点；1:N 支持（targetNodeIds）
- [x] **画布撤销/重做（PR #243）**：per-space `Y.UndoManager`（每个 space 一个），追踪本客户端的结构 / 元数据 / 名称写入（建/删/移动/锁/改名节点 + 建/删边），后端内容写（`node-state-update` origin）与视口操作不进栈；per-client 隔离、深度 50、刷新清栈；工具栏按钮 + 键盘双平台（Cmd/Ctrl+Z、Cmd+Shift+Z、Ctrl+Y）
- [ ] 文档权限控制：onAuthenticate 中按 project 成员关系校验，支持 readOnly
- [ ] 多实例负载均衡验证：Redis extension 跨实例同步测试

### AI 能力

- [ ] Canvas Skill：各模态智能模式 Skill（scope: canvas，单次执行，直接生成）
- [ ] 模型推荐引擎：Agent 根据用户意图自动选择最佳模型，不需要用户手动选

### 安全

- [ ] Skill 安全分级：内置 Skill 可用 run_script，第三方禁止；未来按需开放 isolated-vm / Docker 沙箱 / Webhook
- [x] 上传改为 presigned URL：`GET /assets/presign` → 直传 S3/OSS/本地，前端不持有 credentials

---

## GA — Public Launch（公开发布 + 开源社区）

**目标**：稳定运行、全球可用、社区可贡献。

### 平台

- [ ] MCP Server 层：暴露 breatic_chat / breatic_create_task / breatic_list_skills 给外部 AI 调用
- [ ] Skill 市场基础：Skill 提交 / 审核 / 安装流程
- [ ] 文档 GC 策略：定期清理孤立 Yjs 文档（项目已删除但 yjs_documents 还在）

### 运营

- [ ] 前端部署到 CDN（Vercel / Cloudflare Pages）
- [ ] CD Pipeline：GitHub Actions → Docker build → 自动部署
- [ ] 监控：Sentry 错误追踪 + 基础性能指标
- [ ] CONTRIBUTING.md：贡献指南、Code of Conduct、PR 模板

---

## Post-GA — v2 Features（产品升级，下个大版本）

**目标**：在 GA 稳定基础上加入团队 / 组织 / 跨项目协作能力,把 breatic 从「个人 + 项目级协作」扩展到「团队 + 组织级协作」。

### Team / Organization

- [ ] **Team / Organization 概念**：引入 team / org 中间层(user 属于 team,team 拥有项目)
  - 数据库:加 `teams` / `team_members` 表 + `projects.team_id`
  - 角色:team admin / team member 跨项目权限继承
  - 邀请:team 邀请代替单项目邀请;邀请到 team 自动获得 team 所有项目访问
  - share link 扩展:「team 内任何人可凭 link 进」选项(类似 Figma 的 organization-level 链接)
  - 计费:积分包绑 team 共享 / 转移 / 配额管理
  - 跨项目搜索 / dashboard:team 维度看所有项目
- [ ] **Owner 转让流程**:team 模式下 project owner 可转给 team 内其他 member(当前 owner 永久绑定创建者)

---

## 待跟进（已识别但不在当前 PR scope）

这里记单 commit 不修但已经定位/部分定位的 dev 体验和 runtime 韧性问题。每条都对应一个独立 PR，开启时需要完整 DD + 复现验证。

### dev:collab 长跑 connection drift —— 治根 PR

**触发现象**：dev:collab 单进程跑 ≥ 几小时后，`onAuthenticate` 在 postgres-js 连接池里拿到 stale connection（Postgres 默认 30 min 关 idle conn，client 不感知），所有新 WS 握手都报 `authenticationFailed`，前端 banner `登录已失效` 永远不消。重启 collab 立即恢复。`docs/DEPLOY.md` 已加 dev runbook 教 user 出现就 restart。

**真治根工作（独立 PR）**：

- `packages/collab/src/auth.ts` — `onAuthenticate` 包 `try { ... } catch (err) { logger.error({ err, userId, documentName }, "onAuthenticate fail"); throw err; }`，让 server-side 错误链不再静默
- `packages/collab/src/auth.ts` — `postgres(databaseUrl, { max: 5, idle_timeout: 60, max_lifetime: 30 * 60 })`，让 client 主动 recycle 比 PG 默认 idle timeout 短的 connection
- `packages/core/src/infra/redis.ts` + collab 各 ioredis 实例 — 评估 `keepAlive` / `connectTimeout` / `reconnectOnError` 是否需调
- `packages/collab/src/index.ts` — 加 `GET /healthz` endpoint ping PG + Redis + Hocuspocus 就绪，LB / docker healthcheck 看 N 次 fail 后 kill instance
- 复现验证：本地起 collab，手动 `psql` 关掉 dev:collab 持有的 connection（或等 idle_in_transaction_session_timeout 触发），观察 onAuthenticate 是否 throw、新 query 是否能自动复活
- 上游参考：[Hocuspocus #716](https://github.com/ueberdosis/hocuspocus/issues/716) Firefox/Safari 30s "Unauthorized" close、[#566](https://github.com/ueberdosis/hocuspocus/issues/566) v2 重连不重发 auth token

**Why 不挤进当前 PR**：postgres-js 配置 + healthz endpoint + error logging 三处改动都是治根但**没有真的 23 小时复现验证就 ship 等于猜根因**。memory `feedback_existing_infra_verify_before_dd` 强 mandate：关键路径（鉴权 + Yjs 协作）fix 必须真复现 + 验证，不能配置猜。独立 PR 单独走 DD + 复现 + 验证。

**状态更新（2026-05-27 PR #155 + 2026-05-28 PR）**：上面五个治根 bullet 已全部 ship：

- ✅ collab `onAuthenticate` try/catch + 5 reason logger.warn（PR #155 commit `4a79f6f`）
- ✅ `createPgClient` factory `idle_timeout: 30` + `max_lifetime: 1800`（PR #155 commit `f078289`，collab 所有 raw `postgres()` 调用走 factory）
- ✅ `createRedisClient` factory `keepAlive: 30000` + `commandTimeout: 5000` + `connectTimeout: 10000` + `reconnectOnError` READONLY（PR #155 commit `7916358`，collab 所有 raw `new IoRedis()` 走 factory）
- ✅ `/healthz` 三 service 都 expose（PR #155 commit `2b4fb95` worker + collab；2026-05-28 PR server 也加了，全 `主+1` port）
- ✅ docker-compose `healthcheck:` 接线（2026-05-28 PR）— 自愈链路闭环

### Observability —— Prometheus `/metrics` + Grafana dashboard 待办

**Why 现在不做**：CLAUDE.md "服务器端工业级标准" 7 件套中的「安全监控（生产 metrics 看 trend 提前预警）」当前只落地了结构化 log，没有 metrics 时序数值。endpoint 在 (`/healthz` 200/503 + `lint:no-library-logger` clean) 后已经是工业级最小集，但 metrics 上报 + dashboard 需要 backend monitoring sprint 单独规划（Prometheus 自托管 vs Grafana Cloud / managed Mimir 选型 + docker-compose 加 prometheus + grafana service + 各 service 加 `prom-client` 暴露 `/metrics`）。

**真治根工作（独立 PR / sprint）**：

- `packages/server/src/index.ts` + worker + collab —— 加 `prom-client` 暴露 `GET /metrics`（建议放在 health server 同一 port，例如 api 3001/metrics）
- `packages/core/src/infra/` 加 metric 工具（counter / histogram / gauge wrapper），让 service 调用方一行声明指标
- `packages/server/src/middleware/` 加 HTTP request count / latency / 5xx rate metric collector
- `packages/worker/src/` 加 BullMQ queue depth / job latency / failure rate metric collector
- `packages/collab/src/` 加 active connections / messages per second / awareness peers metric collector
- `docker-compose.yml` 加 `prometheus` + `grafana` service + volume + 基础 dashboard JSON
- `docs/DEPLOY.md` 加 metrics 维度说明

**Why 不挤进当前 PR**：metrics 工程量大（每个 service 接 prom-client + 选 metric 维度 + Prometheus / Grafana 部署 + dashboard 设计），跟 healthz binary check 是正交主题；先把 healthz 自愈链路彻底闭环再走 metrics 上报，避免一锅塞两个独立工程主题让 reviewer 难审。等 backend monitoring sprint 启动时单独 PR。

### BellMenu 在 Studio 页 —— 跨页通知统一待办

**Why 现在不做**：BellMenu 通知组件（待审批的角色升级请求 / 成员加入通知 / 未读消息 等）在 Project 页右上角已经落地，但 Studio 页右上角同样应该出现（项目列表视角下，user 也需要看跨项目的待办 / 通知）。Project 页 BellMenu 已闭环；Studio 页要单独做，避免让一个 PR 同时碰 chrome layout 在两个页面的差异（Studio chrome 跟 Project chrome 是不同的 IA layer）。

**真治根工作（独立 PR）**：

- `packages/web/src/pages/studio/shell/` —— Studio chrome 加 BellMenu 渲染（复用 Project 页 `packages/web/src/pages/project/chrome/top-bar/BellMenu.tsx` 组件 或抽到 `web/src/features/notifications/`）
- 跨页 notifications data hook：根据当前用户身份 fetch 所有 project（owner role）的 pending 通知（角色升级请求等）聚合
- Studio 页 BellMenu popover：列出按 project 分组的待办项 + 点击跳到对应 project 的 BellMenu 流
- 跨 chrome 共享样式 token + i18n key

**Why 单独 PR**：Studio chrome 自身还在 v14 重启过程中（参考 memory `project_web_v14_rewrite`），改动节奏跟 Project chrome 不一致；叠 Studio chrome layout 改动会让 PR 难审。先在 Project 页把通知链路彻底闭环，Studio 页等 Studio chrome v14 stabilize 后单独 PR。
