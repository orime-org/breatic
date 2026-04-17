# Bug Backlog（Active）

当前所有活跃未修复的 bug 一览。**本文件是状态机**——每条 bug 从发现到关闭都在这里更新。详细分析（代码片段、问题根因、修复方案、验证步骤）按发现事件归档在 `audit/YYYY-MM-DD-round-N-found.md`。

**状态标记**：`[ ]` 待修 · `[~]` 进行中 · `[x]` 已修（修完即移除本行并追加到月度归档）

**当前总计**：48 个活跃条目（P0 × 13 + P1 × 19 + P2 × 15 + 长期 × 1）

> **本分支（`bugs_list`）职责**：审计、核查、维护本文档。不做修复代码改动。修复请另开分支或在 `breatic_ai` 主 clone 进行。

---

## P0 — 立即修（安全 / 数据完整性 / 部署阻塞）

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-030 | 🔴 HIGH | Rate limiter X-Forwarded-For 绕过 | `core/src/infra/rate-limiter.ts` + `nginx.conf` | R2 | 45m | [→](audit/2026-04-15-round-2-found.md#bug-030-rate-limiter-可被-x-forwarded-for-绕过high) |
| BUG-031 | 🔴 HIGH | deleteProject 不级联软删子记录 | `core/src/modules/project.repo.ts:190` | R2 | 1h | [→](audit/2026-04-15-round-2-found.md#bug-031-deleteproject-不级联软删子记录high) |
| BUG-032 | 🔴 HIGH | Presigned URL 修复遗漏 3 子问题 | `server/src/routes/assets.ts` + `core/src/infra/storage/s3.ts` | R2 | 2.5h | [→](audit/2026-04-15-round-2-found.md#bug-032-presigned-url-修复只做了-47-子问题high) |
| BUG-033 | 🔴 HIGH | Canvas task 创建顺序错（孤儿 task） | `server/src/routes/canvas.ts:80` | R2 | 15m | [→](audit/2026-04-15-round-2-found.md#bug-033-canvas-task-创建顺序错孤儿-taskhigh) |
| BUG-034 | 🔴 HIGH | Docker 端口暴露到公网 | `docker-compose.yml` | R2 | 5m | [→](audit/2026-04-15-round-2-found.md#bug-034-docker-compose-端口暴露到公网high) |
| BUG-046 | 🔴 HIGH | WebSocket token 硬编码 `'dev'`（协作认证形同虚设） | `web/src/utils/yjsManager.ts:43,87` | R3 | 1h | [→](audit/2026-04-17-round-3-found.md#bug-046) |
| BUG-047 | 🔴 HIGH | `deductOnce` refKey 无校验 → 空 key 碰撞 | `core/src/modules/credit.service.ts:142` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-047) |
| BUG-048 | 🔴 HIGH | `deductOnce` 不校验 userId → 跨用户锁污染 | `core/src/modules/credit.service.ts:149` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-048) |
| BUG-049 | 🔴 HIGH | Worker HTTP 响应无大小限制 → OOM | `worker/src/providers/http.ts:76` | R3 | 45m | [→](audit/2026-04-17-round-3-found.md#bug-049) |
| BUG-050 | 🔴 HIGH | Spawn 无深度限制 → 无限递归耗光积分 | `core/src/agent/tools/spawn.ts:105` | R3 | 1h | [→](audit/2026-04-17-round-3-found.md#bug-050) |
| BUG-051 | 🔴 HIGH | TextNode 同步路径 innerHTML 未 sanitize → 存储 XSS | `web/.../textNode/TextNodeContent.tsx:141` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-051) |
| BUG-052 | 🔴 HIGH | `nodeHistory.userId` FK 缺 `onDelete` | `core/src/db/schema.ts:190` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-052) |
| BUG-053 | 🔴 HIGH | Stripe webhook secret 可为空字符串 → 签名绕过 | `core/src/infra/stripe.ts:39` + `env.ts:104` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-053) |

**P0 小计**：13 个 · 预估 **~9 小时**

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
| BUG-054 | 🔴 HIGH | NoAccount 模式只守 prod，staging 可绕过 | `server/src/middleware/auth.ts:60` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-054) |
| BUG-055 | 🔴 HIGH | Skill metadata.json 解析失败静默 fallback → scope 绕过 | `core/src/agent/skills-loader.ts:346` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-055) |
| BUG-056 | 🔴 HIGH | Worker polling 无单次请求超时 → Worker 挂起 | `worker/src/providers/http.ts:129` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-056) |
| BUG-057 | 🟠 MED | 密码无最大长度（bcrypt DoS） | `shared/src/schemas/api.ts:17,23` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-057) |
| BUG-058 | 🟠 MED | Collab PG 持久化 `store` 无 try-catch → 静默数据丢失 | `collab/src/persistence.ts:30` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-058) |
| BUG-059 | 🟠 MED | 事件流 parse 失败时立即更新 last-id → 流永久污染 | `collab/src/event-stream.ts:91` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-059) |
| BUG-060 | 🟠 MED | Checkout webhook 处理无事务包裹 → 扣费与审计错位 | `core/src/modules/payment.service.ts:96` | R3 | 45m | [→](audit/2026-04-17-round-3-found.md#bug-060) |
| BUG-061 | 🟠 MED | `addCredits` 接受负数 | `core/src/modules/user.repo.ts:136` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-061) |
| BUG-062 | 🟠 MED | `deductCredits` 接受 0/负数 → 负数扣费变加钱 | `core/src/modules/user.repo.ts:122` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-062) |
| BUG-063 | 🟠 MED | Worker 无 Docker healthcheck | `docker-compose.yml:85` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-063) |
| BUG-064 | 🟠 MED | Webhook 不校验 `creditsGranted` 金额 | `core/src/modules/payment.service.ts:85` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-064) |
| BUG-065 | 🟠 MED | 密码重置 token 无尝试次数限制 | `core/src/modules/auth.service.ts:206` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-065) |

**P1 小计**：19 个 · 预估 **~8 小时**

---

## P2 — 本月修

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-042 | 🟡 LOW | `extractPromptText` ReDoS 风险 | `core/src/agent/extract-prompt.ts` | R2 | 5m | [→](audit/2026-04-15-round-2-found.md#bug-042-extractprompttext-redos-风险low) |
| BUG-043 | 🟡 LOW | 错误日志泄露 stack trace | `server/src/middleware/error-handler.ts:21` | R2 | 10m | [→](audit/2026-04-15-round-2-found.md#bug-043-错误日志泄露-stack-tracelow) |
| BUG-044 | 🟡 LOW | `schema.ts` cascade 注释过时 | `core/src/db/schema.ts` | R2 | 5m | [→](audit/2026-04-15-round-2-found.md#bug-044-schemats-注释过时low) |
| BUG-066 | 🟠 MED | Worker 扣费失败仅 log，无恢复机制 | `worker/src/handlers.ts:221` | R3 | 1h | [→](audit/2026-04-17-round-3-found.md#bug-066) |
| BUG-067 | 🟠 MED | Spawn 注入无界 memory context → token 成本失控 | `core/src/agent/tools/spawn.ts:76` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-067) |
| BUG-068 | 🟠 MED | 空 toolset skill 静默完成（幻觉结果） | `worker/src/handlers.ts:417` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-068) |
| BUG-069 | 🟠 MED | Collab auth PG 连接池未关闭 → 连接泄漏 | `collab/src/auth.ts:76` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-069) |
| BUG-070 | 🟠 MED | 前端 Yjs undoManager 监听器内存泄漏 | `web/src/hooks/useYjsProjectStore.ts:73` | R3 | 30m | [→](audit/2026-04-17-round-3-found.md#bug-070) |
| BUG-071 | 🟠 MED | Subdoc provider 销毁时未逐个清理 subdoc | `web/src/utils/yjsManager.ts:100` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-071) |
| BUG-072 | 🟠 MED | `creditTransactions.referenceId` 无索引 | `core/src/db/schema.ts:283` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-072) |
| BUG-073 | 🟠 MED | `creditTransactions` 缺 `deletedAt`（审计表无软删） | `core/src/db/schema.ts:283` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-073) |
| BUG-074 | 🟠 MED | docker-compose.yml 硬编码 postgres 密码 | `docker-compose.yml:6` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-074) |
| BUG-075 | 🟠 MED | Worker 中 `redis` 变量声明后未使用（拆库遗留） | `worker/src/handlers.ts:84` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-075) |
| BUG-076 | 🟠 MED | Logout 路由重新解析 `Authorization` header 而非读 ctx | `server/src/routes/auth.ts:179` | R3 | 20m | [→](audit/2026-04-17-round-3-found.md#bug-076) |
| BUG-077 | 🟠 MED | CORS 配置无 wildcard + credentials 启动校验 | `server/src/middleware/cors.ts:13` | R3 | 15m | [→](audit/2026-04-17-round-3-found.md#bug-077) |
| BUG-078 | 🟡 LOW | 锁释放 `DEL` 失败未 log（潜在永久锁住节点） | `collab/src/task-listener.ts:142` | R3 | 10m | [→](audit/2026-04-17-round-3-found.md#bug-078) |

**P2 小计**：16 个 · 预估 **~5.5 小时**

---

## 长期 — 测试质量重构

| # | 严重度 | 标题 | 位置 | 发现 | 预估 | 详情 |
|---|--------|------|------|------|------|------|
| BUG-045 | 🔴 长期 | 65 个测试里仅 ~4 个真测业务，关键 bug 零覆盖 | 测试全库 | R2 | ~12h | [→](audit/2026-04-15-round-2-found.md#bug-045-测试大量是-mock-测试无法阻止回归high--长期任务) |

子任务：BUG-045-A extractPromptText 测试 · BUG-045-B user.repo 软删测试 · BUG-045-C payment webhook CAS 集成测试 · BUG-045-D 引入 stryker mutation testing · BUG-045-E 重写 HTTP route 测试

---

## 汇总

| 桶 | 数量 | 预估工时 |
|----|------|---------|
| P0 | 13 | ~9 h |
| P1 | 19 | ~8 h |
| P2 | 16 | ~5.5 h |
| 长期 | 1 | ~12 h |
| **总计** | **49**（含长期） | **~34.5 h** |

---

## 发现历史

- **Round 1**（2026-04-10 ~ 04-15）：29 个 bug 发现，**全部关闭**（PR #81-90）。详见 [`audit/2026-04-15-round-1-closed.md`](audit/2026-04-15-round-1-closed.md)
- **Round 2**（2026-04-15）：15 个 regression + 1 个测试质量 meta 发现。快照见 [`audit/2026-04-15-round-2-found.md`](audit/2026-04-15-round-2-found.md)。**状态：未修复**
- **Round 3**（2026-04-17）：33 个新发现（5 HIGH + 20+ MED + 少量 LOW）。快照见 [`audit/2026-04-17-round-3-found.md`](audit/2026-04-17-round-3-found.md)。**状态：未修复**

---

## 工作流说明

### 给负责修复的 Claude session（其他 clone / fix 分支）

1. 打开本文件找要修的 bug 编号
2. 点 **详情** 链接跳到 `audit/*.md` 查看完整描述、代码片段、修复方案、验证步骤
3. 在你的 fix 分支做修改
4. Commit message：`fix: [BUG-XXX] <short description>`
5. 禁止署名 Claude/Anthropic/AI 字样（项目规则，husky hook 会拒绝）
6. 修完后通知本分支的审计 session 核查并更新状态

### 给本分支（`bugs_list`）的审计 session

1. 新审计完成 → 在 `audit/` 生成 `YYYY-MM-DD-round-N-found.md` 快照文件（不再改动）
2. 把新条目增量追加到本 `BUGS.md` 的对应 P0/P1/P2 桶
3. 收到修复通知 → 核查源代码（不相信 claims，看真实代码）→ 确认后在本文件中把对应行删除 + 追加到月度归档 `audit/YYYY-MM-closed.md`
4. 本分支永不 import / edit 业务代码，只 read

### 月度归档

每月末把已修复的 bug 汇总到 `audit/YYYY-MM-closed.md`，格式：`- [x] BUG-XXX · 修复 commit: <sha>（<YYYY-MM-DD>）· <一句话说明>`
