# Bug Backlog(Active)

当前所有活跃未修复的 bug 一览。**本文件是状态机**——每条 bug 从发现到关闭都在这里更新。详细分析(代码片段、问题根因、修复方案、验证步骤)按发现事件归档在 `audit/YYYY-MM-DD-round-N-found.md`。

**状态标记**:`[ ]` 待修 · `[~]` 进行中 · `[x]` 已修(修完即移除本行并追加到月度归档)· `⚫ 不修`(附原因,保留可追溯)

**当前总计**:157 个活跃条目(P0 × 15 + P1 × 72 + P2 × 69 + 长期 × 1)· 1 个不修(BUG-034)

> **本分支(`bugs_list`)职责**:审计、核查、维护本文档。不做修复代码改动。修复请另开分支或在 `breatic` 主 clone 进行。

---

## P0 — 立即修(安全 / 数据完整性 / 部署阻塞)

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-030 | 🔴 HIGH | Rate limiter X-Forwarded-For 绕过 | `core/src/infra/rate-limiter.ts` + `nginx.conf` | R2 | 45m | [→](audit/2026-04-15-round-2-found.md#bug-030-rate-limiter-可被-x-forwarded-for-绕过high) |
| BUG-032 | 🔴 HIGH | Presigned URL 修复遗漏 3 子问题 | `server/src/routes/assets.ts` + `core/src/infra/storage/s3.ts` | R2 | 2.5h | [→](audit/2026-04-15-round-2-found.md#bug-032-presigned-url-修复只做了-47-子问题high) |
| ~~BUG-034~~ | ⚫ 不修 | Docker 端口暴露到公网(由防火墙处理) | `docker-compose.yml` | R2 | — | [→](audit/2026-04-15-round-2-found.md#bug-034-docker-compose-端口暴露到公网high) |
| BUG-049 | 🔴 HIGH | Worker HTTP 响应无大小限制 → OOM | `worker/src/providers/http.ts:76` | R3 | 45m | [→](audit/2026-04-17-round-3-found.md#bug-049) |
| BUG-050 | 🔴 HIGH | Spawn 无深度限制 → 无限递归耗光积分 | `core/src/agent/tools/spawn.ts:105` | R3 | 1h | [→](audit/2026-04-17-round-3-found.md#bug-050) |
| BUG-051 | 🔴 HIGH | TextNode 同步路径 innerHTML 未 sanitize → 存储 XSS | `web/.../textNode/TextNodeContent.tsx:141` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-051) |
| BUG-112 | 🔴 HIGH | Agent 聊天 SSE 无 abort 处理 —— 客户端断线 LLM + 工具链仍跑到 maxStep 并扣积分 | `server/src/routes/chat.ts:79,145` + `server/src/agent/main-agent.ts:131` | R5 | 1h | [→](audit/2026-04-22-round-5-found.md#bug-112) |
| BUG-113 | 🔴 HIGH | `run_script` symlink 可穿透 + `.ts` 触发 npx tsx 供应链 + HOME env 继承 | `core/src/agent/tools/run-script.ts:54` | R5 | 1.5h | [→](audit/2026-04-22-round-5-found.md#bug-113) |
| BUG-127 | 🔴 HIGH | `/skills/market?tags=` raw SQL injection(`sql.raw` + 单引号包裹未转义 user tags) | `core/src/modules/skill.repo.ts:112` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-127) |
| BUG-128 | 🔴 HIGH | `POST /auth/forgot-password` Host Header Injection → 账户劫持 | `server/src/routes/auth.ts:197` + `core/src/modules/auth.service.ts:187` | R5 | 20m | [→](audit/2026-04-22-round-5-found.md#bug-128) |
| BUG-153 | 🔴 HIGH | ffmpeg.wasm 核心从 `cdn.jsdelivr.net` 动态加载,无 SRI / CSP / fallback → CDN 污染即客户端 RCE | `web/src/utils/video{Adjust,Crop,Cut,Speed,Stabilization}WithFfmpeg.ts`(5 文件) | R6 | 3-4h | [→](audit/2026-04-23-round-6-found.md#bug-153) |
| BUG-154 | 🔴 HIGH | ffmpeg 输出 `blob:` URL 直接写 `data.content`,刷新即失效 + 永不 revoke(违反 AIGC 持久化架构) | `web/src/hooks/useMixedEditorStore.ts:615` (`resolveVideoResultNode`) | R6 | 1d | [→](audit/2026-04-23-round-6-found.md#bug-154) |
| BUG-173 | 🔴 HIGH | `POST /mini-tools/text` `Idempotency-Key` 含非 REFKEY_PATTERN 字符时 **`catch {}` 静默吞错 → 用户拿完整 AI + 0 扣费**(扣费绕过,等价 BUG-079 级) | `core/src/modules/text-tool.service.ts:215` (`catch {}`) + `server/src/routes/text-tools.ts:46` | R7 | 20m | [→](audit/2026-04-23-round-7-found.md#bug-173) |
| BUG-186 | 🔴 HIGH | git history 4-25 被无解释 force push 重写,402 commit 全部重新计算 SHA,所有 closed bug 引用的 12+ 个 fix commit hash 全部失效 → 审计反查链全断 | `docs/internal/BUGS.md` + `docs/internal/audit/*.md`(整个反查体系)+ 整个 git 历史 | R9 | 1.5h(docs 改用 PR 号引用 + 维护 hash 映射表)— **由 [INC-2026-04-25-001](INCIDENTS/2026-04-25-history-rewrite-rca.md) 统一处置** | [→](audit/2026-04-25-round-9-found.md#bug-186) |
| BUG-187 | 🔴 HIGH | cutoff 前约 400 commit 缺基础设施文件(`pnpm-workspace.yaml` / `tsconfig.base.json` / `agents/*.md` / `eslint.config.mjs` / `.husky/commit-msg` 等) → `git bisect` / 历史回滚 / Postmortem 重现全部失效 | 4-10 ~ 4-25 17:25 之间约 400 commit | R9 | TBD(filter-repo 反向写 ~ 4-8h vs 接受现状 + warning ~ 30m)— **由 [INC-2026-04-25-001](INCIDENTS/2026-04-25-history-rewrite-rca.md) 统一处置** | [→](audit/2026-04-25-round-9-found.md#bug-187) |
| BUG-192 | 🔴 HIGH | AI 聊天前端 `handleSend` 是 `setTimeout(..., 3000)` mock,完全不调任何 API/SSE → 核心 AI 协作功能在前端不通,后端 Agent + SubAgent + 三层记忆全空跑(影响 R3~R8 chat 链路审计的"前端在调"基础假设) | `web/src/apps/project/components/agent/AiChatRecordPanel.tsx:309-330` | R10 | 补功能(非简单 fix);dev PR 必须明确"是否 regression vs from day 1" | [→](audit/2026-04-25-round-10-found.md#bug-192) |
**P0 小计**:15 个活跃 · 预估 **~15 小时 + BUG-192 补功能工时**(BUG-034 不计入,已标不修;BUG-187 / BUG-192 工时方案待决)

---

## P1 — 本周修

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-035 | 🟠 MED | Lua 锁释放脚本 null taskId 处理 | `core/src/infra/canvas-lock.ts:109` | R2 | 10m | [→](audit/2026-04-15-round-2-found.md#bug-035-lua-锁释放脚本-null-taskid-处理medium) |
| BUG-036 | 🟠 MED | 6 张 memory 表 `deletedAt` filter 缺失 | `core/src/modules/*.repo.ts` | R2 | 1h | [→](audit/2026-04-15-round-2-found.md#bug-036-6-张表-deletedat-filter-审计medium) |
| BUG-037 | 🟠 MED | RightToolbar 上传绕过 presign 流程 | `web/.../textEditor/ui/RightToolbar.tsx` | R2 | 1h | [→](audit/2026-04-15-round-2-found.md#bug-037-文本编辑器工具栏上传绕过-presign-流程medium) |
| BUG-038 | 🟠 MED | Credit Transaction 隔离级别未设置 | `core/src/modules/credit.service.ts:50` | R2 | 30m | [→](audit/2026-04-15-round-2-found.md#bug-038-credit-transaction-隔离级别未设置medium) |
| BUG-039 | 🟠 MED | DOMPurify ALLOWED_TAGS 过度严格 | `web/src/utils/sanitize.ts` | R2 | 20m | [→](audit/2026-04-15-round-2-found.md#bug-039-dompurify-allowed_tags-过度严格medium) |
| BUG-040 | 🟠 MED | Undo/Redo 跨 Tab 污染 | `web/src/utils/yjsProjectManager.ts` | R2 | 10m | [→](audit/2026-04-15-round-2-found.md#bug-040-undoredo-跨-tab-污染medium) |
| BUG-041 | 🟠 MED | CanvasDataContext Re-render 风暴 | `web/src/contexts/CanvasDataContext.tsx:116` | R2 | 1h | [→](audit/2026-04-15-round-2-found.md#bug-041-canvasdatacontext-re-render-风暴medium) |
| BUG-054 | 🔴 HIGH | NoAccount 模式只守 prod,staging 可绕过 | `server/src/middleware/auth.ts:60` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-054) |
| BUG-055 | 🔴 HIGH | Skill metadata.json 解析失败静默 fallback → scope 绕过 | `core/src/agent/skills-loader.ts:346` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-055) |
| BUG-056 | 🔴 HIGH | Worker polling 无单次请求超时 → Worker 挂起 | `worker/src/providers/http.ts:129` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-056) |
| BUG-057 | 🟠 MED | 密码无最大长度(bcrypt DoS) | `shared/src/schemas/api.ts:17,23` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-057) |
| BUG-058 | 🟠 MED | Collab PG 持久化 `store` 无 try-catch → 静默数据丢失 | `collab/src/persistence.ts:30` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-058) |
| BUG-059 | 🟠 MED | 事件流 parse 失败时立即更新 last-id → 流永久污染 | `collab/src/event-stream.ts:91` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-059) |
| BUG-060 | 🟠 MED | Checkout webhook 处理无事务包裹 → 扣费与审计错位 | `core/src/modules/payment.service.ts:96` | R3 | 45m | [→](audit/2026-04-17-round-3-found.md#bug-060) |
| BUG-061 | 🟠 MED | `addCredits` 接受负数 | `core/src/modules/user.repo.ts:136` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-061) |
| BUG-062 | 🟠 MED | `deductCredits` 接受 0/负数 → 负数扣费变加钱 | `core/src/modules/user.repo.ts:122` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-062) |
| BUG-063 | 🟠 MED | Worker 无 Docker healthcheck | `docker-compose.yml:85` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-063) |
| BUG-064 | 🟠 MED | Webhook 不校验 `creditsGranted` 金额 | `core/src/modules/payment.service.ts:85` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-064) |
| BUG-065 | 🟠 MED | 密码重置 token 无尝试次数限制 | `core/src/modules/auth.service.ts:206` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-065) |
| BUG-080 | 🟠 MED | BUG-052 兄弟 FK 遗漏(conversation_attachments / project_memory_entries) | `core/src/db/schema.ts:235,410` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-080) |
| BUG-084 | 🟠 MED | NoAccount 下不再回写 localStorage,Redux 与 LS 不一致 | `web/src/store/modules/userCenter.ts:42` + `utils/request.ts` + `utils/sse.ts` | R4 | 20m | [→](audit/2026-04-21-round-4-found.md#bug-084) |
| BUG-085 | 🟠 MED | 跨 Tab storage event 未监听,Tab A logout 后 Tab B 仍在线 | `web/src/store/modules/userCenter.ts` | R4 | 30m | [→](audit/2026-04-21-round-4-found.md#bug-085) |
| BUG-086 | 🟠 MED | `onAuthFailed` 只清 localStorage 不同步清 Redux → 重连循环 | `web/.../apps/project/index.tsx:58` + `imageEditor/index.tsx:837` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-086) |
| BUG-088 | 🟠 MED | subdoc provider auth 失败只 disconnect 自己,主 provider 重连 + callback N+1 重放 | `web/src/utils/yjsManager.ts:119` | R4 | 20m | [→](audit/2026-04-21-round-4-found.md#bug-088) |
| BUG-090 | 🟠 MED | `request.ts` / `sse.ts` `JSON.parse(tokenStr)` 无 try-catch | `web/src/utils/request.ts:25` + `utils/sse.ts:33` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-090) |
| BUG-092 | 🔴 HIGH | collab `auth.ts` NoAccount 只守 prod(BUG-054 的第二入口) | `collab/src/auth.ts:91` | R4 | 5m | [→](audit/2026-04-21-round-4-found.md#bug-092) |
| BUG-094 | 🟠 MED | Loading overlay 移除后无 sync / disconnect UX | `web/.../canvas/index.tsx:904` + `yjsManager.ts` | R4 | 45m | [→](audit/2026-04-21-round-4-found.md#bug-094) |
| BUG-095 | 🟠 MED | `utils/websocket.ts` 整个文件是死代码,PR #120 未清理 | `web/src/utils/websocket.ts` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-095) |
| BUG-096 | 🟠 MED | `/terms` `/privacy` 在 InfoBadge 变 SPA 内部路由无限跳 workspace | `web/.../userCenter/components/InfoBadge.tsx:99,102` | R4 | 20m | [→](audit/2026-04-21-round-4-found.md#bug-096) |
| BUG-097 | 🟠 MED | 相对 URL 硬耦合,CDN + 异域 API 部署场景失效无 escape hatch | `web/src/utils/request.ts:12` + `yjsManager.ts:52` + `sse.ts:65` | R4 | 1h | [→](audit/2026-04-21-round-4-found.md#bug-097) |
| BUG-102 | 🟠 MED | Nginx canonical redirect HTTP-only 模式不执行,entrypoint 绕过意图 | `docker/nginx.conf` + `docker/entrypoint.sh` | R4 | 30m | [→](audit/2026-04-21-round-4-found.md#bug-102) |
| BUG-103 | 🟠 MED | Nginx `$host` 在 canonical redirect 可被 Host header 欺骗(open redirect) | `docker/nginx-ssl.conf:27,46` | R4 | 45m | [→](audit/2026-04-21-round-4-found.md#bug-103) |
| BUG-104 | 🟠 MED | SSL 证书 SAN 覆盖假设无校验,证书只含 www 时 apex 握手失败 | `docker/nginx-ssl.conf` + `DEPLOY.md` | R4 | 30m | [→](audit/2026-04-21-round-4-found.md#bug-104) |
| BUG-105 | 🟠 MED | `:latest` = main rolling,无 release gate + 无健康回滚 | `docker-compose.yml` + `.env.docker:28` + `ci.yml` | R4 | 1h | [→](audit/2026-04-21-round-4-found.md#bug-105) |
| BUG-107 | 🟠 MED | GHCR private-by-default,首次发版后开源用户 Quick Start 走不通 | `docs/DEPLOY.md` + CI 无 visibility 校验 | R4 | 30m | [→](audit/2026-04-21-round-4-found.md#bug-107) |
| BUG-114 | 🔴 HIGH | Worker `runSkillAgent`(Path 4+5)无 scope 过滤 → canvas LLM 调用用 agent skills | `worker/src/handlers.ts:424` + `skills-loader.ts:144` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-114) |
| BUG-115 | 🔴 HIGH | skills-loader `loadMetadata` silent fallback + 默认值最宽松(供应链攻击面) | `core/src/agent/skills-loader.ts:294` | R5 | 1h | [→](audit/2026-04-22-round-5-found.md#bug-115) |
| BUG-116 | 🟠 MED | `spawn` 无并发数量限制 + 单次无超时 → 一轮 agent 可并起 N 个 subagent 各 15 step | `core/src/agent/tools/spawn.ts:143` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-116) |
| BUG-117 | 🟠 MED | Text mini-tool lock 无 fencing token,TTL > stream 时长导致丢锁 | `core/src/modules/text-tool.service.ts:89` | R5 | 20m | [→](audit/2026-04-22-round-5-found.md#bug-117) |
| BUG-118 | 🟠 MED | Memory Turn 压缩截断逻辑字节粒度不当,恶意构造可以爆 context | `core/src/modules/memory.service.ts:148` | R5 | 10m | [→](audit/2026-04-22-round-5-found.md#bug-118) |
| BUG-119 | 🟠 MED | `extractPromptText` 正则链多条 ReDoS(BUG-042 systemic 扩大) | `core/src/agent/extract-prompt.ts:22` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-119) |
| BUG-120 | 🟠 MED | `web_fetch` safeFetch DNS rebinding 窗口 + 不走 socket-level dispatcher | `core/src/agent/tools/safe-fetch.ts:161` | R5 | 1h | [→](audit/2026-04-22-round-5-found.md#bug-120) |
| BUG-121 | 🟠 MED | Worker `runSkillAgent` (Path 5) 拼接多 skill SKILL.md 为单 system prompt 超 context | `worker/src/handlers.ts:429` | R5 | 1h | [→](audit/2026-04-22-round-5-found.md#bug-121) |
| BUG-129 | 🟠 MED | `PUT /assets/local-upload/:key` 无 body size 限制 → 单请求可 OOM API | `server/src/routes/assets.ts:136` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-129) |
| BUG-130 | 🟠 MED | `/assets/presign` 无 content_type 白名单 —— SVG / text/html 可接受 → 存储 XSS 风险 | `server/src/routes/assets.ts:38,65,97` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-130) |
| BUG-131 | 🟠 MED | BUG-030 systemic 全貌 —— 所有 5 个 rate limit prefix 都走同一函数 100% 可绕过 | `server/src/routes/auth.ts:26` + `docker/breatic-locations.conf:18` | R5 | 15m(并入 BUG-030) | [→](audit/2026-04-22-round-5-found.md#bug-131) |
| BUG-132 | 🟠 MED | Agent chat SSE / canvas / mini-tools / text-tools 等 8 个 endpoint 无 rate limit | `server/src/routes/chat.ts,canvas.ts,mini-tools.ts,text-tools.ts` | R5 | 2h | [→](audit/2026-04-22-round-5-found.md#bug-132) |
| BUG-133 | 🟠 MED | Zod schema 大面积缺 max length 上限(chat / skill / text-tool / project 等)—— DoS 面 | `shared/src/schemas/api.ts` + `server/src/routes/schemas.ts` | R5 | 1.5h | [→](audit/2026-04-22-round-5-found.md#bug-133) |
| BUG-134 | 🟠 MED | Session TTL 固定 30d,无 slide / rotation / device cap | `core/src/infra/session-store.ts:11` | R5 | 3h | [→](audit/2026-04-22-round-5-found.md#bug-134) |
| BUG-143 | 🟠 MED | `softDeleteConversation()` 不级联附件 / 记忆 / 历史条目 → 对话软删数据泄漏 | `core/src/modules/conversation.repo.ts:84` + `conversation.service.ts:142` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-143) |
| BUG-144 | 🟠 MED | FK onDelete 策略全面不一致 —— `users` / `projects` / `conversations` 硬删意外失败 + `set null` 使用不一致 | `core/src/db/schema.ts`(多处) | R5 | 30m 文档 / ADR(GDPR 单列 2h) | [→](audit/2026-04-22-round-5-found.md#bug-144) |
| BUG-145 | 🟠 MED | 全 10 个 migration 文件无 `IF EXISTS`(BUG-082 systemic) | `core/src/db/migrations/0000~0009_*.sql` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-145) |
| BUG-146 | 🟠 MED | `conversation_memories` / `conversationAttachments` 等多张表缺 `deletedAt` 列 | `core/src/db/schema.ts:203,249,335,376,420,471,493` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-146) |
| BUG-147 | 🟠 MED | 多表无 DB 层 CHECK constraint 限制 `status` / `taskType` 等 enum 字段(membershipType 已由 PR #131 删除) | `core/src/db/schema.ts:166,210,255` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-147) |
| BUG-155 | 🟠 MED | `video-cover.ts` 服务端 ffmpeg `-i <videoUrl>` 无 `-protocol_whitelist` → SSRF / 本地文件读取 | `core/src/video-cover.ts:29-41` | R6 | 2h | [→](audit/2026-04-23-round-6-found.md#bug-155) |
| BUG-156 | 🟠 MED | `PUT /assets/local-upload` 无大小限制 + 无 rate limit + 信任客户端 contentType(BUG-129 systemic 扩大) | `server/src/routes/assets.ts:136-162` | R6 | 2h | [→](audit/2026-04-23-round-6-found.md#bug-156) |
| BUG-157 | 🟠 MED | `mini-tools/video` 的 `video: z.string()` 接任意字符串(SSRF + file:// + data:)(BUG-133 systemic 扩大) | `server/src/routes/schemas.ts:48-51` | R6 | 1.5h | [→](audit/2026-04-23-round-6-found.md#bug-157) |
| BUG-158 | 🟠 MED | 5 个 ffmpeg util 重复 boilerplate + `@ffmpeg/core` deps 声明但未使用 + 无 init mutex | `web/package.json:13-15` + 5 个 `*WithFfmpeg.ts` | R6 | 3h | [→](audit/2026-04-23-round-6-found.md#bug-158) |
| BUG-165 | 🔴 HIGH | `canvas/common/Video.tsx` videojs player 从不 dispose(BUG-070/071 systemic 放大) | `web/.../canvas/common/Video.tsx:224-319` | R6 | 45m | [→](audit/2026-04-23-round-6-found.md#bug-165) |
| BUG-167 | 🟠 MED | `textEditor/ui/AIMenu.tsx` `insertContentAt(replacement)` 目前 mock,接真 LLM 即 XSS(Tiptap 把 string 作 HTML 解析) | `web/.../textEditor/ui/AIMenu.tsx:359,386,408` | R6 | 45m | [→](audit/2026-04-23-round-6-found.md#bug-167) |
| BUG-168 | 🟠 MED | `resolveVideoResultNode` / `updateNodeData` 连续编辑同视频不 revoke 旧 blob URL → 潜在 GB 级泄漏 | `web/src/hooks/useMixedEditorStore.ts:608-618` | R6 | 20m | [→](audit/2026-04-23-round-6-found.md#bug-168) |
| BUG-172 | 🟠 MED | `POST /mini-tools/text` 整体无 rate limit + `Idempotency-Key` 侧信道 oracle(BUG-132 systemic 扩大) | `server/src/routes/text-tools.ts:46` | R7 | 10m(并入 BUG-132) | [→](audit/2026-04-23-round-7-found.md#bug-172) |
| BUG-177 | 🟠 MED | Video/Audio Exporter 是"假成功"占位 —— 进度 100% 返回 text/plain 假冒 MP4 / 空 WAV,UI 说谎 | `web/.../videoEditor/videoExporter.ts` + `audioExporter.ts` | R8 | 30m(标 WIP / disable UI / 抛明确错) | [→](audit/2026-04-23-round-8-found.md#bug-177) |
| BUG-179 | 🟠 MED | `handleDragMove` 每 mousemove O(N) × 3 扫描 → 100 clips × 60Hz ≈ 36k ops/sec 浪费 | `web/.../videoEditor/timeline/...` | R8 | 1h(index-by-id / 缓存) | [→](audit/2026-04-23-round-8-found.md#bug-179) |
| BUG-184 | 🟠 MED | Security header 全仓 systemic 缺失 —— Hono / nginx × 3 / index.html 三层零 CSP / HSTS / X-Frame-Options / nosniff(BUG-136 scope 升级 + 独立追踪) | `packages/server/src/app.ts` + `docker/*.conf` + `packages/web/index.html` | R8 | 2h(Hono secureHeaders + nginx add_header + CSP nonce) | [→](audit/2026-04-23-round-8-found.md#bug-184) |
| BUG-188 | 🟠 MED | 4-25 force push / history rewrite 操作零 commit message / 零 docs / 零 SECURITY 通知 / 零审批,违反 CLAUDE.md 编码行为准则 #5 + 违反 OSS force push 流程 | `docs/INCIDENTS/`([RCA 已建](INCIDENTS/2026-04-25-history-rewrite-rca.md))+ `SECURITY.md` + `CHANGELOG.md`(均待 maintainer 填 disclosure) | R9 | 1h(写 INCIDENTS + SECURITY 章节 disclosure)— **由 [INC-2026-04-25-001](INCIDENTS/2026-04-25-history-rewrite-rca.md) 统一处置** | [→](audit/2026-04-25-round-9-found.md#bug-188) |
| BUG-189 | 🟠 MED | 421 文件 restore commit(`dfc3544` + `eea202e`)无 per-file 决策记录 → 已发现至少 1 处 dead code 引入(`googleAuthSchema` 在 shared + server 两处独立定义) | `packages/shared/src/schemas/index.ts:5` + `packages/shared/src/schemas/api.ts:27` + `packages/server/src/routes/auth.ts:91`(同一符号 3 处定义路径) | R9 | 2h(全 11 个 shared schema 符号 grep + 逐文件 per-file 决策)— **由 [INC-2026-04-25-001](INCIDENTS/2026-04-25-history-rewrite-rca.md) 统一处置** | [→](audit/2026-04-25-round-9-found.md#bug-189) |
| BUG-190 | 🟠 MED | BUGS.md 状态机滞后 —— BUG-159 / BUG-169 已被 PR #144 / PR #138 自然修复但 BUGS.md 仍标 active(本轮直接关闭,但流程缺陷需补) | `docs/internal/BUGS.md`(状态同步流程) | R9 | 1h(本轮已 inline 处理 + 补建 weekly 假阳性扫描 spec) | [→](audit/2026-04-25-round-9-found.md#bug-190) |
| BUG-193 | 🟠 MED | `sse.ts` `onerror` 不调用户传入的 `config.onerror` callback,所有 SSE 错误对 caller 静默失败 → UI 看不到任何错误,流断后无 toast / retry / fallback | `packages/web/src/utils/sse.ts:90-92` | R10 | 15m(加 `config.onerror?.(err)` 调用) | [→](audit/2026-04-25-round-10-found.md#bug-193) |
| BUG-194 | 🟠 MED | `sse.ts` 402 抛通用 `Failed to open stream: 402` 神秘错误,无"积分不足"专属处理 + 无购买 CTA → 用户在常态(积分制)情况下看英文技术错误 | `packages/web/src/utils/sse.ts:71-80` + 404 / 5xx 同位置 | R10 | 1h(402 走专属 onPaymentRequired callback + 全局 modal listen) | [→](audit/2026-04-25-round-10-found.md#bug-194) |
| BUG-195 | 🟠 MED | `request.ts` 网络错误时 `decrementLoading()` 不调,全局 spinner 永转看似死机 | `packages/web/src/utils/request.ts:50-53` | R10 | 5m(删除 `if (!isNetworkError)` 条件) | [→](audit/2026-04-25-round-10-found.md#bug-195) |
| BUG-196 | 🟠 MED | `sse.ts` `Accept-Language` header 硬编码 `'en'`,无视用户语言设置 → 后端 zod validation 错误消息永远英文,日志 user locale 漂移 | `packages/web/src/utils/sse.ts:36` | R10 | 15m(读 `i18next.language` 替代) | [→](audit/2026-04-25-round-10-found.md#bug-196) |

**P1 小计**:72 个 · 预估 **~48 小时**(R10 +1.5h:BUG-193/194/195/196)

---

## P2 — 本月修

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-042 | 🟡 LOW | `extractPromptText` ReDoS 风险 | `core/src/agent/extract-prompt.ts` | R2 | 5m | [→](audit/2026-04-15-round-2-found.md#bug-042-extractprompttext-redos-风险low) |
| BUG-043 | 🟡 LOW | 错误日志泄露 stack trace | `server/src/middleware/error-handler.ts:21` | R2 | 10m | [→](audit/2026-04-15-round-2-found.md#bug-043-错误日志泄露-stack-tracelow) |
| BUG-066 | 🟠 MED | Worker 扣费失败仅 log,无恢复机制 | `worker/src/handlers.ts:221` | R3 | 1h | [→](audit/2026-04-17-round-3-found.md#bug-066) |
| BUG-067 | 🟠 MED | Spawn 注入无界 memory context → token 成本失控 | `core/src/agent/tools/spawn.ts:76` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-067) |
| BUG-068 | 🟠 MED | 空 toolset skill 静默完成(幻觉结果) | `worker/src/handlers.ts:417` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-068) |
| BUG-069 | 🟠 MED | Collab auth PG 连接池未关闭 → 连接泄漏 | `collab/src/auth.ts:76` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-069) |
| BUG-070 | 🟠 MED | 前端 Yjs undoManager 监听器内存泄漏 | `web/src/hooks/useYjsProjectStore.ts:73` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-070) |
| BUG-071 | 🟠 MED | Subdoc provider 销毁时未逐个清理 subdoc | `web/src/utils/yjsManager.ts:100` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-071) |
| BUG-072 | 🟠 MED | `creditTransactions.referenceId` 无索引 | `core/src/db/schema.ts:283` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-072) |
| BUG-073 | 🟠 MED | `creditTransactions` 缺 `deletedAt`(审计表无软删) | `core/src/db/schema.ts:283` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-073) |
| BUG-074 | 🟠 MED | docker-compose.yml 硬编码 postgres 密码 | `docker-compose.yml:6` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-074) |
| BUG-075 | 🟠 MED | Worker 中 `redis` 变量声明后未使用(拆库遗留) | `worker/src/handlers.ts:84` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-075) |
| BUG-076 | 🟠 MED | Logout 路由重新解析 `Authorization` header 而非读 ctx | `server/src/routes/auth.ts:179` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-076) |
| BUG-077 | 🟠 MED | CORS 配置无 wildcard + credentials 启动校验 | `server/src/middleware/cors.ts:13` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-077) |
| BUG-078 | 🟡 LOW | 锁释放 `DEL` 失败未 log(潜在永久锁住节点) | `collab/src/task-listener.ts:142` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-078) |
| BUG-081 | 🟡 LOW | `getStripeClient` 运行时 trim 不一致(纵深防御缺失) | `core/src/infra/stripe.ts:23` | R4 | 5m | [→](audit/2026-04-21-round-4-found.md#bug-081) |
| BUG-082 | 🟡 LOW | migration 0008 非幂等 DROP 缺 `IF EXISTS` | `core/src/db/migrations/0008_mean_jubilee.sql:1` | R4 | 2m | [→](audit/2026-04-21-round-4-found.md#bug-082) |
| BUG-083 | 🟡 LOW | `creditTransactions.referenceId` 可为任意 255 字符串 —— 与 REFKEY_PATTERN 不一致 | `core/src/db/schema.ts:297` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-083) |
| BUG-087 | 🟡 LOW | `useYjsStore` `onAuthFailed` eslint-disable 掩盖 stale closure 陷阱 | `web/src/hooks/useYjsProjectStore.ts:131` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-087) |
| BUG-089 | 🟡 LOW | `loadInitialAuthInfo` 静默吞 localStorage 错误,Safari ITP 场景无告警 | `web/src/store/modules/userCenter.ts:52` | R4 | 5m | [→](audit/2026-04-21-round-4-found.md#bug-089) |
| BUG-091 | 🟡 LOW | collab `onAuthenticate` error message 泄露 userId / projectId | `collab/src/auth.ts:114` | R4 | 10m | [→](audit/2026-04-21-round-4-found.md#bug-091) |
| BUG-098 | 🟡 LOW | `vite-env.d.ts` 类型过瘦,5+ 个 VITE_ 变量无类型声明 | `web/src/vite-env.d.ts:3` | R4 | 5m | [→](audit/2026-04-21-round-4-found.md#bug-098) |
| BUG-099 | 🟡 LOW | Docker 3000/1234 ports 暴露绕 nginx canonical(BUG-034 副作用) | `docker-compose.yml:80,92` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-099) |
| BUG-100 | 🟡 LOW | `.env.docker` `ALLOWED_ORIGINS=http://localhost` 默认值无意义 | `.env.docker` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-100) |
| BUG-101 | 🟡 LOW | `bugs_list` 分支 stale 导致审计易看 pre-refactor 工作树误报(流程) | 本分支 + `docs/internal/BUGS.md` | R4 | 30m | [→](audit/2026-04-21-round-4-found.md#bug-101) |
| BUG-106 | 🟡 LOW | migrate service `working_dir` 隐式耦合 Dockerfile WORKDIR | `docker-compose.yml:56` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-106) |
| BUG-108 | 🟡 LOW | PR 构建 gha cache scope 未按 PR/main 隔离 → 跨 PR 污染 | `.github/workflows/ci.yml:110-120,136-145` | R4 | 10m | [→](audit/2026-04-21-round-4-found.md#bug-108) |
| BUG-109 | 🟡 LOW | CI Node 24 runtime vs 生产 Node 22 漂移,缺 pre-flight | `.github/workflows/ci.yml:16` + `Dockerfile` | R4 | 20m | [→](audit/2026-04-21-round-4-found.md#bug-109) |
| BUG-110 | 🟡 LOW | CI 无 `workflow_dispatch`,紧急回滚只能 push dummy commit | `.github/workflows/ci.yml:1-8` | R4 | 20m | [→](audit/2026-04-21-round-4-found.md#bug-110) |
| BUG-111 | 🟡 LOW | `:test_thinkai_cc` tag 语义漂移(当 staging 但实为 branch HEAD 别名) | `.github/workflows/ci.yml:101` + `.env.docker` | R4 | 15m | [→](audit/2026-04-21-round-4-found.md#bug-111) |
| BUG-122 | 🟡 LOW | MainAgent tool-call log 直接序列化 `part.input`(用户可控)→ conversation messages 体积爆炸 | `server/src/agent/main-agent.ts:156` | R5 | 20m | [→](audit/2026-04-22-round-5-found.md#bug-122) |
| BUG-123 | 🟡 LOW | `web_search` 直连 Brave API 无 SSRF 保护层(走 `fetch` 而非 `safeFetch`)+ API key 静态 | `core/src/agent/tools/web-search.ts:42` | R5 | 10m | [→](audit/2026-04-22-round-5-found.md#bug-123) |
| BUG-124 | 🟡 LOW | `ask_user_question` SSE sentinel 在 Worker 路径返回字符串无人消费 | `worker/src/handlers.ts:442` + `core/src/agent/tools/ask-user.ts:39` | R5 | 20m | [→](audit/2026-04-22-round-5-found.md#bug-124) |
| BUG-125 | 🟡 LOW | `agent-loader.ts` 手写 frontmatter parser 不支持 YAML 多行 / 数组等标准语法 | `core/src/agent/agent-loader.ts:40` | R5 | 15m | [→](audit/2026-04-22-round-5-found.md#bug-125) |
| BUG-126 | 🟡 LOW | `tryGetContext` 在 spawn 可能返回 undefined → subagent 扣费静默跳过 | `core/src/agent/tools/spawn.ts:75` | R5 | 15m | [→](audit/2026-04-22-round-5-found.md#bug-126) |
| BUG-135 | 🟡 LOW | Stripe `success_url` / `cancel_url` 无白名单 —— checkout redirect 可被劫持到第三方 | `shared/src/schemas/api.ts:89` + `core/src/modules/payment.service.ts:53` | R5 | 15m | [→](audit/2026-04-22-round-5-found.md#bug-135) |
| BUG-136 | 🟡 LOW | Hono app / nginx 都无 security HTTP headers(CSP / X-Frame-Options / nosniff / HSTS) | `server/src/app.ts` + `docker/breatic-locations.conf` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-136) |
| BUG-137 | 🟡 LOW | `POST /assets/history` 接受任意 `content` URL → 可污染 node_history 引诱他人打开 | `server/src/routes/assets.ts:166` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-137) |
| BUG-138 | 🟡 LOW | `listMarketSkills` service 层 limit / offset 参数位置交换 → 默认分页返 0 行 | `core/src/modules/skill.service.ts:138` | R5 | 5m | [→](audit/2026-04-22-round-5-found.md#bug-138) |
| BUG-139 | 🟡 LOW | `AgentInput.tsx` setHtml / DOM write 未 sanitize(BUG-051 的前端侧点位) | `web/src/components/base/agent/AgentInput.tsx:164,216,753,762` | R5 | 10m | [→](audit/2026-04-22-round-5-found.md#bug-139) |
| BUG-140 | 🟡 LOW | Google OAuth "pre-registration takeover" —— 攻击者先注册用受害者邮箱账户,受害者首次 Google 登录自动合并 | `core/src/modules/auth.service.ts:109` | R5 | 45m | [→](audit/2026-04-22-round-5-found.md#bug-140) |
| BUG-148 | 🟡 LOW | `NodeHistoryEntity` / `PaymentEntity` 类型缺 `deletedAt`(DB 有),运行时漂移 | `shared/src/types/entities.ts:108` | R5 | 10m | [→](audit/2026-04-22-round-5-found.md#bug-148) |
| BUG-149 | 🟡 LOW | `credit_transactions.reference_id` / `tasks.arq_job_id` / `payments.stripe_*` 无 unique/index | `core/src/db/schema.ts:138,169,270,279,297` | R5 | 15m | [→](audit/2026-04-22-round-5-found.md#bug-149) |
| BUG-150 | 🟡 LOW | 所有 list 查询用 OFFSET/LIMIT → 大 credit / tasks 列表慢,需要 cursor pagination | `core/src/modules/task.repo.ts` 等 | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-150) |
| BUG-151 | 🟡 LOW | `drizzle` schema 无 `relations()` 声明 —— 关系查询无类型安全,N+1 风险 | `core/src/db/schema.ts`(整个文件无 relations call) | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-151) |
| BUG-152 | 🟡 LOW | `client.ts` Drizzle singleton 无 logger 配置,慢查询 / 错误无可观测性 | `core/src/db/client.ts:19` | R5 | 30m | [→](audit/2026-04-22-round-5-found.md#bug-152) |
| BUG-160 | 🟡 LOW | ffmpeg.wasm 客户端无 AbortController,长视频切工具/关面板仍跑完(BUG-112 systemic) | 5 个 `*WithFfmpeg.ts` | R6 | 15m | [→](audit/2026-04-23-round-6-found.md#bug-160) |
| BUG-161 | 🟡 LOW | ffmpeg cut 用 `-ss <t> -i <file>`(input seek)精度差,某些格式输出错位 I-frame | `web/src/utils/videoCutWithFfmpeg.ts:109-123` | R6 | 30m | [→](audit/2026-04-23-round-6-found.md#bug-161) |
| BUG-162 | 🟡 LOW | adjust WebGL 预览 vs ffmpeg 再压缩色彩管线不一致(`colorchannelmixer` 与 WebGL uniforms 对不上) | `web/src/utils/videoAdjustWithFfmpeg.ts:107-114` + adjust uniforms | R6 | 1d | [→](audit/2026-04-23-round-6-found.md#bug-162) |
| BUG-166 | 🟡 LOW | `PlaybackTimelineSection.tsx` + `EraseTrackingPanel.tsx` 隐藏 video 元素 `loadeddata {once:true}` unmount 前未触发时 listener 未清 | `web/.../mixedEditor/node/videoNode/playback/PlaybackTimelineSection.tsx:158-194` + EraseTrackingPanel | R6 | 15m | [→](audit/2026-04-23-round-6-found.md#bug-166) |
| BUG-170 | 🟡 LOW | `90d8451` workspace API stabilize = band-aid(imageEditor→mixedEditor 漏改 + RecentProjects refetch 循环) | `web/vite.config.ts` + `web/.../workspace/components/RecentProjects.tsx` | R6 | 30m | [→](audit/2026-04-23-round-6-found.md#bug-170) |
| BUG-171 | 🟡 LOW | `yjsProjectManager._userOrigin` per-user 非 per-tab(BUG-040 regression 面扩大) | `web/src/utils/yjsProjectManager.ts:72` | R6 | 15m(并入 BUG-040 修) | [→](audit/2026-04-23-round-6-found.md#bug-171) |
| BUG-174 | 🟡 LOW | mini-tools 的 `node_id` / `project_id` 无 UUID 校验(对比 canvas.ts nodeHistory 用 `.uuid()`,不一致) | `server/src/routes/schemas.ts:30,47-55` | R7 | 10m(并入 BUG-133) | [→](audit/2026-04-23-round-7-found.md#bug-174) |
| BUG-175 | 🟡 LOW | collab `/node/.+` docName suffix 无字符/长度白名单 → authenticated 用户 self-DoS 自己项目(yjs_documents PK 膨胀) | `collab/src/auth.ts:44` + `core/src/db/schema.ts:491` | R7 | 30m | [→](audit/2026-04-23-round-7-found.md#bug-175) |
| BUG-176 | 🟡 LOW | collab `parseProjectIdFromDocName` tolerant regex + 无 rate limit,高 QPS 下可探测 projectId(info) | `collab/src/auth.ts:44` + collab `onAuthenticate` 无内置限流 | R7 | 45m | [→](audit/2026-04-23-round-7-found.md#bug-176) |
| BUG-178 | 🟡 LOW | `imageExporter` 尺寸 clamp 到 1920×1080 忽视 `_resolution` 参数但签名暴露(dead API) | `web/.../videoEditor/imageExporter.ts` | R8 | 10m | [→](audit/2026-04-23-round-8-found.md#bug-178) |
| BUG-180 | 🟡 LOW | `setInterval(..., 33)` 播放计时 drift + 不用 `performance.now()` delta,长视频偏移 | `web/.../videoEditor/timeline/playback*` | R8 | 20m(换 rAF + delta) | [→](audit/2026-04-23-round-8-found.md#bug-180) |
| BUG-181 | 🟡 LOW | `useMemo` 读 `containerRef.current?.clientWidth` 但 ref 不在 deps → 容器尺寸变化后 stale | `web/.../videoEditor/timeline/...` | R8 | 10m(ResizeObserver + state) | [→](audit/2026-04-23-round-8-found.md#bug-181) |
| BUG-182 | 🟡 LOW | `TimelineScale.drawScale` 刻度数无上限,超长 timeline + 细粒度 zoom 画数万条线 | `web/.../videoEditor/timeline/TimelineScale*` | R8 | 15m(max ticks / LOD) | [→](audit/2026-04-23-round-8-found.md#bug-182) |
| BUG-183 | 🟡 LOW | 生产代码大量 `console.log`(InfiniteCanvas clickHandler 每次点击都打印) | `web/.../videoEditor/canvas/InfiniteCanvas*` | R8 | 20m(扫仓 + 改 logger) | [→](audit/2026-04-23-round-8-found.md#bug-183) |
| BUG-191 | 🟠 MED | 14 个 `.tsx` / `.ts` 源码文件违反 CLAUDE.md 800 行 max(最严重 `videoNode.tsx` 1913 行 = 2.39× 上限,含 PR #140 重写后产物 `mixedEditor/index.tsx` 1348 行) | `packages/web/src/apps/project/components/mixedEditor/**` + `videoEditor/**` + `textEditor/**` 共 14 文件 | R9 | 30m(加 ESLint `max-lines: 800` 防新违规)+ 长期(分批拆 14 文件,每文件 2~6h) | [→](audit/2026-04-25-round-9-found.md#bug-191) |
| BUG-197 | 🟠 MED | i18n systemic 漏洞 —— 6 文件群至少 50+ 处用户可见字符串硬编码英文 / 中英混搭(LoginPage / ResetPasswordPage / EmptyState / 9 BottomToolbar Save / TTS panel / Loading "..." )违反 4 语言承诺 | `packages/web/src/apps/auth/{Login,ResetPassword}Page.tsx` + `mixedEditor/ui/EmptyState.tsx` + 9 个 `*BottomToolbar.tsx` + `textToSpeech/TextToSpeechPlaceholderPanel.tsx` | R10 | 2h(ESLint `i18next/no-literal-string` rule + 全仓 codemod) | [→](audit/2026-04-25-round-10-found.md#bug-197) |
| BUG-198 | 🟡 LOW | `textEditor/index.tsx` 节点切换时 `key={manager.docName}` 触发 remount,`if (!manager) Loading…` fallback 短暂闪烁 | `packages/web/src/apps/project/components/textEditor/index.tsx:74-86` | R10 | 30m(manager 缓存 + skeleton) | [→](audit/2026-04-25-round-10-found.md#bug-198) |
| BUG-199 | 🟡 LOW | `RecentProjects.tsx` 删除项目 `await API` 后才 setState,无乐观 UI → 卡片在 API 完成前 visible | `packages/web/src/apps/workspace/components/RecentProjects.tsx:118-130` | R10 | 20m(乐观更新 + 失败回滚) | [→](audit/2026-04-25-round-10-found.md#bug-199) |
| BUG-200 | 🟡 LOW | `request.ts:65` `await logoutApi().catch(() => {})` 静默吞错 → logout 失败完全无 log / 无埋点(违反 CLAUDE.md "禁止裸 catch") | `packages/web/src/utils/request.ts:65` | R10 | 5m(改 `catch((err) => logger.warn(...))`) | [→](audit/2026-04-25-round-10-found.md#bug-200) |
| BUG-201 | 🟡 LOW | `packages/web/package.json` 死依赖 3 个(`zustand` / `@tanstack/react-query` / `zundo` 全部 0 引用)+ 包名 `"reagt-jike"` 拼写错(react-jike 模板早期遗迹) | `packages/web/package.json` | R10 | 10m(`pnpm remove` + 改 name) | [→](audit/2026-04-25-round-10-found.md#bug-201) |
| BUG-202 | 🟡 LOW | 401 重定向路径 + 跳转方式不一致 —— `request.ts:68 window.location.href='/workspace'`(SPA 硬跳)vs `sse.ts:78 router.navigate('/login')`(SPA 软跳) | `packages/web/src/utils/{request,sse}.ts` | R10 | 15m(统一为 `router.navigate('/login')`) | [→](audit/2026-04-25-round-10-found.md#bug-202) |
| BUG-203 | 🟡 LOW | `request.ts:45` axios interceptor 不解响应信封,`return response.data` 直接返回 → 后端 200 + `{success:false}` 时 caller 拿到当成功处理,每个 caller 必须手动 `if (!res.success)` | `packages/web/src/utils/request.ts:45` | R10 | 30m(interceptor 检查 success + 抛 ApiError + 全部 caller 适配) | [→](audit/2026-04-25-round-10-found.md#bug-203) |
| BUG-204 | 🟡 LOW | `videoEditor/index.tsx:36` `const standalone = true` 写死,导出 / 保存调用 stub 路径(`getOssStsApi` / `saveWorkflowApi` 抛 not configured),生产部署该路由用户能进但功能不闭环 | `packages/web/src/apps/videoEditor/index.tsx:36` + `apis/projectApi.ts:6-20`(stubs) | R10 | TBD(产品决策:隐藏路由 vs 补完 OSS/workflow 集成) | [→](audit/2026-04-25-round-10-found.md#bug-204) |

**P2 小计**:69 个 · 预估 **~24.55 小时**(R10 +3.3h:BUG-197 ~ BUG-204;BUG-204 工时方案待决)

---

## 长期 — 测试质量重构

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-045 | 🔴 长期 | 65 个测试里仅 ~4 个真测业务,关键 bug 零覆盖 | 测试全库 | R2 | ~12h | [→](audit/2026-04-15-round-2-found.md#bug-045-测试大量是-mock-测试无法阻止回归high--长期任务) |

子任务:BUG-045-A extractPromptText 测试 · BUG-045-B user.repo 软删测试 · BUG-045-C payment webhook CAS 集成测试 · BUG-045-D 引入 stryker mutation testing · BUG-045-E 重写 HTTP route 测试

---

## 汇总

| 桶 | 数量 | 预估工时 |
|----|------|---------|
| P0 | 15(+1 不修) | ~15 h + BUG-192 补功能(BUG-187 / BUG-192 工时方案待决) |
| P1 | 72 | ~48 h |
| P2 | 69 | ~24.55 h |
| 长期 | 1 | ~12 h |
| **总计** | **157**(含长期,+1 不修) | **~99.55 h**(BUG-187 / BUG-192 / BUG-204 待决方案 + BUG-191 长期任务未计入) |

---

## 发现历史

- **Round 1**(2026-04-10 ~ 04-15):29 个 bug 发现,**全部关闭**(PR #81-90)。详见 [`audit/2026-04-15-round-1-closed.md`](audit/2026-04-15-round-1-closed.md)
- **Round 2**(2026-04-15):15 个 regression + 1 个测试质量 meta 发现。快照见 [`audit/2026-04-15-round-2-found.md`](audit/2026-04-15-round-2-found.md)。**状态**:已关 2 个(BUG-031 / BUG-033 · PR #126 · 2026-04-22),1 个标不修(BUG-034),其余未修复
- **Round 3**(2026-04-17):33 个新发现(5 HIGH + 20+ MED + 少量 LOW)。快照见 [`audit/2026-04-17-round-3-found.md`](audit/2026-04-17-round-3-found.md)。**状态**:已关 5 个(BUG-046 / 047 / 048 / 052 / 053),其余未修复
- **Round 4**(2026-04-21):33 个新发现(2 P0 + 1 P1 HIGH + 15 P1 MED + 15 P2 LOW)+ 核查 5 个声称修复(4 彻底 + 1 部分)。快照见 [`audit/2026-04-21-round-4-found.md`](audit/2026-04-21-round-4-found.md)。**状态**:未修复
- **Round 5**(2026-04-22):41 个新发现(6 P0 + 2 P1 HIGH + 17 P1 MED + 16 P2 LOW)+ 发现 BUG-031 补丁不完整(转 BUG-142 追踪)+ 关闭 BUG-044(注释已同步)。快照见 [`audit/2026-04-22-round-5-found.md`](audit/2026-04-22-round-5-found.md)。**状态**:已关 1 个(BUG-079 · PR #128 · 2026-04-22),其余未修复
- **Round 6**(2026-04-23):19 个新发现(4 P0 + 1 P1 HIGH + 7 P1 MED + 7 P2 LOW)+ 关闭 BUG-093(imageEditor 文件删除,pattern 迁移到 BUG-164 追踪)。Agent J 超时,BUG-093 核查由主 session 完成。快照见 [`audit/2026-04-23-round-6-found.md`](audit/2026-04-23-round-6-found.md)。**状态**:已关 4 个(BUG-141/142 · PR #137 + BUG-163 · PR #138 + BUG-164 · PR #140,均 2026-04-23),其余未修复
- **Round 7**(2026-04-23 slim):5 新发现(1 P0 + 1 P1 MED + 3 P2 LOW)+ 2 个 scope 扩大 note(BUG-132 / BUG-157)。单 agent 聚焦 rate limit / Zod / auth 覆盖 3 主题(补 Round 6 Agent J timeout 盲点),8 分钟完成不 timeout,验证"≤ 3 主题 / agent"规则。**P0 BUG-173 是主 session 从 agent 原判 MED 上调**(扣费绕过,与 BUG-079 同级)。快照见 [`audit/2026-04-23-round-7-found.md`](audit/2026-04-23-round-7-found.md)。**状态**:未修复
- **Round 8**(2026-04-23 slim 夜):8 新发现(0 P0 + 3 P1 MED + 5 P2 LOW)。针对 PR #144 video editor workspace + exporters + TTS placeholder。单 agent 6.5 分钟完成。**关键正面观察**:BUG-070/071/165 memory leak pattern + BUG-153/154 blob/CDN pattern + BUG-093/164 useYjsStore 误用 pattern —— **全都没在新代码里复发**,dev 团队 defensive 习惯已建立。BUG-136 CSP systemic 从 LOW 升级独立 BUG-184(MED)。快照见 [`audit/2026-04-23-round-8-found.md`](audit/2026-04-23-round-8-found.md)。**状态**:未修复
- **Round 8 后 grep**(2026-04-23):PR #150 merge 后,主 session 主动 grep `store.getState().mixedEditor\|useMixedEditorStore` 发现 `AiChatRecordPanel.tsx` 2 处漏修 stale Redux read → **BUG-185**(P0)。追踪 PR #140 Yjs-first rewrite 的第 4 个 post-merge regression(前 3 个由 PR #149/#150 修)。**教训**:Redux slice 删除后,代码审计应**全仓 grep 所有 `store.getState().<slice>` 引用**,单文件/视觉审不充分。**状态**:**已关**(PR #153 · `296b392` · 2026-04-23,dev 独立并行修复,自带 defensive grep 验证 0 残留)
  - ⚠️ **2026-04-25 注**:`296b392` 这个 commit hash 已因 history rewrite **失效**(`git cat-file -e` 返回 missing)。详见 BUG-186 / Round 9 found。
- **Round 9**(2026-04-25,主 session forensics):**6 新 BUG**(2 P0 + 3 P1 MED + 1 P2 MED)起因于发现 4-25 出现 2 个 `chore: restore N files dropped by 4-11 cutoff` 的描述模糊 commit。反推确认整个 git 历史在 4-25 当天被**无解释 force push 重写**(402 commit 全部塌缩到 4-25 当日 commit date,12+ 已 closed bug 的 fix commit hash 全部 GONE)+ 421 个文件被作为"new files" restore(`dfc3544` + `eea202e`)。**关键观察**:全部 P0/P1 finding 都是**流程层 / 治理层**问题,非代码层 —— audit role 第一次反身性发现"audit 自身状态机有 bug"(BUG-190)。新建 BUG-186/187/188/189/190/191 + 顺带关闭 2 个假阳性(BUG-159 / BUG-169 已被 PR #144 / PR #138 自然修复但未追踪)。快照见 [`audit/2026-04-25-round-9-found.md`](audit/2026-04-25-round-9-found.md)。**状态**:全部未修复;BUG-186/187/188/189 同根同源(4-25 history rewrite 单一事件),已写 RCA 半成品 [`INCIDENTS/2026-04-25-history-rewrite-rca.md`](INCIDENTS/2026-04-25-history-rewrite-rca.md)(audit forensics 部分完成,触发原因 + 处置决策待 maintainer 填),完成后 4 BUG 一并关闭
- **Round 10**(2026-04-25,夜间,主 session fact-check):用户提供一份 49 项前端 bug 清单(3 炸弹 + 7 P0 + 9 P1 + 14 P2 + 16 P3 + 5 产品策略),audit 逐条核查真伪。**13 新 BUG**(1 P0 + 4 P1 + 8 P2),清单整体准确率约 **47%** —— 真新 + 重复合计 23/49,假阳性 / 描述不准 ~20%(集中在 React Hook 闭包 / Effect 依赖 / Yjs 迭代等微妙 timing 问题),i18n 类合并条目 + 产品策略非 bug ~30%。**关键发现 BUG-192(P0)**:`AiChatRecordPanel.tsx:309-330` `handleSend` 是 `setTimeout(3000)` mock,**核心 AI 聊天前端不通,后端 chat 链路全空跑** —— 影响 R3~R8 chat 链路 audit 的"前端在调"基础假设。**audit 反身性观察**:本轮第一次对外部清单做 fact-check,展示 audit role "质量门禁"价值(不是产生 bug 而是判定他人产生 bug 的真伪)。清单中 3 项 ✓ "已手工验证"标记中 1 项假阳性(B2 axios `error.status`,清单作者用旧版心智模型),**"已手工验证"标记不可盲信**。快照见 [`audit/2026-04-25-round-10-found.md`](audit/2026-04-25-round-10-found.md)。**状态**:全部未修复

---

## 工作流说明

### 给负责修复的 Claude session(其他 clone / fix 分支)

1. 打开本文件找要修的 bug 编号
2. 点 **详情** 链接跳到 `audit/*.md` 查看完整描述、代码片段、修复方案、验证步骤
3. 在你的 fix 分支做修改
4. Commit message:`fix: [BUG-XXX] <short description>`
5. 禁止署名 Claude/Anthropic/AI 字样(项目规则,husky hook 会拒绝)
6. 修完后通知本分支的审计 session 核查并更新状态

### 给本分支(`bugs_list`)的审计 session

1. 新审计完成 → 在 `audit/` 生成 `YYYY-MM-DD-round-N-found.md` 快照文件(不再改动)
2. 把新条目增量追加到本 `BUGS.md` 的对应 P0/P1/P2 桶
3. 收到修复通知 → 核查源代码(不相信 claims,看真实代码)→ 确认后在本文件中把对应行删除 + 追加到月度归档 `audit/YYYY-MM-closed.md`
4. 本分支永不 import / edit 业务代码,只 read

### 月度归档

每月末把已修复的 bug 汇总到 `audit/YYYY-MM-closed.md`,格式:`- [x] BUG-XXX · 修复 commit: <sha>(<YYYY-MM-DD>)· <一句话说明>`
