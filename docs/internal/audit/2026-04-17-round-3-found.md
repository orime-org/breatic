# Audit Round 3 — 发现快照

**审计日期**：2026-04-17
**对应代码**：`breatic_ai_bug` clone · `main` 分支 · commit `aea76c6`（截止审计时）
**审计方法**：从 `bugs_list` 分支并行派 4 个专题 agent 扫描代码库，覆盖 Round 2 未深入的模块
**发现总数**：33 个新条目（8 P0 + 12 P1 + 13 P2）· 另有 1 个与 Round 2 的 BUG-038 重叠已并入描述

> 本文件是历史快照，**定稿后不再修改**。Bug 的修复进度在 [`../BUGS.md`](../BUGS.md) 跟踪。

---

## 审计范围与方法

| Agent | 覆盖模块 | 发现数（去重后） |
|-------|---------|----------------|
| A | Auth 路由 + 安全中间件 + CORS + OAuth + 密码重置 | 6（排除 BUG-030 重复） |
| B | Worker 5 条执行路径 + Agent 9 个工具 + Skills 加载 + Redis 拆库 | 9 |
| C | Collab 服务 + Yjs 持久化 + 事件流消费 + 前端画布/编辑器 | 8 |
| D | 支付/积分 + 数据库 schema + Repository 层 + Docker 部署 | 14（排除 3 个非 bug 的低优代码质量） |

## 与 Round 2 的对照

- Round 2 的 15 个 bug（BUG-030~045）在本轮审计时**未发现任何已修复证据**，全部仍然活跃
- BUG-060（Checkout webhook 无事务包裹）是 BUG-038（Credit transaction 隔离级别）的"加强版"：两者都指向 credit 扣费流程事务边界不完整，修复时应合并考虑

---

## P0 — 新发现（立即修）

### BUG-046

**标题**：WebSocket token 硬编码为字符串 `'dev'`，协作认证在所有环境形同虚设

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/web/src/utils/yjsManager.ts:43` + `:87`

**当前代码**：

```typescript
const provider = new HocuspocusProvider({
  url: wsUrl,
  name: docId,
  document: doc,
  token: 'dev',   // 硬编码
  timeout: 10000,
});

// subdoc provider 同样：
subdocProviders.set(subdoc.guid, new HocuspocusProvider({
  url: wsUrl,
  name: subdoc.guid,
  document: subdoc,
  token: 'dev',   // 同样硬编码
}));
```

**问题**：

前端连接 Hocuspocus 协作服务时，WebSocket token 写死为字符串 `'dev'`。后端 `collab/src/auth.ts` 的 auth hook 用该 token 查 Redis（`${env}:session:${token}`）。两种情况：

1. **正常情况下**：`'dev'` 不会在 Redis 中有 session，认证失败，用户无法进入协作——与日常使用矛盾，说明实际上某处创建了 `session:dev`，或者 auth hook 被放行了
2. **如果 `'dev'` 在 Redis 中对应某个用户**：任何人只要知道项目 ID 就能连接任意项目的 Yjs 文档，读写画布、编辑器的所有内容

无论哪种情况，**协作层的认证都没有起到隔离用户的作用**。

**修复方案**：

前端从 auth store / context 读取用户真实 session token 并传给 HocuspocusProvider；后端 `collab/src/auth.ts` 需同步：
- 验证 token 不为空
- 从 Redis 查 session 且校验 session 对应的 user 有该 project 的访问权限（当前逻辑只查 session 存在性，不查 authz）

**验证**：

1. 登录 User A，获取 session token
2. 用浏览器 devtools 改 WS 连接的 token 为 `'dev'` 或空字符串 → 应该收到 auth rejected
3. 用 User A 的 token 连接 User B 的项目 → 应该收到 forbidden
4. 用 User A 的 token 连接 User A 自己的项目 → 成功

**预估**：1 小时（含后端 authz 加强）

---

### BUG-047

**标题**：`deductOnce` refKey 无非空校验 → 空 refKey 导致锁键碰撞跳过扣费

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/core/src/modules/credit.service.ts:142` 附近

**当前代码**：

```typescript
export async function deductOnce(
  userId: string,
  refKey: string,         // 无校验
  amount: number,
  description: string,
  options?: { tokensUsed?: number; model?: string; provider?: string },
): Promise<{ deducted: boolean; creditsAfter?: number }> {
  const redis = getRedis();
  const lockKey = `${env.ENV}:bill:${refKey}`;   // 空 refKey → key = "dev:bill:"
  const acquired = await redis.set(lockKey, userId, "EX", 86400, "NX");
  if (acquired !== "OK") {
    return { deducted: false };
  }
  // ... 扣费 ...
}
```

**问题**：

如果调用方传入 `refKey=""` 或 `refKey=null`（被 TypeScript 转 string 变成 `"null"`）：
- 锁键变成 `"dev:bill:"` 或 `"dev:bill:null"`——**所有空 refKey 的交易共享同一把锁**
- 第一次设置成功，后续所有空 refKey 的 `deductOnce` 调用都会返回 `{ deducted: false }` → **免费使用 AIGC**
- Redis 锁 TTL 是 86400 秒（24 小时），一次设置占用一天

**修复方案**：

```typescript
export async function deductOnce(userId, refKey, amount, description, options) {
  if (typeof refKey !== 'string' || refKey.length === 0 || refKey.length > 255) {
    throw new ValidationError('deductOnce: refKey must be non-empty string ≤255 chars');
  }
  if (!/^[a-zA-Z0-9_:.-]+$/.test(refKey)) {
    throw new ValidationError('deductOnce: refKey contains illegal characters');
  }
  // ... 其余不变 ...
}
```

**验证**：单测覆盖空串 / null / 过长 / 合法 / 重复 refKey 等路径。

**预估**：30 分钟（含测试）

---

### BUG-048

**标题**：`deductOnce` 锁不含 userId，用户 B 可利用用户 A 的 refKey 跳过自己的扣费

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/core/src/modules/credit.service.ts:149` 附近

**当前代码**：

```typescript
const lockKey = `${env.ENV}:bill:${refKey}`;    // 不含 userId
const acquired = await redis.set(lockKey, userId, "EX", 86400, "NX");
if (acquired !== "OK") {
  logger.debug({ refKey }, "deductOnce: already billed, skipping");
  return { deducted: false };     // 不 check lock 中的 userId
}
```

**问题**：

锁键只包含 refKey，不含 userId。攻击场景：

1. 用户 A 合法调用 `deductOnce('taskA-id', 50)` → 锁键 `dev:bill:taskA-id` 设置为 `userA`
2. 用户 B 用同样的 `refKey='taskA-id'` 调自己的 `deductOnce('taskA-id', 100)` → SETNX 返回 nil → 函数返回 `{ deducted: false }` → **用户 B 的 100 积分没扣**

即使 refKey 是由系统生成（例如 taskId UUID），**任何能看到别人 taskId 的地方都有风险**——比如日志、错误响应、前端 state。

**修复方案（推荐：锁值校验方案）**：

```typescript
const lockKey = `${env.ENV}:bill:${refKey}`;
const lockValue = JSON.stringify({ userId, timestamp: Date.now() });
const acquired = await redis.set(lockKey, lockValue, "EX", 86400, "NX");
if (acquired !== "OK") {
  const existing = await redis.get(lockKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed.userId === userId) {
        return { deducted: false };  // 幂等重入
      }
    } catch { /* fallthrough */ }
  }
  throw new ConflictError('deductOnce: refKey already used by another user');
}
```

**验证**：

```typescript
await deductOnce(userA, 'shared-ref', 50, ...) // 成功
await deductOnce(userA, 'shared-ref', 50, ...) // 幂等: deducted=false, no charge
await deductOnce(userB, 'shared-ref', 50, ...) // 应抛 ConflictError
```

**预估**：30 分钟

---

### BUG-049

**标题**：Worker 外部 HTTP 响应无大小限制 → 恶意 provider 可让 Worker OOM

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/worker/src/providers/http.ts:76`（`requestWithRetry`）+ `:129`（`pollUntilDone`）

**当前代码**：

```typescript
if (response.ok) {
  return (await response.json()) as Record<string, unknown>;
  // response.json() 无 size limit
}
```

**问题**：

`fetch().json()` 会把整个响应 body 读进内存再解析。如果：
- Provider 被攻陷 → 返回 GB 级 JSON
- Provider bug → 返回巨大 debug dump
- 中间人攻击 → 注入大 payload

→ Worker 进程 OOM 崩溃 → BullMQ job 失败 → 其他并发任务受牵连

**修复方案**：

实现 `readBoundedJson(response, maxBytes)` 工具，用 ReadableStream 边读边校验，超过阈值（建议 10MB）立即 `reader.cancel()` 并抛错。所有 `requestWithRetry` / `pollUntilDone` 的成功分支改用该工具。

**验证**：测试里 mock 一个返回 50MB JSON 的 fetch → 应抛 "Response exceeds" 错误而非 OOM。

**预估**：45 分钟

---

### BUG-050

**标题**：Spawn 工具无递归深度限制，子智能体可继续 spawn 导致无限链

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/core/src/agent/tools/spawn.ts:105`

**当前代码**：

```typescript
const agentTools = new Set(agentDef.tools);
for (const skillName of skillNames) {
  const skill = registry.get(skillName);
  if (skill) for (const t of skill.tools) agentTools.add(t);
}
agentTools.delete("spawn"); // 只从自身工具集移除
```

**问题**：

注释 `Prevent recursive spawning` 的本意是防止无限递归，但只移除了**当前子智能体的** spawn。A→B→C 链式 spawn 在当前实现下确实被切断（B 看不到 spawn），但——

**真正问题**：主智能体 MainAgent 可以在单轮内 spawn 多次（`stepCountIs(15)`），**不限制一次迭代内的 spawn 总次数**。

攻击/事故场景：
- 用户提示注入 "你需要 spawn 50 次不同的 researcher" → 主智能体真的 spawn 50 次
- 每次 spawn 继承完整 memory context（见 BUG-067），每次走 15 步循环
- 单个用户请求可能烧掉数百刀的 token

**修复方案**：

用 AsyncLocalStorage 传递 `spawnCount` 计数器，`spawnTool.execute` 内部 increment 并在超过阈值（默认 5）时返回错误而不执行。同时加深度 `depth` 限制以防未来修改逻辑允许子 spawn。

**验证**：单元测试 mock 一个会尝试 spawn 10 次的 main agent，验证第 6 次起收到错误。

**预估**：1 小时（含测试）

---

### BUG-051

**标题**：TextNode 从 Yjs 同步内容时通过原生 DOM 写入 HTML，未经消毒 → 存储型 XSS

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/web/src/apps/project/components/canvas/dataNode/textNode/TextNodeContent.tsx:141`

**问题描述**：

TextNode 组件有两条数据流入前端 DOM 的路径：

1. **Preview 路径**（约 336-338 行，用户没选中节点时）：经 React 的 HTML 注入 API 渲染，**渲染前调用 `sanitizeRichText()`**——安全
2. **Editor 路径**（约 141 行，用户点击进入编辑态时）：从 Yjs 同步的 `value` 字符串**通过原生 DOM 属性 innerHTML 写入** contentEditable 元素，**中间不调用任何 sanitize 函数**

攻击场景：
- 恶意 Yjs 更新（通过 BUG-046 协作认证绕过，或 LLM 提示注入产生）往节点写入带 XSS payload 的 HTML
- 用户点开该节点 → 原生 DOM 写入路径把字符串当 HTML 解析 → 事件处理器（如 `onerror`）执行 → **cookie/session 泄漏**

Yjs 文档持久化 → 这是**存储型 XSS**，影响所有后续打开该节点的用户。

**修复要点**：

- 在 Editor 路径的同步代码里，**先调用 `sanitizeRichText(value)` 过滤**，再把结果写入编辑器元素
- 额外防御：写入 Yjs 之前在客户端再过滤一次（defense in depth）
- 后端接收 Yjs update 时做内容检查（困难——Yjs 是二进制增量格式，需解析出文本字段）

**验证**：

1. 用 devtools 直接修改 Yjs 节点 content 字段，植入一段会在 DOM 解析时触发 JS 的 HTML payload
2. 刷新或切换节点 → 选中该节点 → 若 payload 被执行说明漏洞仍在；若渲染为纯文本或被剥离则已修复

**预估**：20 分钟（代码改动）+ 真实 E2E 验证

---

### BUG-052

**标题**：`nodeHistory.userId` FK 缺 `onDelete` 声明，与其他 FK 不一致

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/core/src/db/schema.ts:190-192`

**当前代码**：

```typescript
userId: uuid("user_id")
  .notNull()
  .references(() => users.id),   // 缺少 { onDelete: ... }
```

**问题**：

项目所有其他 FK 约束都显式声明 `{ onDelete: "restrict" }`（参考 Round 2 BUG-020/021 的修复），确保软删父记录时数据库阻止级联。`nodeHistory.userId` 这一条**唯一例外**——PostgreSQL 默认 NO ACTION，行为不可预测。

影响：
- 未来做 GDPR 硬删用户时，nodeHistory 可能变成孤儿记录
- 代码一致性问题

**修复方案**：

```typescript
userId: uuid("user_id")
  .notNull()
  .references(() => users.id, { onDelete: "restrict" }),
```

同时需要**补数据库 migration**（drizzle generate），因为已有生产数据库的约束不会因代码改动自动变更。

**验证**：

```sql
SELECT conname, confdeltype FROM pg_constraint
WHERE conrelid = 'node_history'::regclass AND contype = 'f';
-- 改动前: confdeltype = ' '（no action）
-- 改动后: confdeltype = 'r'（restrict）
```

**预估**：15 分钟（schema + migration）

---

### BUG-053

**标题**：Stripe webhook secret 允许默认空字符串，`PAYMENT_ENABLED=true` 但未配置时签名校验被绕过

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/core/src/infra/stripe.ts:39-53` + `packages/core/src/config/env.ts:104`

**当前代码**：

```typescript
// env.ts
STRIPE_SECRET_KEY: z.string().default(""),
STRIPE_WEBHOOK_SECRET: z.string().default(""),

// stripe.ts
export function verifyWebhookSignature(payload, signature): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("Stripe webhook verification requires STRIPE_WEBHOOK_SECRET.");
  }
  return getStripeClient().webhooks.constructEvent(
    payload, signature, env.STRIPE_WEBHOOK_SECRET,
  );
}
```

**问题**：

Zod 的 `.default("")` 让 Stripe 相关环境变量即使未设置也能通过启动校验。运维误配 `STRIPE_WEBHOOK_SECRET=" "`（单空格），JS 认为 truthy，校验会传空格字符串给 Stripe → Stripe SDK 抛 Invalid Signature，但不是预期的"配置缺失"错误。

**修复方案**：

在 `env.ts` 的 Zod superRefine 里加交叉检查：

```typescript
export const envSchema = z.object({
  PAYMENT_ENABLED: z.string().default("false").transform(v => v === "true"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
}).superRefine((env, ctx) => {
  if (env.PAYMENT_ENABLED) {
    if (!env.STRIPE_SECRET_KEY.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PAYMENT_ENABLED=true requires STRIPE_SECRET_KEY to be set",
      });
    }
    if (!env.STRIPE_WEBHOOK_SECRET.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PAYMENT_ENABLED=true requires STRIPE_WEBHOOK_SECRET to be set",
      });
    }
  }
});
```

同时 `verifyWebhookSignature` 内部的校验加 `.trim()`。

**验证**：
1. 设 `PAYMENT_ENABLED=true STRIPE_WEBHOOK_SECRET=""` → 启动失败
2. 设 `PAYMENT_ENABLED=true STRIPE_WEBHOOK_SECRET=" "` → 启动失败
3. 设 `PAYMENT_ENABLED=false STRIPE_WEBHOOK_SECRET=""` → 正常启动

**预估**：15 分钟

---

## P1 — 新发现（本周修）

### BUG-054

**标题**：NoAccount 模式只守 `ENV=prod`，`staging` 可绕过认证

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH（在 staging 环境暴露 PII）
- **位置**：`packages/server/src/middleware/auth.ts:59-66` + `packages/core/src/config/env.ts:142-147`

**当前代码**：

```typescript
if (env.LOGIN_MODE === "NoAccount") {
  if (env.ENV === "prod") {
    return c.json({ error: { code: 500, message: "NoAccount mode forbidden in production" } }, 500);
  }
  await ensureDevUser();
  c.set("user", DEV_USER);
  await next();
  return;
}
```

**问题**：

NoAccount 模式只在 `ENV=dev` 应该可用。但当前守卫只挡 `ENV=prod`，`staging` / `test` / 任何其他值都被放行。运维搭建 staging 若误用 `ENV=staging LOGIN_MODE=NoAccount`，所有访问都以 dev 用户身份执行 → 数据、操作互相污染，PII 泄漏。

**修复方案**：

改为白名单，`env.ENV !== "dev"` 即拒绝。同步更新 `env.ts` 启动校验（superRefine），启动即拒绝。

**预估**：15 分钟

---

### BUG-055

**标题**：Skill metadata.json 解析失败静默 fallback，导致 `disable_model_invocation` 等安全属性丢失

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/core/src/agent/skills-loader.ts:346-350`

**当前代码**：

```typescript
function loadMetadata(skillDir: string): Record<string, unknown> {
  const pkgPath = join(skillDir, "metadata.json");
  if (!existsSync(pkgPath)) return {};
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};    // 静默 fallback 到空 metadata
  }
}
```

**问题**：

如果 skill 的 `metadata.json` 损坏：
- `JSON.parse` 抛错 → catch 吞掉 → 返回 `{}`
- Skill 以**默认值**加载：`scope=[]`、`disable_model_invocation=false`、`tools=[]` 等
- 本该仅用户手动触发的 skill 变成 LLM 可调用
- 本该只在 canvas 区注入的 skill 变成全区通用

安全属性被静默降级。

**修复方案**：

parse 失败时 throw，上层 `loadSkillRegistry` 捕获并**跳过该 skill**（不注册到 registry），同时告警。

**验证**：故意写一个 `skills/bad-skill/metadata.json` 含 `{ invalid json`，重启服务 → 日志应出现 "Skill failed to load"，`listSkills()` 不应包含 bad-skill。

**预估**：30 分钟

---

### BUG-056

**标题**：Worker `pollUntilDone` 每次轮询请求无单独超时，provider 慢响应可让 Worker 挂起

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH
- **位置**：`packages/worker/src/providers/http.ts:115-152` + 各 transport

**当前代码**：

```typescript
export async function pollUntilDone(url, options) {
  const maxWait = options.maxWait ?? 300_000;   // 总墙上时间上限
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWait) {
    const result = await requestWithRetry(url, {
      method: "GET",
      headers: options.headers,
      // 没传 signal，requestWithRetry 内部 fetch 也没默认超时
    }, "poll");
    if (isDone(result)) return result;
    await sleep(options.pollInterval ?? 2000);
  }
  throw new Error("Poll timeout");
}
```

**问题**：

- `maxWait` 控制"总耗时不超过 5 分钟"，但单次 poll 请求挂起（TCP 建立但 provider 不返回 body）会独占等待时间
- 多个任务同时 poll 同一个挂起 provider → Worker 池耗尽

**修复方案**：

在 poll 循环内每次 fetch 都传 `AbortSignal.timeout(perRequestTimeout)`，默认 30 秒。超时被捕获后继续 loop 重试，直到达到 maxWait。

**预估**：30 分钟

---

### BUG-057

**标题**：密码 Zod schema 无最大长度限制，bcrypt 超长输入可造成 CPU DoS

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/shared/src/schemas/api.ts:17, 23`

**当前代码**：

```typescript
// Register
password: z.string().min(8),       // 无 max
// Login
password: z.string(),              // 无任何校验
```

**问题**：

攻击者发送 1 MB 密码 → bcrypt 耗时数秒 → 占 Node 事件循环 → 配合 BUG-030 可耗尽 CPU。

**修复方案**：

```typescript
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
// Register
password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
// Login
password: z.string().min(1).max(PASSWORD_MAX),
```

bcrypt 在 72 字节以上会截断，128 是宽松但安全的上限。

**预估**：10 分钟

---

### BUG-058

**标题**：Collab PG 持久化 `store` 回调无 try-catch，DB 故障时静默丢数据

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/collab/src/persistence.ts:30-37`

**当前代码**：

```typescript
store: async ({ documentName, state }) => {
  await sql`
    INSERT INTO yjs_documents (name, data, updated_at)
    VALUES (${documentName}, ${state}, NOW())
    ON CONFLICT (name) DO UPDATE
    SET data = EXCLUDED.data, updated_at = NOW()
  `;
},
```

**问题**：

- DB 暂时不可用（PG restart、连接池耗尽、网络抖动）→ store 调用失败 → 本次 Yjs update **不会落盘**
- 客户端内存正常，但服务端重启后回退到上次成功保存的版本
- 期间操作**静默丢失**

**修复方案**：

wrap try-catch，记录 error 日志并重新抛（让 Hocuspocus 知道保存失败，可能 disconnect 客户端警示）。进一步建议接 Sentry 或 DLQ。

**预估**：20 分钟（基础修复）+ 2h（告警/DLQ 可选）

---

### BUG-059

**标题**：事件流 parse 失败时立即更新 last-id，错误事件永久污染流

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/collab/src/event-stream.ts:91-98`

**当前代码**：

```typescript
let event: T;
try {
  event = parse(raw);
} catch (err) {
  logger.error({ id, err, raw }, "Failed to parse event payload, skipping");
  lastId = id;
  await redis.set(lastIdKey, lastId);   // parse 失败也推进位点
  continue;
}
```

**问题**：

- 损坏事件对应的任务永远不被处理——canvas 节点永远停在 `handling` 状态，锁永远不释放
- 无 DLQ / alert，运维不知情
- 子问题：`redis.set(lastIdKey, ...)` 失败时内存 lastId 已更新但 Redis 没更新，崩溃重启后会重放同一损坏事件

**修复方案**：

- parse 失败时先把 raw 写入 DLQ 流（`${streamKey}:dlq`），然后再推进 lastId
- 增加告警 counter

**预估**：30 分钟

---

### BUG-060

**标题**：Checkout webhook 处理（CAS + addCredits + recordTransaction）未在同一事务内，扣费可能与审计记录错位

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/modules/payment.service.ts:85-104`
- **关联**：扩展自 Round 2 的 BUG-038（Credit transaction 隔离级别）

**当前代码**：

```typescript
export async function handleCheckoutCompleted(stripeSessionId, paymentIntentId?) {
  const payment = await paymentRepo.getPaymentByStripeSessionId(stripeSessionId);
  if (!payment) throw new NotFoundError(...);

  const updated = await paymentRepo.updatePaymentStatusCAS(
    payment.id, "pending", "completed", paymentIntentId,
  );
  if (!updated) {
    logger.info({ stripeSessionId }, "Webhook replay — already completed");
    return;
  }

  const newBalance = await userRepo.addCredits(payment.userId, payment.creditsGranted);

  await creditRepo.recordTransaction({
    userId: payment.userId,
    amount: payment.creditsGranted,
    txType: 'purchase',
    referenceId: payment.id,
  });
}
```

**问题**：

三个独立 DB 操作没有包在 `db.transaction()` 内。若 addCredits 成功但 recordTransaction 失败：
- 用户积分加上了，没流水记录 → 账目不符
- CAS 已置 completed → 再次 webhook 被当 replay，**不补记流水**

反向：CAS 成功但 addCredits 失败 → payment 状态已完成，用户没拿积分，无法自动恢复。

**修复方案**：

用 `db.transaction()` 包裹全部三步，repo 层接受 `tx` 参数版本，避免 bypass 事务。CAS 必须在事务内执行，利用其原子性作幂等锚点。

**预估**：45 分钟（含 repo 扩展 + 测试）

---

### BUG-061

**标题**：`addCredits` 未校验金额非负，可被错用减积分

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/modules/user.repo.ts:136-144`

**当前代码**：

```typescript
export async function addCredits(userId: string, amount: number): Promise<number> {
  const result = await db.execute(
    sql`UPDATE users SET credits = credits + ${amount}, updated_at = NOW()
        WHERE id = ${userId} AND deleted_at IS NULL
        RETURNING credits`,
  );
  return (result as any)[0]?.credits ?? 0;
}
```

**问题**：函数名暗示"加"，但传负数时变成"减"，且没有余额检查——余额可能被变负。

**修复方案**：

```typescript
if (!Number.isFinite(amount) || amount <= 0) {
  throw new ValidationError(`addCredits: amount must be positive finite, got ${amount}`);
}
```

**预估**：10 分钟

---

### BUG-062

**标题**：`deductCredits` 未校验金额，传 0 或负数时绕过余额检查甚至给用户加积分

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/modules/user.repo.ts:122-129`

**当前代码**：

```typescript
export async function deductCredits(userId: string, amount: number): Promise<boolean> {
  const result = await db.execute(
    sql`UPDATE users SET credits = credits - ${amount}, updated_at = NOW()
        WHERE id = ${userId} AND credits >= ${amount} AND deleted_at IS NULL
        RETURNING id`,
  );
  return (result as unknown[]).length > 0;
}
```

**问题**：

- `amount = -100` → `credits - (-100) = credits + 100`，用户**增加积分**
- WHERE 的 `credits >= ${amount}` → `credits >= -100` 对所有非负余额成立 → 更新成功 → 函数返回 true
- 调用方以为"扣费成功"，实际是加钱

**修复方案**：

```typescript
if (!Number.isFinite(amount) || amount <= 0) {
  throw new ValidationError(`deductCredits: amount must be positive finite, got ${amount}`);
}
```

**预估**：10 分钟

---

### BUG-063

**标题**：docker-compose.yml 中 `worker` 服务无 healthcheck，崩溃时 orchestration 不知

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`docker-compose.yml:85-97`

**当前代码**：

```yaml
worker:
  build: .
  command: ["node", "packages/worker/dist/index.js"]
  env_file: .env
  volumes:
    - ./logs:/app/logs
    - ./uploads:/app/uploads
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
  restart: unless-stopped
  # 无 healthcheck
```

API、collab、postgres、redis 都有 healthcheck，唯独 worker 没有。

**问题**：

- Worker 进入不响应状态（死锁、事件循环阻塞、AIGC provider 长挂起）→ docker compose / k8s 无法察觉
- `restart: unless-stopped` 只在**进程退出**时生效，挂起但不退出的进程不会被重启
- 任务在 BullMQ 队列持续堆积，用户感知为"任务永远 pending"

**修复方案**：

Worker 暴露一个轻量 `/health` HTTP 端点（内置 http 模块），healthcheck 逻辑检查 Redis 连接 + 最近 N 秒有任务活动。docker-compose 加 healthcheck 段调用该端点。

**预估**：15 分钟（docker-compose）+ 45 分钟（worker health 逻辑，属修复工作不在本分支做）

---

### BUG-064

**标题**：Checkout webhook 直接信任 DB 中 `payment.creditsGranted`，不重新从 Stripe 核对金额

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/modules/payment.service.ts:85-104`

**问题**：

`payment.creditsGranted` 是在用户发起购买时（createCheckoutSession）写入 DB 的。如果发起路径存在漏洞（IDOR / 参数篡改）让用户把 creditsGranted 写成了 1000000，而 Stripe 实际只收了 $10，Webhook 触发时用户得到 1000000 积分（应得 500 积分）。

**修复方案**：

webhook 处理时先 `stripe.checkout.sessions.retrieve(...)` 拿真实 amount_total，用 pricing 表反查应得 credits，然后**校验 DB 中的 creditsGranted 一致**。不一致 → log error + throw。之后再执行事务化的扣费流程（接 BUG-060）。

**预估**：30 分钟（含 pricing 表反查工具）

---

### BUG-065

**标题**：密码重置 token 无尝试次数限制，结合 BUG-030 可枚举爆破

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/modules/auth.service.ts:206-225`

**当前代码**：

```typescript
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const redis = getRedis();
  const key = `${env.ENV}:password-reset:${token}`;
  const userId = await redis.get(key);
  if (!userId) throw new UnauthorizedError("Invalid or expired reset token");
  // ... 更新密码 ...
  await redis.del(key);
}
```

**问题**：

Token 本身 64 字节 hex（256 bit 熵）不可枚举，但：
- 路由层的 IP 级 rate limit 可被 BUG-030 绕过
- 如果 token 有任何泄漏路径（日志、错误响应、referrer）被拿到，没有"猜测次数过多"的检测

**修复方案**：

引入 per-token 尝试计数（Redis `INCR` + `EXPIRE`），超过 5 次即失效该 reset token。

**预估**：20 分钟

---

## P2 — 新发现（本月修）

### BUG-066

**标题**：Worker 扣费失败后仅记 error log，无自动恢复或告警

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/worker/src/handlers.ts:221-231`

**当前代码**：

```typescript
if (wasFirst && creditsUsed > 0) {
  try {
    await creditService.deduct(/* ... */);
  } catch (err) {
    logger.error(
      { taskId, userId, creditsUsed, err },
      "DEDUCT_FAILED_AFTER_COMPLETION — manual reconciliation required",
    );
    // 仅 log，无后续动作
  }
}
```

**问题**：任务已完成（结果已交付用户），但扣费失败。当前只记录 log 让人"manually reconcile"，实际无人盯。

**修复方案**：

- 短期：写入 DLQ（Redis list `${env}:deduct-dlq`），后台任务扫描并重试/告警
- 长期：接 Sentry，5 分钟聚合阈值超过就 pager

**预估**：1 小时

---

### BUG-067

**标题**：Spawn 注入 memory context 无大小限制，长记忆翻倍每次 spawn 成本

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/agent/tools/spawn.ts:76-81`

**当前代码**：

```typescript
const reqCtx = tryGetContext();
if (reqCtx?.memoryContext) {
  const { userMemory, projectMemory, conversationMemory } = reqCtx.memoryContext;
  if (userMemory) system += `\n\n## User Preferences\n${userMemory}`;
  if (projectMemory) system += `\n\n## Project Context\n${projectMemory}`;
  if (conversationMemory) system += `\n\n## Conversation Summary\n${conversationMemory}`;
}
// 三层记忆大小没有任何上限
```

**问题**：活跃项目 / 深度用户的记忆可能几十 KB。每次 spawn 都完整注入，配合 BUG-050（spawn 无数量限制）→ 单次请求可能几美元。

**修复方案**：

每一层记忆截断到 `MAX_MEMORY_CHARS`（建议 4000，约 1000 tokens）。更精细做法：按重要性打分保留最近/最相关部分（不在本 bug 范围）。

**预估**：30 分钟

---

### BUG-068

**标题**：空 toolset 的 skill 被执行时静默完成，输出为模型幻觉

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/worker/src/handlers.ts:417-427`

**当前代码**：

```typescript
if (skillName) {
  const skill = registry.get(skillName);
  if (!skill) throw new Error(`Skill not found: ${skillName}`);
  skillContent = registry.loadSkillContent(skillName);
  toolNames = skill.tools;       // 可能是空数组
  resolved = [skillName];
}
// 后续 buildToolSet(toolNames=[]) 返回空 tool dict
// LLM 没工具可用，只能输出文本
```

**问题**：

Canvas scope 的 skill 如果 `tools: []`：
- LLM 没工具，"尽力而为"输出"我已经为你生成了图像"但**没有任何实际调用**
- 上层 worker handler 把文本当结果返回
- 用户看到"生成成功"但 canvas 节点上没内容

**修复方案**：

Skill 注册时校验 `canvas` scope 的 skill 必须至少声明一个 tool，否则跳过注册；或在 worker handler 执行前检查 `toolNames.length === 0` 抛错。

**预估**：15 分钟

---

### BUG-069

**标题**：Collab auth hook 创建的 postgres 连接池永不关闭，每次启动泄漏 5 连接

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/collab/src/auth.ts:76-131`

**当前代码**：

```typescript
export function createAuthHook({ redis, envPrefix, databaseUrl }: CreateAuthHookOptions) {
  const sql = postgres(databaseUrl, { max: 5 });   // ← 创建连接池
  return async ({ token, documentName }) => { /* ... */ };
  // 没有返回 close 方法
}
```

**问题**：

- 进程关闭（SIGTERM）时连接池不被主动关闭
- PG 侧连接等 TCP timeout 才释放
- K8s 滚动部署时瞬时双倍占用

**修复方案**：

`createAuthHook` 返回对象含 `close()` 方法（`sql.end()`），shutdown 钩子里调用。

**预估**：30 分钟

---

### BUG-070

**标题**：前端 Yjs `onSynced` 回调内注册的 undoManager 监听器可能导致内存泄漏

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/web/src/hooks/useYjsProjectStore.ts:73-91`

**当前代码**：

```typescript
const unsubSynced = mgr.onSynced(() => {
  const um = mgr.undoManager;
  const onStackChange = () => { setCanUndo(mgr.canUndo()); setCanRedo(mgr.canRedo()); };
  um.on('stack-item-added', onStackChange);
  um.on('stack-item-popped', onStackChange);

  undoCleanup = () => {
    um.off('stack-item-added', onStackChange);
    um.off('stack-item-popped', onStackChange);
  };
});
```

**问题**：

- `undoCleanup` 只在 `onSynced` 触发后才被赋值
- 组件在 sync 完成之前卸载 → useEffect cleanup 看到 `undoCleanup` 为 null → 无法清理
- 再挂载创建新 mgr，旧 mgr 的 undoManager 上仍挂着闭包引用（指向已卸载组件）
- React 18 警告 + 内存泄漏

**修复方案**：

把监听器注册移到 `useEffect` 主体（而非 `onSynced` 内），cleanup 直接 `um.off(...)`——即使 undoManager sync 前为空也无副作用。

**预估**：30 分钟

---

### BUG-071

**标题**：`yjsManager.destroy()` 未逐个销毁 subdoc 的 Y.Doc，仅 destroy provider

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/web/src/utils/yjsManager.ts:100-106`

**当前代码**：

```typescript
const destroy = () => {
  subdocProviders.forEach((p) => p.destroy());
  subdocProviders.clear();
  provider.off('synced', checkSynced);
  provider.destroy();
  doc.destroy();           // 销毁主 doc，但 subdoc Y.Doc 本身未 destroy
};
```

**问题**：

- 主 `doc.destroy()` 不会级联销毁 subdoc（Yjs 无此机制）
- 外部持有 subdoc Y.Doc 引用（已 unmount 的组件）→ subdoc 保留内存 + 监听器
- 长期 SPA 反复进出项目页 → subdoc 堆积

**修复方案**：

destroy 时遍历 `doc.getMap<Y.Doc>('subdocs')` 逐个 `subdoc.destroy()`。

**预估**：20 分钟

---

### BUG-072

**标题**：`creditTransactions.referenceId` 无索引，按 referenceId 反查全表扫描

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/db/schema.ts:283-301`

**当前代码**：

```typescript
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    // ...
    referenceId: varchar("reference_id", { length: 255 }),
    // ...
  },
  (table) => [index("credit_tx_user_id_idx").on(table.userId)],  // 只有 userId 索引
);
```

**问题**：

- 扣费幂等 / 退款 / 审计场景都按 referenceId（对应 payment.id / task.id）反查
- 全表扫描随用户增长 credit_transactions 上百万行
- 慢查询拖慢系统

**修复方案**：

新增 `index("credit_tx_reference_id_idx").on(table.referenceId)`，跟 migration。

**预估**：15 分钟

---

### BUG-073

**标题**：`creditTransactions` 表缺 `deletedAt`，违反项目软删 MANDATORY 规则

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/core/src/db/schema.ts:283-301`

**问题**：

CLAUDE.md 规定"所有数据库删除一律软删除，禁止硬删除"。但 `credit_transactions` 表没有 `deletedAt` 列——**金融审计数据**如果被误 DELETE 直接消失，合规风险极高。

**修复方案**：

schema 加 `deletedAt: timestamp("deleted_at", { withTimezone: true })` 列 + migration。配合 DB trigger 拦截 DELETE 可进一步强化。

**预估**：15 分钟

---

### BUG-074

**标题**：`docker-compose.yml` 硬编码 postgres 用户/密码 `breatic/breatic`

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM（dev 环境为主但反模式）
- **位置**：`docker-compose.yml:6-8`

**当前代码**：

```yaml
postgres:
  image: postgres:16-alpine
  environment:
    POSTGRES_USER: breatic
    POSTGRES_PASSWORD: breatic     # 硬编码
```

**修复方案**：

改为 `${POSTGRES_USER:?POSTGRES_USER required}` / `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}`，`.env.dev` / `.env.docker` 填默认值，生产 `.env` 覆盖。

**预估**：15 分钟

---

### BUG-075

**标题**：Worker 中 `const redis = getRedis()` 声明但未使用（Redis 拆库遗留代码）

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM（代码质量 + 误导后续维护）
- **位置**：`packages/worker/src/handlers.ts:84-85`

**当前代码**：

```typescript
const redis = getRedis();           // 取到了但后续没用
const streamRedis = getStreamRedis();
```

**问题**：

PR `cee8152 refactor: split Redis into 3 logical DBs` 把 Redis 拆成 3 个连接，Worker 实际只用 `streamRedis`，但忘删 `getRedis()` 调用。每次 job 处理都多建一次 Redis DB 0 连接，浪费资源。

**修复方案**：删除无用声明。

**预估**：10 分钟

---

### BUG-076

**标题**：Logout 路由重新 `slice(7)` 解析 token 而不是从 ctx 读

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/server/src/routes/auth.ts:179-180`

**当前代码**：

```typescript
// Middleware 已校验过 Bearer 开头（line 70）
// 但 route handler 又重新解析：
const authHeader = c.req.header("Authorization") ?? "";
const token = authHeader.slice(7);    // 假设开头是 "Bearer "
```

**问题**：

- 中间件和 route 之间若有其他 middleware 修改 Authorization，`slice(7)` 可能切错
- `authHeader` 意外为空时 `slice(7) = ""`，`authService.logout("")` 静默处理
- DRY 违反

**修复方案**：

middleware 解析后存 ctx（`c.set('token', token)`），route 读 `c.get('token')`。

**预估**：20 分钟

---

### BUG-077

**标题**：CORS 配置允许 `ALLOWED_ORIGINS=*`，搭配 credentials 违反 CLAUDE.md 禁止清单

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM（配置错误风险）
- **位置**：`packages/server/src/middleware/cors.ts:11-16`

**当前代码**：

```typescript
export const corsMiddleware = cors({
  origin: env.ALLOWED_ORIGINS.split(",").map(o => o.trim()),
  credentials: true,
  // ...
});
```

**问题**：

- `ALLOWED_ORIGINS=*` 结合 `credentials: true` 违反 CLAUDE.md 禁止清单
- Hono cors 中间件运行时拒绝，但非启动时——生产环境开始请求就报错

**修复方案**：

env 校验阶段 `refine` 拒绝包含 `*` 的值。

**预估**：15 分钟

---

### BUG-078

**标题**：Task listener 释放锁时 `redis.del` 失败未记录，节点可能永久锁定

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW
- **位置**：`packages/collab/src/task-listener.ts:136-155`

**当前代码**：

```typescript
if (event.type === "completed" || event.type === "failed") {
  const key = nodeLockKey(envPrefix, event.projectId, event.nodeId);
  const lockValue = await lockRedis.get(key);
  if (lockValue) {
    try {
      const lock = JSON.parse(lockValue) as { taskId?: string };
      if (lock.taskId === event.taskId) {
        await lockRedis.del(key);     // 失败无处理
      } else {
        logger.warn(...);
      }
    } catch {
      await lockRedis.del(key);       // 同上
    }
  }
}
```

**问题**：

- `lockRedis.del(key)` 因 Redis 抖动失败，异常被外层 async 吞掉
- 节点锁键仍在 → 2 小时 TTL 前用户看到"handling"状态无法再生成
- 无 log → 运维无从排查

**修复方案**：

wrap try-catch 日志化，不 rethrow（事件处理本身已完成）。

**预估**：10 分钟

---

## 尾注

### 审计覆盖率

本轮重点覆盖了 Round 2 没深入的模块。**未深入审计**的模块（下一轮可接续）：
- 前端 React 状态管理（Zustand store 的一致性 / 竞态）
- Stripe webhook 的 replay attack 防御（idempotency key 使用）
- BullMQ 的 stalled job 处理配置
- 日志 redaction（是否有字段泄密码、API key 到 log）
- Nginx 配置（Round 2 的 BUG-030 提到过 nginx `set_real_ip_from` 白名单，本轮未专项）

### 建议的修复派发（供其他 fix session 参考）

- **Day 1（P0 批次 1）**：BUG-047、048、052、053、057（代码改动小，可单 Claude 连续修）
- **Day 2（P0 批次 2 并行）**：BUG-046（前端 auth）、BUG-049（worker HTTP）、BUG-050（spawn 深度）—— 3 个独立 worktree
- **Day 3（剩余 P0）**：BUG-051（XSS）、BUG-034（docker 端口，Round 2）
- **本周 P1 批次**：BUG-054~065（约 12 个，按主题分 3 个 PR）
- **本月 P2**：剩下 16 个可并行处理

### 与 Round 2 的同步

Round 2 的 BUG-030~045 本次审计时仍全部活跃。**Round 3 结束时未合并 Round 2 清单**——请 fix session 同时打开 Round 2 的 [audit/2026-04-15-round-2-found.md](./2026-04-15-round-2-found.md) 参考。
