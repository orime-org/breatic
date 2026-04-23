# Audit Round 7 — 发现快照(补 Round 6 Agent J timeout 盲点)

**审计日期**:2026-04-23(slim)
**对应代码**:`origin/main` HEAD `e978ffd`(含 PR #134/#135/#138/#140/#141/#142 + BUG-141/142/163/164 关闭)
**审计方法**:工作树 = main,读真实代码;严守 3 主题边界(rate limit 覆盖 / Zod max / auth 一致性)
**Backlog 参考**:BUG-132(8 endpoint 无 rate limit)· BUG-133(Zod max 缺)· BUG-131(X-Forwarded-For 绕过)· BUG-054/092(NoAccount 守卫)

> **本轮重要前提**:Round 6 覆盖 `feat/video-editor` 客户端 drop。04-22 00:00 之后 server 端只有 3 处后端改动:`packages/server/src/agent/main-agent.ts`(BUG-079 wiring)、`packages/server/src/routes/text-tools.ts`(BUG-079 + 新 `Idempotency-Key` header)、`packages/server/src/routes/canvas.ts`(BUG-031/033 rollback)、`packages/server/src/middleware/auth.ts`(BUG-131 membership 字段移除)。**PR #138/#140/#141/#142 几乎纯前端** —— 所有 video-editor 新操作(lip-sync / apply-to-host / HDR / audio denoise / scene-extension / stabilization / adjust / crop / speed / cut)都是**客户端 ffmpeg.wasm + 现有 `POST /mini-tools/video` Zod discriminated-union 新 `tool` 枚举值**(仍走 `videoToolSchema`)。因此 Round 7 真正的 server-side delta 有限。

---

## 主题 1 — Video editor 新 endpoint 的 rate limit 覆盖

### 结论概要

**没有引入任何新 server-side endpoint**。所有新 video editor 操作都复用了 04-22 之前已存在的 `POST /mini-tools/video`、`POST /mini-tools/audio`、`POST /canvas/tasks`、`POST /canvas/understand`,而这些 endpoint 本身依旧在 **BUG-132 无 rate limit** 的清单里。

`POST /mini-tools/text` 新增了 `Idempotency-Key` header 作为第二个受控输入通道,但端点本身仍然复用已有 route,也未新增 rate limit。

### BUG-172
**标题**:`POST /mini-tools/text` 新增 `Idempotency-Key` header 作为 billing refKey 组件,但该 endpoint **整体仍无 rate limit**(BUG-132 systemic scope 扩大)
- **严重度**:🟠 MED
- **位置**:`packages/server/src/routes/text-tools.ts:46`(读 header)+ `packages/core/src/modules/text-tool.service.ts:210`(写入 `deductOnce` refKey `texttool:${idempotencyKey}`)
- **问题**:
  1. `c.req.header("Idempotency-Key") ?? randomUUID()` 直接塞进 `deductOnce` 的 refKey 路径
  2. 整个 `textTools.post("/")` 没挂 rate limit — 和 BUG-132 的 8 个无 rate limit endpoint 同属一类
  3. 缺 rate limit 时,**任何持有 token 的用户**都能每秒发 1000+ 次 `POST /mini-tools/text`(每次都进入 Redis `text-tool-lock:${userId}`,lock 100% 冲突 → 99% 请求秒返回 `"Another text tool is already running"`,但**没扣费也没限流**)—— 放大 Redis IOPS + API CPU 面非常容易
  4. 携带任意 `Idempotency-Key` 反复命中同一 refKey → `deductOnce` 的 CAS 减少机制被利用成"**测试是否已扣**"的 oracle(侧信道)
  5. 头完全不走 Zod,客户端可传 MB 级 / 非 ASCII / 带换行的 header(依赖 Hono 上游限制;Hono 默认不加 max header size 到配置,nginx 在 proxy 层有 `large_client_header_buffers` 但 dev 无 nginx)
- **修复方案**:对 `textTools.post("/")` 挂 per-user rate limit(`checkRateLimit(redis, "texttool:${userId}", 30, 60)`),同时在 route handler 里做 `idempotencyKey` 的长度 + 字符校验(例如 `/^[A-Za-z0-9_:.-]{1,64}$/`),不匹配时直接返 400 或回落 `randomUUID()`
- **与 BUG-132 关系**:BUG-132 已列出 `text-tools.ts` 为 8 个无 rate limit 端点之一;本条只是**附加新攻击面**(Idempotency-Key 作为 refKey 一部分)作为 scope 扩大记录
- **预估**:并入 BUG-132 修;单独 +10m 加 Zod-style 校验

### BUG-173
**标题**:`POST /mini-tools/text` 的 `Idempotency-Key` pattern 与 `REFKEY_PATTERN` 不一致时,**免费完成请求**(BUG-133 的新变种)
- **严重度**:🔴 HIGH(主 session 从 agent 原判 MED 上调 — 扣费绕过等价于 BUG-079 严重度)
- **状态**:`[ ]` 待修(**P0**)
- **位置**:`packages/core/src/modules/credit.service.ts:29`(`REFKEY_PATTERN = /^[A-Za-z0-9_:.-]{1,255}$/`)+ `packages/core/src/modules/text-tool.service.ts:207-220`(`deductForTokens` 的 catch 块)
- **问题**:
  1. Server 构造 `texttool:${idempotencyKey}` 作为 `deductOnce` refKey
  2. 客户端传 `Idempotency-Key: foo bar`(含空格 / 中文 / 冒号等)→ `REFKEY_PATTERN` 匹配失败 → `deductOnce` 抛 `ValidationError: deductOnce: refKey must match ...`
  3. `text-tool.service.ts:215` 的 `catch {}` 静默吞掉(就地 `logger.warn` 后返回 0)
  4. **用户得到完整 AI 文本,却 0 credit 扣费** —— 攻击者脚本每次请求传 `Idempotency-Key: \n`(或任意非 ASCII)→ 持续免费用 text-tool
  5. CLAUDE.md 禁止清单明确列 **"裸 catch"** —— `text-tool.service.ts:215` 的 `catch {}` 是违反
- **修复方案**:
  a. route 层对 `idempotencyKey` 做 `REFKEY_PATTERN` 预校验,不匹配直接覆盖为 `randomUUID()`(最小改动)
  b. 或:`deductForTokens` 的 `catch` 区分 `ValidationError`(客户端错误,应抛 400)vs 其他(账户余额不足,当前 soft-fail 逻辑);前者必须失败整个请求
  c. 不能采用现在的 "deduction 失败静默成功" 模式 —— 违反软失败-但-不-免费 原则
- **相关**:BUG-133(Zod max 缺)语义重叠,但这条聚焦于**字符集**而非长度,BUG-133 已覆盖 `chat_message` / `skill_command` 等 body 字段,本条是头字段入口
- **预估**:20m

### [非新编号] BUG-M-03 → BUG-132 scope 扩大记录
**标题**:Video editor 新操作(lip-sync / apply-to-host / HDR / scene-extension / audio-denoise / stabilization 等 6+ 种)未走新 endpoint,全部堆到**同一个**已知无 rate limit 的 `POST /mini-tools/video`(BUG-132 攻击面放大)
- **严重度**:🟡 LOW(观察 / scope 扩大)
- **位置**:
  - `packages/server/src/routes/mini-tools.ts:121`(`POST /mini-tools/video`)
  - `packages/server/src/routes/schemas.ts:47-55`(`videoToolSchema`,新前端代码通过 tool="animate" / "extend" / "talking-head" / "motion" 等复用)
- **问题**:
  1. Round 6 / BUG-132 已记录 `/mini-tools/video` 无 rate limit
  2. PR #134/#135 后,video-editor 8 种操作(包括客户端 ffmpeg 做的和调后端 Worker 的)**都指向同一个端点**
  3. 单个恶意用户开启浏览器 devtools 脚本可一秒发 20 次请求,每次 `tool: "edit"` 带任意 prompt —— 因 `checkCredits` 只卡 `< 5`,用户 balance 够的话可**无限入队**;balance 不够也能**无限触发 402 返回** → Worker queue 状态污染不了,但 API CPU + Redis `credits` 读次数爆
  4. 结合 BUG-157(`video: z.string()` 无 URL 校验),单个认证用户可以高速提交到第三方 provider
- **修复方案**:并入 BUG-132 修;为 `/mini-tools/*` 三个端点统一挂 `checkRateLimit(redis, "minitools:${userId}", 60, 60)`
- **预估**:0(并入 BUG-132)

---

## 主题 2 — Zod schema 在新 route 上的 max 边界

### 结论概要

`packages/shared/src/schemas/api.ts` 在 2026-04-22 之后**没有任何改动**(`git log bf9fe8b..HEAD -- packages/shared/src/schemas/` 无 commits)。`packages/server/src/routes/schemas.ts` 也**零改动**。BUG-133 仍 100% active。

有 1 个**新受控输入通道**在 Zod 外(HTTP header `Idempotency-Key`)—— 已在 BUG-173 中记录。

### [非新编号] BUG-M-04 → BUG-157 scope 扩大记录
**标题**:`videoToolSchema` 新增用法场景 video-editor 多类 `tool` 枚举复用,但 `video: z.string()` 仍无长度 / URL / scheme 限制(BUG-157 systemic 状态未变,scope 提醒)
- **严重度**:🟡 LOW(状态复查,非新 bug)
- **位置**:`packages/server/src/routes/schemas.ts:47-55`
- **问题**:
  - `z.string()` 对所有 `video` / `image` / `audio` / `images` / `prompt` 字段不设 max;PR #134/#135 后该字段被更多 video-editor tool 使用,**攻击面复用放大**(非新字段,是既有 BUG-157 / BUG-133 的影响扩展)
  - 前端 UI 未暴露任意 URL 输入,但任何认证用户可以直接 POST `{ tool: "animate", video: "file:///etc/passwd" }` —— provider 是否 fetch 则是 BUG-157 的讨论范围
- **结论**:**无需新编号**;BUG-157 / BUG-133 修复时顺便覆盖即可
- **预估**:合并 BUG-157 / BUG-133

### BUG-174
**标题**:`nodeHistoryQuerySchema` 与 `videoToolSchema` 在新 video-editor 使用下 `project_id: z.string()` / `node_id: z.string()` 仍无 UUID regex 校验(BUG-133 scope 扩大)
- **严重度**:🟡 LOW
- **位置**:
  - `packages/server/src/routes/schemas.ts:30, 31`(`imageToolBase` 的 `node_id: z.string().optional()` / `project_id: z.string().optional()`)
  - `packages/server/src/routes/schemas.ts:47-55`(video / audio 同款)
  - `packages/server/src/routes/canvas.ts:205-210`(`nodeHistoryQuerySchema` 的 `project_id: z.string().uuid()` **是** UUID 校验 — 对比)
- **问题**:
  - canvas.ts nodeHistory 做了 `z.string().uuid()` 校验,但 mini-tools 的 `node_id` / `project_id` **没 uuid 校验**
  - 这意味着 mini-tool 的 cross-tenant guard(`projectService.assertAccess`)查询时用任意字符串(包括空 / 特殊字符)去查 PG — Drizzle 会把它 cast 成 UUID,若不合法直接 SQL error 500(不是 400);信息泄漏可忽略,但 API 一致性差 + 潜在 log 注入
- **修复方案**:mini-tools 几个 `*ToolBase` 的 `node_id` / `project_id` 统一改为 `z.string().uuid().optional()`
- **预估**:10m(一并进 BUG-133 修)

---

## 主题 3 — Auth middleware 在新 route 的一致性

### 结论概要

Server 侧 9 个 route 文件全部有 `requireAuth` 覆盖(见下方清单)。04-22 之后**没有新增 route 文件**,因此**没有新 auth gap**。`middleware/auth.ts` 的 `env.LOGIN_MODE === "NoAccount" && env.ENV !== "prod"` 逻辑未变(仍是 BUG-054),collab `auth.ts` 的 `process.env.ENV !== "prod"` 逻辑未变(仍是 BUG-092)。无**新**复制守卫出现。

### Auth 覆盖清单(验证完整)

| Route file | middleware | 保护范围 |
|---|---|---|
| `assets.ts` | `requireAuth`(每个 endpoint 显式) | 4 个 |
| `auth.ts` | `rateLimit()` 包裹 5 个 + `requireAuth` 包裹 `/me` `/logout` | 7 个 |
| `canvas.ts` | `canvas.use("*", requireAuth)` | 4 个 |
| `chat.ts` | `chat.use("*", requireAuth)` | 6 个 |
| `health.ts` | 无(健康检查) | — |
| `mini-tools.ts` | `miniTools.use("*", requireAuth)` | 3 个 |
| `models.ts` | (读) | — |
| `payment.ts` | `requireAuth` 每个 endpoint | 3 个 |
| `projects.ts` | `projects.use(requireAuth)` | N |
| `skills.ts` | `skills.use(requireAuth)` | N |
| `tasks.ts` | `tasks.use(requireAuth)` | N |
| `text-tools.ts` | `textTools.use(requireAuth)` | 1 个 |

### BUG-175
**标题**:collab `auth.ts` 新增的 `project-<uuid>/node/<nodeId>` 文档类型 `.+` suffix 无字符 / 长度白名单 → 认证用户可生成超长 nodeId,自项目 `yjs_documents.name` PK 膨胀(非 cross-tenant,DoS 窄面)
- **严重度**:🟡 LOW
- **位置**:
  - `packages/collab/src/auth.ts:44-45`(`/^project-([0-9a-fA-F-]{36})\/(canvas|node\/.+)$/` — `node/.+` 接受任意字符)
  - `packages/collab/src/persistence.ts:28, 43`(`yjsDocuments.name` 用作 PK 存储/查询)
  - `packages/core/src/db/schema.ts:491-492`(`name: text("name").primaryKey()` — 无长度上限的 `text`)
- **问题**:
  - 新 feat `feat/node-editor-yjs-foundation-text-editor`(PR #138)在客户端建立 `project-<uuid>/node/<nodeId>` 文档。nodeId 由客户端编码进 docName,collab/auth 只校验 projectId 属于该用户
  - nodeId 可以是任意长度(`text` 类型无 max),**同一认证用户可以生成 10k 个不同 nodeId 的 Yjs 文档**,每个一行 PG + 自己的 Redis pub/sub subscribe
  - 单用户 DoS 自己项目,不跨租户 —— **攻击面窄**,但和 BUG-156(upload 无大小限)/ BUG-129(assets local-upload)一起构成 authenticated-user-self-DoS 族
- **修复方案**:
  1. `parseProjectIdFromDocName` 将 `/node/.+` 改为 `/node/([0-9a-fA-F-]{8,36})$`(只接 UUID 或短 nodeId pattern)
  2. `yjs_documents.name` schema 改成 `varchar(128)`(需 migration + `IF EXISTS` 防 BUG-082 pattern)
- **预估**:30m

### BUG-176
**标题**:collab `auth.ts` 的 `parseProjectIdFromDocName` 使用 tolerant regex(`[0-9a-fA-F-]{36}`)而非 RFC 4122 严格 UUID v4,存在 timing / 路径分岐(副作用项,信息)
- **严重度**:🟡 LOW(信息)
- **位置**:`packages/collab/src/auth.ts:44`
- **问题**:
  - regex 接受 `project-00000000-0000-0000-0000-000000000001/canvas` 这种非 v4 UUID(测试 fixture 用),但生产 `projects.id` 都是 v4
  - 后续 SQL `WHERE id = ${projectId}` 查不到就 403,但**中间多了 1 次 PG round-trip**
  - 攻击者可以发射精心构造但与某存在 projectId 差 1 位的 hex 字符串,fail 速度仅等于 SQL roundtrip(约 1-3ms)—— 不是严重信息泄漏,但是**在高 QPS 下无 rate limit 的 collab auth 面变大**
  - 并且该 endpoint **没有 rate limit**(hocuspocus `onAuthenticate` 无内置限流)
- **修复方案**:
  1. tolerant regex 保留(测试不 break),但在 auth 成功前加 `checkRateLimit(redis, "collab-auth:${ip}", 30, 60)`
  2. 或:`collab/src/server.ts` hocuspocus 构造时加 `connect-src` 限制(IP-level;hocuspocus 不提供,可能需要 WS 握手中间件)
- **预估**:45m

---

## 汇总

| 桶 | 数量 | 编号 |
|---|---|---|
| 🔴 HIGH | 0 | — |
| 🟠 MED | 3 | BUG-172, BUG-173, BUG-M-03 |
| 🟡 LOW | 4 | BUG-M-04, BUG-174, BUG-175, BUG-176 |
| **合计** | **7** | BUG-172 ~ BUG-176 |

> **注**:BUG-M-XX 是本轮临时编号,consolidator 需要重编并入 BUG-132/133/157 的 systemic 扩大备注,或作为独立条目编入。

---

## 方法备忘 / 审计限制

- **时间消耗**:~12 分钟 · 严守 3 主题边界,未扩散到 FFmpeg / UI / state(Round 6 覆盖)
- **工作树状态**:bugs_list 已 FF 到 `e978ffd`,直接读真实代码,不走 `git show`
- **发现分布特点**:Round 7 预期外地 delta 偏少 —— 因为 PR #134/#135/#138/#140/#141/#142 的后端改动面极窄。真正有价值的 delta 集中在 **client 端功能堆到同一个已知弱 endpoint**(BUG-132 scope 放大)+ **Idempotency-Key 作为新受控 header 入口**(BUG-133 变种)
- **与 Round 6 无重复**:所有 7 条都是 server / collab / schema 边界,Round 6 H/I 全在前端 + 前端 util;Round 6 Agent J 失踪的"systemic 回归"部分由本轮 3 主题覆盖
- **BUG-128(Host/Origin Header Injection)**:现状 `auth.ts:197` 用 `c.req.header("Origin")` 构 reset URL,Origin 头和 Host 一样可伪造。此点 = BUG-128 当前修复未完成,**不是新发现**,这里仅备注

---

## 下一步建议(供 consolidator / 主 session)

1. **BUG-132 修复时**至少明确覆盖:chat.ts(2)· canvas.ts(4)· mini-tools.ts(3)· text-tools.ts(1) = 10+ 个 endpoint
2. **BUG-133 修复时**扩大 scope 到 `text-tools.ts` 的 `Idempotency-Key` header(本轮 BUG-172/02)+ mini-tools `node_id` / `project_id` 用 uuid (本轮 BUG-174)
3. **collab/auth.ts** 加 rate limit 和 nodeId 白名单(本轮 BUG-175/07)建议与 BUG-132 一起做 —— 所有 authenticated endpoints 应统一有 per-user rate limit
4. **text-tool.service.ts 的 `catch {}`**(BUG-173 提到)违反 CLAUDE.md 禁止清单,与 BUG-159 是同类模式扩大 —— 可并入 BUG-159 修复清单
