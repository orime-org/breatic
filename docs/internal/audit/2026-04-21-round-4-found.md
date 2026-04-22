# Audit Round 4 — 发现快照

**审计日期**:2026-04-21
**对应代码**:`origin/main` HEAD `3f29709`(包含 PR #110 ~ #125,4 天内 16 个 commit)
**审计方法**:从 `bugs_list` 分支派 4 个并行 sub-agent 分别核查支付/积分、Auth/WebSocket、前端重构、部署/CI/env 变更
**发现总数**:33 个新条目(2 P0 + 1 P1 HIGH + 14 P1 MED + 16 P2 LOW)
**核查的声称修复**:5 项(BUG-046 / 047 / 048 / 052 / 053)

> 本文件是历史快照,**定稿后不再修改**。Bug 的修复进度在 [`../BUGS.md`](../BUGS.md) 跟踪。

---

## 审计范围与方法

| Agent | 覆盖 PR | 发现数 |
|-------|--------|--------|
| A | #125 fix(credit+payment) Batch A(声称修 047/048/052/053)+ 相邻 038/060/061/062/064 | 5 |
| B | #113 fix(BUG-046) + #115 fix(auth hydration)+ 相邻 054/065/076 | 10 |
| C | #120 refactor(relative URLs)+ #111 + #114 + 相邻 040/041/070/071 | 8 |
| D | #112 canonical+strict env + #117 nginx + #121 GHCR + #118/122 action bumps + 相邻 063/074/077 | 10 |

---

## 修复核查表

| 声称修的 BUG | 实际状态 | 关键证据 |
|---|---|---|
| **BUG-046** WebSocket 'dev' token | ✅ 彻底修 | 前端 `yjsManager.ts:43,87` 两处替换为真实 token;`collab/auth.ts` 新增 authz 校验(projectId parse + `projects.user_id = session.userId` SQL 验证);前端 hardcoded `'dev'` 清零 |
| **BUG-047** refKey 校验 | ✅ 函数层面彻底修 | `credit.service.ts:42` `REFKEY_PATTERN = /^[A-Za-z0-9_:.-]{1,255}$/` + 入口 throw + 15 测试用例。**但见 BUG-079:该函数在生产无调用** |
| **BUG-048** userId 锁作用域 | ✅ 函数层面彻底修 | lockKey 已是 `${env}:bill:${userId}:${refKey}`。**但同 BUG-079,死函数的硬化无意义** |
| **BUG-052** nodeHistory FK restrict | ⚠️ 部分修 | nodeHistory 本身修了(migration 0008),但 commit msg 声称"所有其他 FK 都 explicit"不准确——两个兄弟 FK 未同步修,独立追踪为 BUG-080 |
| **BUG-053** Stripe env fail-fast | ✅ 彻底修 | `env.ts:168-186` PAYMENT_ENABLED=true 时校验 SECRET + WEBHOOK_SECRET `.trim()`,空或空白 → FATAL throw 阻止 boot;`stripe.ts:45` verifyWebhookSignature 也 `.trim()` 做纵深防御 |

**致命观察**:PR #125 强化的 `deductOnce` 在整个生产代码中**零调用点**。4 条真实扣费路径(worker/spawn/main-agent/text-tool)仍走非幂等 `deduct()`。 BUG-047/048 技术层面"修完",但真正的漏洞没关闭,见 **BUG-079**。

---

## Round 2/3 未附带修清单

本轮 PR 改动热点多次触碰 Round 2/3 已发现 bug 的文件,但未顺手处理:

| # | 原状态 | 触碰热点 PR | 说明 |
|---|--------|------------|------|
| BUG-038 | 🟠 P1 | #125 改 credit.service.ts | credit transaction 隔离级别仍默认 READ COMMITTED,Batch A 本该顺手 |
| BUG-060 | 🟠 P1 | #125 改 stripe.ts / credit.service.ts | Checkout webhook 的 addCredits + recordTransaction 仍无 transaction 包裹 |
| BUG-061 | 🟠 P1 | #125 改 credit.service.ts | `addCredits(userId, -100)` 仍能绕过余额检查 |
| BUG-062 | 🟠 P1 | #125 改 credit.service.ts | `deductCredits(userId, 0/-100)` 仍能变相加钱 |
| BUG-063 | 🟠 P1 | #121 改 docker-compose.yml | Worker healthcheck 仍缺 |
| BUG-064 | 🟠 P1 | #125 改 stripe.ts | webhook 不二次校验 creditsGranted 金额 |
| BUG-065 | 🟠 P1 | #115 改 auth 路径 | 密码重置 token 无尝试次数限制 |
| BUG-074 | 🟠 P2 | #121 改 docker-compose.yml | postgres 密码仍硬编码 `breatic:breatic` |
| BUG-076 | 🟠 P2 | #115 改 auth 路径 | logout 仍 `slice(7)` 重新 parse header |
| BUG-077 | 🟠 P2 | #112 改 env.ts / cors 周边 | CORS wildcard + credentials 启动校验仍缺 |

**主要原因**:PR 作者 batch 切得很细("只修 4 个 HIGH"、"只修 canonical+env"),虽然 code review 友好,但未发挥"顺手修相邻 bug"的 leverage。

---

## 新发现(按编号)

### P0 — 立即修

### BUG-079

**标题**：`deductOnce` 在生产代码中无调用点——BUG-047/048 修了一个"死函数"

- **状态**：`[ ]` 待修（真正的问题是 4 条扣费路径都不幂等）
- **严重度**：🔴 HIGH（双重扣费 / 重放扣费在所有 4 条非任务级路径理论上都可能发生）
- **位置**：`packages/core/src/modules/credit.service.ts:164`（定义）+ 4 个调用 `deduct()` 的位置

**当前代码**：

```bash
git grep -n 'deductOnce\(' 3f29709 -- 'packages/**'
# 唯一匹配：credit.service.ts:164（函数声明）
# 无任何生产调用者
```

真实扣费路径全走非幂等 `deduct()`：

```typescript
// worker/src/handlers.ts:214   — 任务级，靠 markCompletedAndBill CAS 幂等（OK）
await creditService.deduct(userId, creditsUsed, `Task: ${taskType}`, taskId, ...);

// core/src/agent/tools/spawn.ts:158   — SubAgent 扣费，无幂等保护
await creditService.deduct(reqCtx.userId, credits, `SubAgent:${agentName}`, reqCtx.conversationId, ...);

// server/src/agent/main-agent.ts:222   — Agent chat 扣费，无幂等保护
await creditService.deduct(userId, creditsUsed, "Agent chat", conversationId, ...);

// core/src/modules/text-tool.service.ts:196   — Text mini-tool 扣费，无幂等保护
await creditService.deduct(userId, credits, `Text tool: ${tool}`, undefined);
```

**问题**：

- CLAUDE.md 明确：`deductOnce() 保证同 refKey 只扣一次`；PRODUCT.md 重复该承诺
- 实际代码：`deductOnce` 只在单元测试和 mock 中出现；无任何 service / handler / route 调用
- 三条路径（spawn / main-agent / text-tool）**完全没幂等层**——stream 意外断开重连、SSE 客户端重试、BullMQ worker 语义上的 at-least-once、Hono handler 重入都会导致**重复扣费**
- 任务路径（worker/handlers.ts）靠 `tasks.billedAt` CAS 做幂等，实际可用；但这条**与 `deductOnce` 无关**

PR #125 实际做的是：**强化一个文档承诺但代码中没用的函数**。漏洞并没被关闭——真正的漏洞是 4 条扣费路径里 3 条不幂等；把 deductOnce 改得再好也不会自动替换 deduct() 的调用。

**修复方案**：

两种方向：

1. **把三条非任务路径改为 deductOnce**
   - Agent chat：refKey = `turn:${conversationId}:${turnIndex}`（conversation + turn 唯一）
   - SubAgent：refKey = `spawn:${conversationId}:${turnIndex}:${spawnIdx}`
   - Text mini-tool：refKey = `texttool:${sessionId}:${requestId}`（需前端生成 clientRequestId 或服务端 UUID per SSE stream）
2. **在各自处理器加 CAS 状态列**（类似 tasks.billedAt），对应 conversations、spawn_invocations、text_tool_sessions 表的 `billedAt`

方案 1 代价小，已有基础设施；方案 2 更 explicit。建议走方案 1，同时:
- 删掉 `deductOnce` 里 `const lockValue = userId` 改为 `"1"` 的占位（已是 `"1"` 了，OK）
- SSE 心跳/断线场景下前后端 refKey 生成需规范化

**验证**：

- `git grep 'creditService.deduct\b' packages/` 只剩受控 wrapper
- 单测：同 refKey 第二次 deductOnce → `deducted:false`；不同 user 同 refKey → 独立 SETNX，两边都扣
- E2E：Agent chat SSE 流中途断开重连，后端只记一次扣费

**预估**：1.5h（3 条路径迁移 + refKey 组装规约 + 回归测试）


---

### BUG-093

**标题**：`imageEditor/index.tsx` 的 yjs 订阅使用 `nodeId`（**非** projectId），collab authz 会按 `nodeId` 查 projects 表必然失败

- **状态**：`[ ]` 待修
- **严重度**：🔴 HIGH（功能阻塞——image editor 的协作会 100% authz 失败）
- **位置**：`packages/web/src/apps/project/components/imageEditor/index.tsx:833-843`

**当前代码**：

```typescript
const { yjsUndo, yjsRedo, yjsCanUndo, yjsCanRedo, yjsEnabled, yjsLoading } = useYjsStore({
  id: nodeId,                              // ← 传 nodeId
  token: editorToken,
  enabled: !!nodeId && !!editorToken,
  ...
});
```

**然后 `useYjsProjectStore` 传到 `createYjsProjectManager`**：

```typescript
const baseManager = createYjsManager({
  docId: `project-${workflowId}/canvas`,   // ← 拼成 "project-<nodeId>/canvas"
  ...
});
```

（`workflowId` 在 `createYjsProjectManager` 里是 `config.workflowId`，由 `useYjsStore` 传入 `id`，也就是 `nodeId`。）

**问题**：

- `imageEditor` 是 **node-level** 编辑器，应该连 `project-<projectId>/node/<nodeId>` 这种文档。
- 但当前代码把 `nodeId` 当成 `workflowId` 走 `project-<workflowId>/canvas` 路径，docName 会是 `project-<nodeId>/canvas`。
- 后端 `collab/auth.ts` 的 `parseProjectIdFromDocName` 用正则 `[0-9a-fA-F-]{36}` 提取 UUID——nodeId 也是 36 字符 UUID 所以**正则会通过**——然后 SQL 去 `projects` 表查 `id = ${nodeId} AND user_id = ${userId}`——**绝大多数情况查不到任何行**（除非某个用户的 projectId 恰好等于某个 nodeId 的 UUID，概率 0）。
- 于是：**图像编辑器的 Yjs 连接在 PR #113 启用 authz 后会 100% 被拒绝** → onAuthFailed 触发 → 用户被踢到 `/login`。
- 这不是 PR #113 引入的 bug，**是 PR #113 暴露出来的既存 bug**——之前 `token: 'dev'` 在 collab 的默认 dev 绕过下能通过，现在不行了。
- 我没有本地环境跑，但从代码路径看——`useYjsStore` 接受 `mode` 字段（在旧代码里），去掉 `mode: 'imageEditor'` 后，`useYjsStore` 再也不区分"项目画布"和"节点编辑器"两种模式，都按 `project-<id>/canvas` 构造。这**可能是 PR #113 diff 里顺手删了 mode 参数但没同步改 manager 行为** 的副作用。对照 diff：

```diff
-  mode: 'imageEditor',
-  enabled: !!nodeId,
+  token: editorToken,
+  enabled: !!nodeId && !!editorToken,
```

确实删了 `mode`。

**建议修复方案**：

- **紧急**：回到 `useYjsStore` 支持 `mode: 'canvas' | 'node'`，或改用一个独立的 `useNodeYjsStore` hook，内部 docName 拼成 `project-${workflowId}/node/${nodeId}`。
- 另传入 `workflowId` 参数（从 `useCanvasUI().workflowId` 或 props），而不是把 `nodeId` 当 `workflowId`。

**需要运行时验证**：我只通过静态代码读出来这个路径问题。如果 imageEditor 实际上**功能正常**，说明我误读了 hook 之间的参数传递，请交叉验证；否则这是 PR #113 带出的**功能性 regression**。

**预估**：1 小时（含重读 useYjsStore 和 imageEditor 架构以确认设计意图）

---

## 尾注

### 本轮覆盖的模块

1. `packages/web/src/utils/yjsManager.ts`
2. `packages/web/src/utils/yjsProjectManager.ts`
3. `packages/web/src/hooks/useYjsProjectStore.ts`
4. `packages/web/src/apps/project/index.tsx`
5. `packages/web/src/apps/project/components/imageEditor/index.tsx`
6. `packages/web/src/apps/workspace/index.tsx`
7. `packages/web/src/apps/auth/LoginPage.tsx`
8. `packages/web/src/apps/userCenter/index.tsx`
9. `packages/web/src/store/modules/userCenter.ts`
10. `packages/web/src/utils/token.ts`
11. `packages/web/src/utils/request.ts`
12. `packages/web/src/utils/sse.ts`
13. `packages/web/src/router/index.tsx`
14. `packages/collab/src/auth.ts`
15. `packages/server/src/middleware/auth.ts`
16. `packages/server/src/routes/auth.ts`
17. `packages/core/src/config/env.ts`

### 建议修复派发顺序

- **Day 1 紧急**：B-10（功能 regression）→ 运行时验证后优先级定调
- **Day 1 跟**：B-03 + B-05（auth 失败路径一致性）
- **Day 2**：B-01 + B-07（token 读取的两份真源 + malformed 处理）
- **Day 2**：B-02（跨 tab 同步）
- **Day 3**：B-04 + B-06 + B-08 + B-09（代码质量 + 相邻 auth）

### 与 BUGS.md 的集成

- BUG-046 的 `[ ] 待修` 状态应改为 `[x] 已修` + 追加到月度归档 `audit/2026-04-closed.md`
- BUG-053 的状态同上（Stripe env 交叉校验已落地）
- BUG-054 / 065 / 076 仍然活跃，本轮未修
- B-01 ~ B-10 如需纳入官方 backlog，按 Round 2/3 格式分派到 P0/P1/P2

---


## P1 HIGH — 本周修

### BUG-092

**标题**：NoAccount 模式在 collab 服务里只拒绝 `ENV=prod`，与 BUG-054 同源

- **状态**：`[ ]` 待修（本来就是 BUG-054 的另一入口，记录以便修复时一并处理）
- **严重度**：🔴 HIGH（承接 BUG-054）
- **位置**：`packages/collab/src/auth.ts:91-96`

**当前代码**：

```typescript
if (process.env.LOGIN_MODE === "NoAccount") {
  if (process.env.ENV === "prod") {
    throw new Error("NoAccount mode forbidden in production");
  }
  return { user: { id: DEV_USER_ID } };
}
```

**问题**：

BUG-054 指向 `server/src/middleware/auth.ts` 和 `core/src/config/env.ts`，**但 collab 服务里完全重复了这个错误的守卫逻辑**。修复 BUG-054 时若只改 API 服务，collab 依然允许 staging 环境 `LOGIN_MODE=NoAccount` 无 token 进入并返回 `DEV_USER_ID` → 协作层仍然形同虚设。

**建议**：在修 BUG-054 时把 `env.ENV === "dev"` 白名单检查下沉到 `core` 层公用工具（如 `assertDevOnly()`），API middleware / collab auth hook / env.ts 都调它，避免三份独立代码。

**预估**：5 分钟（附加在 BUG-054 修复上）


---


## P1 MED — 本周修

### BUG-080

**标题**：BUG-052 兄弟遗漏——`conversation_attachments.user_id` 与 `project_memory_entries.author_id` 两个 FK 仍无 onDelete 声明

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED（一致性 + GDPR 删号未来风险）
- **位置**：`packages/core/src/db/schema.ts:235` 与 `:410`

**当前代码**：

```typescript
// schema.ts:233-235  (conversation_attachments)
userId: uuid("user_id")
  .notNull()
  .references(() => users.id),

// schema.ts:408-410  (project_memory_entries)
authorId: uuid("author_id")
  .notNull()
  .references(() => users.id),
```

**问题**：

BUG-052 的核心论点是"所有其他 FK 都显式 onDelete=restrict，nodeHistory 这一条成了唯一例外"。核查发现**并非唯一例外**——同样两条遗漏存在：

- `conversation_attachments.user_id`：从初始 migration 0004 起就是 `ON DELETE no action`，migration 0007 大规模从 cascade → restrict 的转换**没包含它**，PR #125 的 migration 0008 也只修 nodeHistory
- `project_memory_entries.author_id`：从 0000 migration 起就是 `ON DELETE no action`，情况完全相同

验证：

```bash
# 0004_huge_frank_castle.sql:16
ALTER TABLE "conversation_attachments" ADD CONSTRAINT ... ON DELETE no action
# 0000_dear_hardball.sql:174
ALTER TABLE "project_memory_entries" ADD CONSTRAINT ... ON DELETE no action
# 0007 DROP 列表无此两条；0008 只碰 node_history
```

**影响**：

- PR #125 号称消除"一致性 noise"，但审计后噪音仍在 — 只少了 1 条（3 → 2）
- 未来做 GDPR 硬删用户时这两处可能变孤儿记录（和 BUG-052 原始论据一致）
- PR commit 说明"All other FKs in schema.ts declared onDelete explicitly"——**这句话在合并时就不成立**

**修复方案**：

schema.ts 加 `{ onDelete: "restrict" }` 到两条 FK；drizzle generate 产出 migration 0009 同时 DROP/ADD 这两个约束。

**验证**：

```sql
SELECT conname, confdeltype FROM pg_constraint
WHERE conrelid IN ('conversation_attachments'::regclass, 'project_memory_entries'::regclass)
  AND contype='f';
-- 期望 confdeltype='r' (restrict) 对 user_id/author_id
```

**预估**：15 min


---

### BUG-084

**标题**：NoAccount 模式下不再回写 localStorage，导致 Redux 与 localStorage 出现持久化不一致

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM（NoAccount 只在 dev，所以影响开发体验 + 模式切换，不算安全问题）
- **位置**：`packages/web/src/store/modules/userCenter.ts:42-67` + `packages/web/src/utils/request.ts:21-37` + `packages/web/src/utils/sse.ts:30-47`

**对照**：

```typescript
// OLD（Workspace useEffect 内）：NoAccount 同时更新 Redux + 显式写 localStorage
setAuthInfo(defaultAuthInfo);                   // reducer 自动 localStorage.setItem('auth', ...)
setToken({ ...defaultAuthInfo, version: 0 });   // 又显式写一遍

// NEW（loadInitialAuthInfo）：NoAccount 只返回 object，未写 localStorage
if (!authRequired) {
  return { state: { isAuthenticated: true, token: 'ThisIsATemporaryToken' } };
}
```

**问题**：

- `request.ts` L23-26 `const tokenStr = getToken(); ... const authInfo = JSON.parse(tokenStr as string); token = authInfo?.state?.token` —— 读的是 **localStorage 里的 `auth` 键**，而不是 Redux。
- NoAccount 模式下，localStorage 永远没有写入 → `getToken()` 返回 `null` → `JSON.parse(null as string)` 返回 JS `null`（不抛错，但值是 null）→ `authInfo?.state?.token` 变 `null` → axios 不带 `Authorization` header。
- 同样的 bug 在 `sse.ts` L31-34。
- 虽然 NoAccount 模式 server 也绕过 auth，**功能上不炸**，但这让前后端行为不对称。真正的问题是：**sse.ts / request.ts 的 token 源是 localStorage，yjsManager.ts 的 token 源是 Redux**——**两个真源**，容易以后出不同步问题。

次要风险：

- `request.ts` 和 `sse.ts` 的 `JSON.parse(tokenStr as string)` **没有 try-catch**。`tokenStr` 为 `null` 时不抛（`JSON.parse('null')` 返回 `null`），但若 localStorage 的 `auth` 键被外部工具或浏览器扩展改成非法 JSON（如 `"invalid{json"`），会直接在请求拦截器里抛 SyntaxError → 整个 axios 请求链崩。

**建议修复方案**：

- 让 `request.ts` / `sse.ts` 从 Redux store（`store.getState().userCenter.authInfo.state.token`）读 token，消除"两份真源"
- 或：让 `loadInitialAuthInfo` 在 NoAccount 分支同步调一次 `setToken(defaultAuthInfo)` 回写 localStorage，保持和旧行为一致
- 两处的 `JSON.parse` 包 try-catch，malformed 时走 `token = null` 分支

**验证**：

1. `VITE_LOGIN_MODE=NoAccount` 启动前端 → 清空 localStorage → 访问 `/project/<id>` → 打开 Network 看 `/api/v1/...` 请求是否带 `Authorization: Bearer ThisIsATemporaryToken`
2. 手动 `localStorage.setItem('auth', 'garbage')` → 刷新 → 任何 API 请求是否还能正常走（不应 SyntaxError）

**预估**：20 分钟


---

### BUG-085

**标题**：跨 Tab 的 storage event 未监听，Tab A logout 后 Tab B 仍以旧 session 在线

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM（UX + 安全）
- **位置**：`packages/web/src/store/modules/userCenter.ts`（缺少 `window.addEventListener('storage', ...)` 或等价订阅）

**问题**：

- `loadInitialAuthInfo()` 只在模块 import 时读一次 `localStorage.auth`。
- 用户在 Tab A 点退出 → `userCenter/index.tsx:163 removeToken()` 清 localStorage → `window.location.href = '/workspace'` 触发 Tab A 重载 → Tab A 重新 hydrate 成未登录态。
- **Tab B** 完全不知道 localStorage 被清——Redux 里还是旧 token，Yjs 还连着 collab，API 请求仍走 axios 从 localStorage 读（已空）但 Redux 里标 `isAuthenticated: true`。直到用户在 Tab B 触发一次 401 才掉线。
- 若攻击者短暂取得 Tab A 物理访问权限、快速登出被发现，攻击者仍有机会在另一个 Tab 继续操作。
- 此外，LoginPage 在 Tab A 登入→ Tab B 依然需要手动刷新。

**建议修复方案**：

`userCenter.ts` 在 slice 外加一次性监听：

```typescript
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'auth') return;
    if (e.newValue === null) {
      // 另一个 tab 清了 auth → 本 tab 也掉线
      store.dispatch(setAuthInfo({ state: { isAuthenticated: false, token: '' } }));
      window.location.href = '/login';
    } else {
      try {
        const parsed = JSON.parse(e.newValue) as AuthenticatedInfoType;
        if (parsed?.state?.token) {
          store.dispatch(setAuthInfo(parsed));
        }
      } catch { /* ignore */ }
    }
  });
}
```

（注：`storage` event 只在**其他 tab** 修改 localStorage 时触发，自己 tab 不触发——符合需求。）

**验证**：

1. 开两个 Tab 都指向 `/project/<id>`，登录态
2. 在 Tab A 点 logout
3. Tab B 应立即（1s 内）跳转到 `/login`，而不是等自己下一次 401

**预估**：30 分钟


---

### BUG-086

**标题**：`onAuthFailed` 只清 localStorage 不同步清 Redux，可能让 Redux 保留被拒绝的 stale token 导致重连循环

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/web/src/apps/project/index.tsx:58-64` + `packages/web/src/apps/project/components/imageEditor/index.tsx:837-842`

**当前代码**：

```typescript
onAuthFailed: useCallback((reason: string) => {
  console.warn('[yjs] Authentication failed:', reason);
  removeToken();                        // ← 只清 localStorage
  navigate('/login', { replace: true }); // ← SPA navigate，不重载页面
}, [navigate])
```

**问题**：

1. `removeToken()` 只 `localStorage.removeItem('auth')`。
2. `navigate('/login', { replace: true })` 是 React Router 的 SPA 跳转，**不会 reload**。
3. Redux store 没有 `dispatch(setAuthInfo({ state: { isAuthenticated: false, token: '' } }))`——**Redux 里还保留被 collab 服务器拒绝的 stale token**。
4. 如果用户在 `/login` 按浏览器"后退"或通过任何路径重新进 `/project/<id>` 而不 reload，`useYjsStore` 的 token 参数会再次是旧 token（`!!sessionToken === true`），又一次触发连接 → 再次被拒 → 又回 `/login`，进入人工触发的 ping-pong。
5. 虽然 `provider.disconnect()` 能停止**本次** HocuspocusProvider 的重连 loop，但**新建的 manager** 会重新连。

并且 `request.ts` 的 axios 401 handler 把用户跳 `/workspace`（L68），yjsManager 的 onAuthFailed 跳 `/login`——**两条路径对同一种 session 失效做出不同决策**，行为不一致。

**建议修复方案**：

两处 onAuthFailed 里增加 `dispatch(setAuthInfo({ state: { isAuthenticated: false, token: '' } }))`，同步清 Redux；或直接 `window.location.href = '/login'` 走全页重载（简单粗暴但对齐 request.ts 的风格）。统一 axios 401 与 Yjs 401 两条路径的落点（都到 `/login` 或都到 `/workspace`）。

**验证**：

1. 手动 `localStorage.setItem('auth', JSON.stringify({ state: { isAuthenticated: true, token: 'garbage' } }))` → 访问 `/project/<id>` → 观察：应该只跳一次 `/login`，不能循环

**预估**：15 分钟


---

### BUG-088

**标题**：subdoc provider 在 auth 失败时只 disconnect 自己，主 provider 与其他 subdoc 可能继续失败重连

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/web/src/utils/yjsManager.ts:119-128`

**当前代码**：

```typescript
subdocProviders.set(subdoc.guid, new HocuspocusProvider({
  url: wsUrl,
  name: subdoc.guid,
  document: subdoc,
  token,
  onAuthenticationFailed: ({ reason }) => {
    subdocProviders.get(subdoc.guid)?.disconnect();   // 只断自己
    onAuthFailed?.(reason);                            // 调用方会 removeToken + navigate
  },
}));
```

**问题**：

1. 主 provider 与 N 个 subdoc provider 共享同一个 `token`。若 token 失效，每个 provider 都会独立触发 `onAuthenticationFailed`。
2. 虽然 `onAuthFailed` 调用方会 `navigate('/login')`——但 SPA navigate 不卸载 manager 所属组件 **同步**。在 navigate 生效前，主 provider 会再次触发 `onAuthenticationFailed`（因为只有 subdoc 自己 disconnect 了）→ 再次调 `onAuthFailed`——**多次 navigate / removeToken 调用**，次数 = provider 数。
3. `removeToken()` 可重入无害，`navigate('/login', { replace: true })` 可重入无害，但 `console.warn` 会**重复输出 N+1 次**污染日志。
4. 更关键：若 `onAuthFailed` 调用方之后加入了其他状态变更（如 `dispatch(setAuthInfo({...unauth}))`）或分析埋点，会被重放 N+1 次。

**建议修复方案**：

在 auth 失败时统一断开 manager 所有 provider（主 + 所有 subdoc），并用一个 `onceAuthFailed` flag 保证外部 callback 只触发一次：

```typescript
let authFailedFired = false;
const handleAuthFail = (reason: string) => {
  provider.disconnect();
  subdocProviders.forEach((p) => p.disconnect());
  if (authFailedFired) return;
  authFailedFired = true;
  onAuthFailed?.(reason);
};
```

**预估**：20 分钟


---

### BUG-090

**标题**：`request.ts` / `sse.ts` 对 `JSON.parse(tokenStr)` 未包 try-catch，恶意/损坏 localStorage 会炸请求拦截器

- **状态**：`[ ]` 待修
- **严重度**：🟠 MEDIUM
- **位置**：`packages/web/src/utils/request.ts:25` + `packages/web/src/utils/sse.ts:33`

**当前代码**：

```typescript
// request.ts
const tokenStr = getToken();
let token: string | null = null;
const authInfo = JSON.parse(tokenStr as string);   // ← 无 try/catch
token = authInfo?.state?.token || null;
```

**问题**：

- `getToken()` 返回 `localStorage.getItem('auth')` —— 可能是 `null` 或**任何字符串**。
- `JSON.parse(null)` 不抛（coerce 到 `"null"` → 返回 `null`），但 `JSON.parse("garbage")` 会抛 SyntaxError。
- localStorage 里的 `auth` 键可以被浏览器扩展、粘贴的调试脚本、旧版本代码格式意外篡改。
- 崩溃后 axios 整个 interceptor 链炸——用户看不到任何 API 响应，前端处于"永远 loading"状态。
- PR #115 的 `loadInitialAuthInfo` 已经给这种破坏数据准备了 try-catch，但 request/sse 这两条并行读取路径**没有同样处理**。

**建议修复方案**：抽共用 `readAuthFromStorage(): { token: string | null }`，内部 try-catch，所有三处（loadInitialAuthInfo / request / sse）调用同一函数。

**预估**：15 分钟


---

### BUG-094 · Hocuspocus WS 无 sync / connection-lost UX → 用户看空白画布不知道

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED（UX 回归）
- **位置**：`packages/web/src/apps/project/components/canvas/index.tsx:904-907`（PR #114 删掉的 overlay），`packages/web/src/utils/yjsManager.ts`（无 `status` / `disconnect` 监听）
- **引入 PR**：#114
- **相关 PR**：#120（相对 URL 后,Collab 连接失败场景变多,例如用户在 prod 主域浏览但 nginx 未正确代理 `/ws`）

**问题**：

PR #114 移除了 `yjs.yjsLoading && <Loading overlay>`，理由是"Yjs sync 通常 <1s + 全局 Suspense 已有 loader"。但：

1. **Suspense 只在 lazy chunk 加载时触发**，一次加载完就不再显示。实际 Yjs WebSocket 连接 + 初始 state 同步发生在 chunk 已加载之后,Suspense 不盖这段。
2. **冷连接 / 大文档 / 慢网络 / auth 失败前**：用户看到**空画布**,与"真正空项目"无法区分。没有任何 spinner / banner / status。
3. **连接失败时静默**：`HocuspocusProvider` 自动重连,但无 `onStatus` / `onDisconnect` 回调挂载,`yjsLoading` 永远停在 `true`。UI 无反馈 → 用户以为应用挂了。
4. **Auth 失败时**：`onAuthFailed` 清 token + `navigate('/login')`,之前有 overlay 缓冲;现在空画布 → 突然跳登录,体验割裂。

**修复方案**：

两个办法二选一或并行：

- **补连接状态 hook**：监听 `provider.on('status', ...)` / `'disconnect'` / `'connect-error'`,暴露 `connectionState: 'connecting' | 'connected' | 'disconnected' | 'error'`;在 canvas 内用**小 banner**（不是全屏 overlay）显示。这兼顾"快速同步时不干扰"和"慢速/失败时给反馈"。
- **保留 overlay 但加 1~2 秒延迟**：`yjsLoading && syncDelayed && <overlay>`,避免 sub-second 闪烁,同时兜住慢速场景。

**验证**：
- 关闭 Collab 进程后刷新项目页 → 必须有明显失败提示,不能是永久空画布
- 登录后立即删除 session token → 必须有短暂 loading 后跳 login,不能是"空画布→跳 login"

**预估**：45 分钟


---

### BUG-095 · `packages/web/src/utils/websocket.ts` 整个文件是死代码（PR #120 未清理）

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED（混乱 + 未来误用风险）
- **位置**：`packages/web/src/utils/websocket.ts`（整个文件）
- **引入 PR**：#120

**问题**：

`packages/web/src/utils/websocket.ts` 导出 `initWebSocket` / `sendMsg` / `closeWebSocketConnection` / `websocketonmessage` 等函数,但在整个 `packages/web/src` 下**零 import**——已经没人用。真实的 WebSocket 连接全走 `yjsManager.ts` 的 `HocuspocusProvider`。

更重要的是:PR #120 修改了 `websocket.ts`（把 `VITE_API_URL` 换成 `window.location`),说明作者看到了这个文件但**没意识到它是死代码**。修改时还留下了:

- 残留逻辑 `import.meta.env.VITE_APP_WEBSOCKET`（唯一使用地）→ 这个环境变量在 `.env.dev` / `.env.docker` 也已不存在,于是默认 `undefined !== 'false'` → 代码分支永远 OK,但业务已不走这里
- 文档注释 `Opens a WebSocket using VITE_API_URL as host`（PR #120 已改）但函数签名还提及 `/api/ws/workflow` 这种历史路径

**为什么重要**：

- 新人读代码以为这是 WS 基础设施,浪费时间
- 下次有人想加"WS 广播通知"功能,可能误把逻辑写回这里,引入一套和 Hocuspocus 并行但配置割裂的代码
- 违反 CLAUDE.md 编码行为准则 §3「精准修改:删除**你的修改**导致无用的 import/变量/函数」—— PR #120 重写了这个文件,应当确认它是否还被使用
- 残留的 `VITE_APP_WEBSOCKET` env 字符串是"feature flag 墓碑"

**修复方案**：

删除 `packages/web/src/utils/websocket.ts`,同时删除 `VITE_APP_WEBSOCKET` 的残余引用（如有）。如果确实需要一个通用 WS 封装,之后再按需添加,不要留历史残片。

**验证**：
- `grep -r "from.*utils/websocket" packages/web/src/` 必须零结果
- `pnpm --filter @breatic/web build` 无错误
- `pnpm --filter @breatic/web typecheck` 无错误

**预估**：15 分钟


---

### BUG-096 · `/terms` / `/privacy` 在 InfoBadge 里点击后无路由 → 无限跳 workspace

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED（小 UX 坏点,但用户会 confused）
- **位置**：`packages/web/src/apps/userCenter/components/InfoBadge.tsx:99,102`
- **引入 PR**：#120（不是 PR #120 引入的 bug,但 PR #120 触发了语义变化）

**问题**：

PR #120 之前:
```tsx
const host = import.meta.env.VITE_API_URL;
window.open(`${host}/terms`, '_blank');  // -> https://api-host/terms (通常 404)
```

PR #120 之后:
```tsx
window.open('/terms', '_blank');  // -> https://www.domain.com/terms
```

当前 `packages/web/src/router/index.tsx` 没有 `/terms` / `/privacy` 路由,catch-all `path: '*'` 返回 `<Navigate to='/workspace' replace />`。

流程:
1. 用户在 Account menu 点击 "Terms of Use"
2. 新 tab 打开 `/terms`
3. SPA 加载 → router 匹配 `*` → Navigate to `/workspace`
4. 新 tab 回到 workspace。**用户以为自己点错了按钮**。

变化:
- **Before**: 404（API 域返回 404,用户可能以为是网络问题,但至少明确失败）
- **After**: 打开 workspace（隐式把菜单点击变成"打开 workspace"语义,令人困惑）

后端/nginx 也没有 `/terms` `/privacy` 的静态页,全 repo 零路由:

```
git grep "/terms\|/privacy" packages/web/src/router/ → 无
git grep "/terms\|/privacy" packages/server/         → 无
git grep "/terms\|/privacy" docker/                  → 无
```

**修复方案**：

三选一：

1. **推荐**：在 `router/index.tsx` 加两条路由指向外部静态页或 iframe `<TermsPage/>` `<PrivacyPage/>`,内容即使是 TBD 占位也好过 `<Navigate/>`
2. 改 InfoBadge 的按钮行为,点击时弹"即将上线"toast 或 disable 菜单项
3. 把 `window.open('/terms', '_blank')` 换成公司 marketing 域上的真实 URL（`https://www.breatic.ai/terms` 等）并配 `target="_blank" rel="noopener"`

**验证**：
- 用户点 Account menu 两个项目,**都不应该跳回 workspace**

**预估**：20 分钟（方案 3 最快）


---

### BUG-097 · 生产部署"CDN 托管 + API 同源"假设硬耦合,跨域场景失效

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED（部署灵活性降级）
- **位置**：`packages/web/src/utils/request.ts:12-14`、`packages/web/src/utils/yjsManager.ts:52-61`、`packages/web/src/utils/sse.ts:65`
- **引入 PR**：#120

**问题**：

PR #120 commit message 写:

> 单 bundle,any domain,zero rebuild —— 前后端**共享单 nginx 反向代理**为前提

问题是这个前提没有**运行时校验 / 文档明示**。具体场景:

- 客户想把 `web` bundle 部署到 Cloudflare Pages / Vercel / CDN,而 API 跑在另一个域 `api.example.com`
  - Before PR #120: 设置 `VITE_API_URL=https://api.example.com` + `VITE_WS_URL=wss://api.example.com/ws` 就够了
  - After PR #120: `request.ts` 硬 `/api/v1/...` 相对路径,必须跑 nginx 代理。**没有任何 escape hatch**
- 私有化部署但 API 在内网,web 用 CDN —— 不再可能

**为什么算 bug 而非设计**：

1. 之前架构**支持**这种部署,没沟通就砍掉了用户能力
2. 没有任何 README / DEPLOY.md 警告"relative URL 后不再支持 cross-origin 部署"
3. 已经被删的 `VITE_API_URL`/`VITE_WS_URL` 恰好是这种场景的配置入口
4. 回退成本不小:如果客户 6 个月后想拆,要把所有 `fetch` 和 `HocuspocusProvider` 都改回绝对 URL

**修复方案**：

推荐方案:**保留 relative 为默认,但提供可选的 `VITE_API_ORIGIN` / `VITE_WS_ORIGIN`**（非必填）。代码:

```typescript
// request.ts
const apiOrigin = import.meta.env.VITE_API_ORIGIN;  // 可选
const request = axios.create({
  baseURL: apiOrigin || '/',
  timeout: 180000,
});
```

```typescript
// yjsManager.ts resolveWsUrl
const wsOrigin = import.meta.env.VITE_WS_ORIGIN;
if (wsOrigin) return wsOrigin;  // 完整 URL（含 /ws 路径）
const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
return `${proto}//${window.location.host}/ws`;
```

这样:
- 默认行为 = PR #120 的行为（相对 URL,一包多域）
- 显式配置 = 回到跨域部署能力
- vite-env.d.ts 加两个可选 key,DEPLOY.md 补一段"跨域部署"章节

**验证**：
- 不设置任何 env → 构建后 bundle 无硬编码 host（和 PR #120 保持一致）
- 设置 `VITE_API_ORIGIN=https://api.example.com` → 构建后 bundle 用绝对 URL
- 设置 `VITE_WS_ORIGIN=wss://api.example.com/ws` → Hocuspocus 连接目标为该 URL

**预估**：1 小时（改代码 + 加文档）

---

## P2 — 本月修

---

### BUG-102

**标题**：Nginx canonical redirect + HTTP-only 模式不一致，无 SSL 时 apex 请求照样 200，PR #112/#117 的意图被 entrypoint.sh 绕过

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED
- **位置**：`docker/nginx.conf` + `docker/entrypoint.sh` + `docker/nginx-ssl.conf`

**根因**：

`entrypoint.sh` 只在 SSL 证书存在时才使用 `nginx-ssl.conf`（PR #112+#117 写的 canonical redirect 逻辑）。当证书不存在（或还没装）走的是 `nginx.conf`，整个文件只有一个 `server { listen 80; server_name _; include .../breatic-locations.conf; }`——**没有任何 apex→www redirect**。

这意味着：

1. 首次部署（证书还没到）用户跑 `docker compose up -d`，Nginx 跑的是 HTTP-only 模式，apex 和 www 都直接服务 SPA。localStorage 分裂到两个 origin（PR #112 commit message 里承诺要解决的问题）。
2. 如果有人长期不装证书（内网部署、PoC），这个不一致永久存在。
3. 当 SSL 证书"卡住"（证书文件意外被删/过期重签中）时，entrypoint 会降级到 HTTP-only 模式，canonical redirect 默默消失。

**影响**：

- PR #112 的 commit message 断言 "any user on thinkai.cc / www.thinkai.cc / http variants lands on https://www.thinkai.cc"，这是在 SSL 可用时才成立的。HTTP-only 模式下完全不成立。
- 对于"我只想在内网跑" / "开源用户不需要 SSL"的部署，apex/www 原生分裂问题没解决。
- HTTP→HTTPS 过渡期（证书应用生效前）有窗口期用户登录在 apex 上，升级为 HTTPS 后 localStorage 丢失。

**修复方案**（讨论）：

- 方案 1：HTTP-only `nginx.conf` 也加 `apex → www` 的 301 重定向（保持单一 origin 行为）。
- 方案 2：文档显式说明 HTTP-only 模式不执行 canonical（目前 nginx-ssl.conf 头部注释只提到 SSL 情形）。
- 方案 3：entrypoint 改为"如果部署域名被设置（`DEPLOY_DOMAIN` env），即便 HTTP 也做 canonical redirect"。

偏好方案 1——单 origin 是产品契约，不应该被证书存在性 toggle。


---

### BUG-103

**标题**：Nginx `$host` 在 canonical redirect 里可被 `Host` header 欺骗（open redirect / phishing 向量）

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED
- **位置**：`docker/nginx-ssl.conf:27,46`

**根因**：

PR #112 + #117 的 canonical redirect 一直用 `$host`：

```nginx
return 301 https://www.$host$request_uri;   # line 27 (HTTP default) + line 46 (HTTPS default)
```

`$host` 的值来自客户端 `Host` 头。由于这两个 block 是 `default_server` / `server_name _`，任何 Host（包括恶意构造）都会命中。例如攻击者向 `http://<server-IP>/path` 发请求带 `Host: evil.com`，Nginx 回 `301 Location: https://www.evil.com/path`。

对整站的 301 重定向，其结果：

1. 如果用户跟随 301（浏览器会），他就被引导到 `www.evil.com`——开放重定向（open redirect）。
2. 搜索引擎 / 爬虫按 301 更新索引，把 `server-IP` 的所有路径映射到 `www.evil.com`——SEO 毒化。
3. 邮件等外部链接通过 `Host` 欺骗可以改写重定向目标。

**正确做法**：在 `default_server` / `server_name _` block 里应该：

- 对未知 Host 返回 404 / 444（drop）而不是 301 到 `www.<whatever-was-submitted>`；
- 只对**已知**的 apex 主机名做 `301 https://www.{known-apex}`。

这通常用显式 server_name 列表或环境变量注入：

```nginx
# bad (current)
server {
    listen 443 ssl default_server;
    return 301 https://www.$host$request_uri;
}

# good
server {
    listen 443 ssl default_server;
    return 444;   # reset, no Location header
}
server {
    listen 443 ssl;
    server_name thinkai.cc breatic.ai;   # 已知 apex
    return 301 https://www.$host$request_uri;
}
```

但 PR #112 的设计目标是 "same Docker image works for any deployment domain"（commit msg）——在这个框架下要做对需要运行时注入 `DEPLOY_DOMAIN`（比如 entrypoint.sh 渲染模板）。

**影响**：

- Open redirect 是 bug 悬赏项目的标配入口（P1 至少）。
- HSTS preload + HTTPS 不能阻止 301 到任意域名。

**修复方案**（讨论）：entrypoint.sh 从 env 读取 `DEPLOY_DOMAIN`，把 nginx-ssl.conf 里的 `$host` 替换成 env 值；未设 `DEPLOY_DOMAIN` 时对未知 Host 返回 444。这是 PR #112 "generic regex，同一镜像多域名"意图的正确实现。


---

### BUG-104

**标题**：Nginx SSL 证书指纹对 apex 和 www 的覆盖假设未校验，证书只含 www 时 apex redirect 本身发 SSL 握手失败

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED
- **位置**：`docker/nginx-ssl.conf`（整文件）+ PR #112/#117 commit msg

**根因**：

PR #112 commit msg 声明 "SSL cert must cover both www and apex (or be a wildcard)" ——这是用户必须自己配置的先决条件，但代码里无任何校验。两个 HTTPS server block 都 `ssl_certificate /etc/nginx/certs/cert.pem;`——如果 cert 只有 `www.thinkai.cc` 的 SAN 没有 `thinkai.cc`，那么 apex 的 443 握手在 SNI / 证书链对端到到达 "server_name=_" block 之前就失败了（或 chrome/firefox 弹 `NET::ERR_CERT_COMMON_NAME_INVALID`）。

后果：

1. 首次访问 `https://thinkai.cc` 直接报证书错误，用户**永远看不到** 301 redirect。
2. 这意味着即使 PR #117 默认 default_server 正确了，没有合适证书时 apex HTTPS 访问还是坏的，canonical 退化成"看运气的最终一致"。

**影响**：

- 如果证书只覆盖 www（常见——cert-bot 默认只签当前域），apex HTTPS 访问体验是白屏+证书警告，不是用户期望的 "自动跳转到 www"。
- 这是 deploy checklist 的静默失败（"我装了证书就能用了"——错，必须装 SAN 覆盖 apex+www 的证书）。

**修复方案**（讨论）：

- 方案 A：entrypoint.sh 启动时用 openssl 读取证书 SAN，如果不包含 apex，log WARN 或拒绝启动。
- 方案 B：docs/DEPLOY.md 在 certbot 步骤显式要求 `-d your-domain.com -d www.your-domain.com`。当前 DEPLOY.md 未明确这一点。
- 方案 C：如果用户只有 www 证书，建议把 apex 的 port 443 block 去掉——让 Chrome 的 HSTS / DNS-level redirect 处理。

**强关联 bug**：docs/DEPLOY.md 的 HTTPS 章节应验证是否清晰指导用户申请 SAN 证书。


---

### BUG-105

**标题**：GHCR 镜像拉取默认 `:latest`（= main），使用户/部署者卷入任何 main 推送的 breakage，无 pin policy、无健康回滚

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED
- **位置**：`docker-compose.yml`（所有服务 `${BREATIC_TAG:-latest}`）+ `.env.docker:28`（BREATIC_TAG 注释说"Leave unset to follow `:latest`"）+ `docs/DEPLOY.md` BREATIC_TAG 表格

**根因**：

PR #121 `metadata-action` 规则：

```yaml
type=raw,value=latest,enable={{is_default_branch}}
```

每次 main push 都会更新 `:latest`。`docker-compose.yml` 每个服务都 `${BREATIC_TAG:-latest}`，.env.docker 默认注释 `BREATIC_TAG=`（unset）——于是**任何开源用户的默认部署**就是"每次 `docker compose pull && up -d` 拉最新 main"。

- 没有 release cadence、没有 RC 测试（commit msg 直接承认："Kept :latest tracking main for now — we have no release cadence yet"）。
- Docker-compose.yml 里没有健康检查（BUG-063 未修），`--force-recreate` 后服务一旦无法启动就是生产停机；没有自动回滚或蓝绿部署机制。
- DEPLOY.md 只提"`docker compose pull` + `up -d --force-recreate`"——没说"先在 staging tag 上验证再升级到 latest"。
- 对于把 `ENV=prod` 的生产部署，这是 supply chain 风险：main 任何一次意外破坏（本 audit 找到的 12 个 P0 bug 里任何一个进 main 都会被拉到生产）。

**影响**：

- 没有任何"rolling canary"——所有 `:latest` 订阅者同时升级。
- 没有镜像内容 pinning（digest），`:latest` 拉到的是 manifest 的 floating reference，镜像在 registry 被覆盖后旧 digest 就不可重入。
- 配合 BUG-074（postgres 密码硬编码）+ BUG-077（CORS 校验缺），这些 bug 推到 main 就直接进任何开源部署。

**修复方案**（讨论）：

- 方案 A（最小）：README + DEPLOY.md 把默认从"unset（= latest）"改为"推荐 pin 到 `v<version>` tag"。`:latest` 仅给仓库开发者/CI 自己用。
- 方案 B：只在 `v*` tag 推 `:latest`（把 `enable={{is_default_branch}}` 换成 `enable=${{github.ref_type == 'tag'}}`）。commit msg 里作者也已经意识到这一点："Will tighten to 'latest only on release' when v1 ships"。
- 方案 C：每次部署用 digest 而非 tag（`image: ghcr.io/.../breatic@sha256:...`）。

当前状态：作者自认"懒"，但这是实打实的开源用户信任风险——他们以为 `:latest` = stable（GitHub Action 官方范式就是这样），结果是 rolling main。


---

### BUG-107

**标题**：GHCR 镜像默认 private，DEPLOY.md 要求手动改成 public，但 CI pipeline 本身没校验——首次发版后开源用户默认拉不下来

- **状态**：`[ ]` 待修
- **严重度**：🟠 MED

- **位置**：`docs/DEPLOY.md`（"GHCR package visibility (one-time setup)"）

**根因**：

PR #121 commit msg + DEPLOY.md 承认："The first time CI publishes images, the packages are private by default"。提供手动步骤"Go to https://github.com/orgs/orime-org/packages → Click the `breatic` package → Package settings → 'Change visibility' → Public"。

问题：

1. 没人 audit 这个状态。第一次 CI 推完，包在 GHCR 上 private，但 README + DEPLOY.md 的 Quick Start 写"`docker compose pull`"对开源用户**不报错信息准确的失败**（会拉 `unauthorized`）。
2. 只能祈祷管理员记得登进去改设置。
3. `BREATIC_TAG=test_thinkai_cc` 这个分支在 `metadata-action` 里会生成 tag，如果管理员只改了 `:latest` 的可见性但没改具体分支 tag 的可见性（GHCR 的 visibility 是包级别的，tag 继承包级）……实际上是包级别 visibility 覆盖所有 tag，但这细节 DEPLOY.md 没说清。

**影响**：

- DEPLOY.md Quick Start 对刚 clone 仓库的用户"走不通"直到管理员手动改设置。
- CI 不能自动检查 package visibility（GitHub API 有 endpoint 但没集成）。

**修复方案**（讨论）：

- 方案 A：在 CI 里加一个 post-publish step，调 GitHub API 验证 package visibility = public（如果 secrets 注入 token 有权限）。
- 方案 B：在 README Quick Start 的 `docker compose pull` 步骤前加"`docker login ghcr.io` 失败也可能是包未公开"的 troubleshooting 提示。
- 方案 C：使用 GHCR 之外的 registry（Docker Hub / Quay）——public-by-default 对开源更友好。

**优先级**：MED——阻碍开源用户上手。


---


## P2 — 本月修

### BUG-081

**标题**：Stripe secret 在部分分支里**先被使用**才 fail-fast（微观一致性）

- **状态**：`[ ]` 待修（低优）
- **严重度**：🟡 LOW
- **位置**：`packages/core/src/infra/stripe.ts:23-28`

**当前代码**：

```typescript
export function getStripeClient(): Stripe {
  if (!_client) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.");
    }
    _client = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _client;
}
```

**问题**：

- env.ts 已在 boot 时就会 fail-fast 拒绝启动（PR #125 新增）。**但** `PAYMENT_ENABLED=false` 时允许 STRIPE_SECRET_KEY 为空启动
- `getStripeClient()` 运行时 `if (!env.STRIPE_SECRET_KEY)` 校验只看 truthy，**不 trim**——与 verifyWebhookSignature 的 `.trim()` 纵深防御不一致
- 若 `PAYMENT_ENABLED=false` + `STRIPE_SECRET_KEY="   "`（空白），boot 不 fail，但 getStripeClient 时会通过（`"   "` truthy）→ `new Stripe("   ")` 可能 lazy fail
- 非关键但与 PR 说明中"defense in depth"保持口径一致，两处应同样 .trim()

**修复方案**：

```typescript
if (!env.STRIPE_SECRET_KEY.trim()) {
  throw new Error(...);
}
_client = new Stripe(env.STRIPE_SECRET_KEY.trim());
```

**预估**：5 min


---

### BUG-082

**标题**：migration 0008 非幂等 DROP 缺 `IF EXISTS`——重跑场景脆性

- **状态**：`[ ]` 待修（低优 / 运维风险）
- **严重度**：🟡 LOW
- **位置**：`packages/core/src/db/migrations/0008_mean_jubilee.sql:1`

**当前代码**：

```sql
ALTER TABLE "node_history" DROP CONSTRAINT "node_history_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT ... ON DELETE restrict ...;
```

**问题**：

- 这是 Drizzle 默认输出，标准做法是靠 `_journal.json` 记已应用 migration 避免重放。正常 deploy 不会出问题
- 但如果运维在 dev DB 上手动 `ALTER CONSTRAINT` 过（常见场景：测试 restrict 行为），约束名可能与 Drizzle 生成的不一致，DROP 会直接抛 error；没有 `IF EXISTS` 辅助缓冲
- 对比 migration 0006 就加了 `IF NOT EXISTS` 给 `yjs_documents`（见最近 commit `e7407d3`），说明项目里已有这个语义的意识——0008 新写的却没跟进

**修复方案**：

```sql
ALTER TABLE "node_history" DROP CONSTRAINT IF EXISTS "node_history_user_id_users_id_fk";
```

（仅改 0008 本身，不影响新 DB）

**预估**：2 min


---

### BUG-083

**标题**：`creditTransactions.referenceId` 可为任意 255 字符串——与 `deductOnce` 的 REFKEY_PATTERN 不一致

- **状态**：`[ ]` 待修（数据一致性）
- **严重度**：🟡 LOW
- **位置**：`packages/core/src/db/schema.ts:297`

**当前代码**：

```typescript
referenceId: varchar("reference_id", { length: 255 }),
```

**问题**：

- `deduct()` 把 `refKey` 原样存到 `creditTransactions.referenceId`（见 `credit.service.ts:72`）
- `deductOnce` 新增的 REFKEY_PATTERN 限制入口为 `^[A-Za-z0-9_:.-]{1,255}$`
- 但 `deduct()` 直接调用时 referenceId 无此限制——可存入 `任意\n字符`、null byte、`未\x00过滤` 值
- 审计查询、日志分析、dashboard 可能因 referenceId 里含 emoji/控制字符而出错
- 这是 A-02 的副作用：如果 A-02 的修复把所有路径迁移到 deductOnce，这个不一致就消失；在此之前任一 deduct 直接调用都可以破坏 referenceId 的"pattern 承诺"

**修复方案**：

在 `deduct()` 入口也校验 referenceId 如果非空则符合 pattern；或把 referenceId 做成 reference 表（FK），从源头约束格式。

**预估**：15 min（短期只加校验）

---

## 审计统计

- 声称修 4 项：2 彻底（BUG-047, BUG-048 在函数层面）/ 1 部分（BUG-052 遗漏 2 FK）/ 1 彻底（BUG-053）
- 但 BUG-047/048 的"彻底修"建立在 `deductOnce` 被实际使用的前提——**前提不成立**（A-02）
- 新发现 9 条：1 HIGH + 5 MED + 3 LOW
- 附带未修：BUG-038 / BUG-060 / BUG-061 / BUG-062 / BUG-064 全部未修，攻击面未缩小

## 总体风险判断

PR #125 **形式正确、方向正确、实质不完整**：

1. REFKEY_PATTERN 和 env guard 是好的基础工作——保留
2. 但不关闭任何实际生产漏洞：
   - `deductOnce` 无人调用（A-02，最严重）
   - FK 一致性修了 1/3（A-01）
   - 同家族 credit repo 入口（A-04）、webhook 事务（A-03）、webhook amount check（A-06）同一 PR 本该一起处理未处理
3. Batch 化是好做法但切分太细——"支付/积分加固"下只做 4 条中的微观修复，让更严重的 A-02 / A-04 类问题继续暴露

建议下一个 Batch：A-02 为 P0（因为号称文档已承诺的幂等性事实上不存在）+ A-01/A-03/A-04 一起打包。

---

### BUG-087

**标题**：`useYjsStore` 的 `onAuthFailed` deps 被 `eslint-disable` 掩盖，若调用方传递非稳定回调会导致 stale closure

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW（目前两个调用方都 `useCallback` + 稳定依赖，但是潜在陷阱）
- **位置**：`packages/web/src/hooks/useYjsProjectStore.ts:131-134`

**当前代码**：

```typescript
return () => { ... };
// onAuthFailed intentionally omitted from deps — it should be stable.
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [id, token, wsUrl, enabled]);
```

**问题**：

- 注释写着 "should be stable"——依赖调用方保持稳定。两个当前调用方（`apps/project/index.tsx` 和 `imageEditor/index.tsx`）都用了 `useCallback`，**目前 OK**。
- 但是这个合同是口头的、没机械保证。未来如有人（人或 LLM）改写调用方、去掉 `useCallback`，`onAuthFailed` 每次 render 都是新函数——但 effect 不会因此重建 → 旧 manager 持有**初始 closure**的 `onAuthFailed`，之后 navigate / authInfo 更新不会反映到 manager 的 auth failure 路径里。
- 更微妙：`useCallback(...,[navigate])`——`navigate` 本身是 react-router-dom 的 hook，**几乎**每次 render 都是同一个引用，但社区有过 edge case（某些版本 StrictMode 下 recreate）。
- 推荐通用做法：用 `useRef` 在 effect 内读最新的 `onAuthFailed`，避免把它进 deps：

```typescript
const onAuthFailedRef = useRef(onAuthFailed);
useEffect(() => { onAuthFailedRef.current = onAuthFailed; }, [onAuthFailed]);

// 传给 manager 时包一层稳定函数
const mgr = createYjsProjectManager({
  workflowId: id,
  token,
  wsUrl,
  onAuthFailed: (reason) => onAuthFailedRef.current?.(reason),
});
```

**预估**：15 分钟


---

### BUG-089

**标题**：`loadInitialAuthInfo` 静默返回未登录态，若 localStorage 被禁（Safari ITP / 隐私模式）无任何告警

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW
- **位置**：`packages/web/src/store/modules/userCenter.ts:52-61`

**当前代码**：

```typescript
try {
  const raw = localStorage.getItem('auth');
  if (raw) {
    const parsed = JSON.parse(raw) as AuthenticatedInfoType;
    if (parsed?.state?.token) return parsed;
  }
} catch {
  // Malformed localStorage — fall through to unauthenticated default.
}
return { state: { isAuthenticated: false, token: '' } };
```

**问题**：

- catch 吞掉所有错误：localStorage 关闭（Safari ITP）、storage quota exceeded、浏览器策略禁用……全部静默回落到未登录。
- 用户登入后刷新，如果所在浏览器不支持 localStorage，界面会"登录了但还像没登录"——用户困惑，客服也查不出来。

**建议修复方案**：

catch 里至少 `console.warn('[auth] failed to load session from localStorage:', err)`，方便线上排查。或触发一个埋点事件。

**预估**：5 分钟


---

### BUG-091

**标题**：collab `onAuthenticate` 钩子里 project-not-found 和 wrong-owner 返回同一错误消息，可被枚举

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW
- **位置**：`packages/collab/src/auth.ts:114-126`

**当前代码**：

```typescript
const rows = await sql<{ id: string }[]>`
  SELECT id FROM projects
  WHERE id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  LIMIT 1
`;
if (rows.length === 0) {
  throw new Error(
    `User ${userId} is not authorized to access project ${projectId}`,
  );
}
```

**问题**：

- 错误消息里**同时泄漏 `userId` 和 `projectId`**。Hocuspocus 把 auth hook 抛出的 error message 发回客户端（HocuspocusProvider 的 `onAuthenticationFailed({ reason })` 的 `reason` 就是这个字符串）。
- 攻击者可以：
  - 枚举任意 `project-<uuid>/canvas` 看返回 `"User <uuid1> is not authorized"`（projectId 存在但非本人）vs `"User <uuid1> is not authorized"`（projectId 压根不存在）——消息相同 ✓
  - 但 userId 泄漏——允许攻击者把自己的 session 对应的 userId 泄出（理论上本来就是用户自己）

实际**安全影响很小**——用户的 userId 通过自己 session 能拿到，projectId 若存在也不一定是秘密。但把 userId/projectId 写进 error message 是**反模式**——Round 3 的 BUG-043 里就提过"错误日志泄露 stack trace"。

**建议修复方案**：

```typescript
throw new Error("Unauthorized: invalid project or access denied");
// 日志用 logger.warn 记录具体 userId/projectId 供审计
```

**预估**：10 分钟


---

### BUG-098 · `vite-env.d.ts` 只声明 `VITE_LOGIN_MODE`,其他 5+ 个 VITE_ 变量无类型

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW（类型卫生）
- **位置**：`packages/web/src/vite-env.d.ts:3-5`
- **引入 PR**：#120

**问题**：

PR #120 把 `vite-env.d.ts` 精简成:
```typescript
interface ImportMetaEnv {
  readonly VITE_LOGIN_MODE?: string
}
```

但代码实际使用的 VITE_ 变量:
- `VITE_SENTRY_DSN` — `packages/web/src/index.tsx:16`
- `VITE_APP_VERSION` — `index.tsx:19`,vite 插件注入 release
- `VITE_APP_WEBSOCKET` — `utils/websocket.ts:32`（虽然文件是死代码）
- `VITE_SENTRY_AUTH_TOKEN` — `vite.config.ts:16`

都依赖 `/// <reference types="vite/client" />` 的默认 `ImportMetaEnv` 类型——任何 `VITE_*` 被当作 `string | undefined`。运行正确,但:

- IDE 不再提示有效 env 变量列表
- Typo（`VITE_APP_VERSON`）不会报错
- 删除 env 变量时,TypeScript 无法帮忙捕获使用点

**修复方案**：

在 `vite-env.d.ts` 列全:

```typescript
interface ImportMetaEnv {
  readonly VITE_LOGIN_MODE?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_AUTH_TOKEN?: string;
  // VITE_APP_WEBSOCKET 删除（死代码清理后）
}
```

**预估**：5 分钟


---

### BUG-099 · API 直通端口 3000/1234 暴露到宿主机,绕过 nginx canonical redirect

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW（安全/行为一致性)
- **位置**：`docker-compose.yml:80`（api ports）、`docker-compose.yml:92`（collab ports）
- **引入 PR**：无,但 PR #120 放大影响

**问题**：

`docker-compose.yml`:
```yaml
api:
  ports:
    - "3000:3000"
collab:
  ports:
    - "1234:1234"
```

PR #120 重构后,前端在同域下请求 `/api/v1/...` 和 `/ws`,正常流量都走 nginx。但宿主机 `3000`/`1234` 仍公网可达（除非防火墙挡）→ 攻击者直接:

- `curl http://your-domain:3000/api/v1/auth/login` 绕过 nginx canonical redirect（apex→www）
- `wscat ws://your-domain:1234/ws/...` 直连 Collab,绕过 nginx 的 `proxy_read_timeout` / Host 头改写
- 绕过 nginx 层的 rate-limit（虽然 app 层有）/ IP 白名单（如果将来加）

**本 bug 已被 BUG-034 "不修"覆盖**（防火墙/cloud-level 处理）。但 PR #120 的宣传是"单入口 nginx + 相对 URL"——语义和端口直通**不一致**。至少加注释说明"这两个 ports 项仅 dev 调试用,prod 必须通过 firewall 去掉"。

**修复方案**：

在 `docker-compose.yml` 标注或改用 `expose:`（容器内可见,宿主不映射）。prod 环境应由 env override 或单独 compose override 文件移除 ports。

**预估**：15 分钟（文档 + compose 注释）


---

### BUG-100 · `.env.docker` ALLOWED_ORIGINS=http://localhost 在生产无意义 + 相对 URL 后用途模糊

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW（文档 / 默认值)
- **位置**：`.env.docker`（ALLOWED_ORIGINS 段）
- **引入 PR**：#120

**问题**：

`.env.docker` 默认 `ALLOWED_ORIGINS=http://localhost`,但:

- PR #120 后,**同源请求不触发 CORS**,该变量在 nginx 部署下基本无效
- `http://localhost` 只匹配用户浏览器地址栏直接写 `localhost` 的情况——production 主域访问时,**browser 不发 Origin header,所以 Hono cors middleware 允许**
- 文档已经说了"Docker 部署不需要 CORS（nginx 同源）"但默认值留 `http://localhost` 让人疑惑

实际生产默认值应该是**空字符串或删除**（@t3-oss/env-core 遇空字符串和 `cors(...)` 配合时能否工作要验证）。

**修复方案**：

- 方案 A: 默认留空/删掉,env.ts 里允许空值,cors 遇空时不注册/拒绝所有跨域
- 方案 B: 保持现状但在 `.env.docker` 里加大注释"Docker 同源部署通常无需设置,只有直接调用 API 子域时才用"

**注**：这不是 PR #120 引入的 bug,但 PR #120 让这个配置**更加无意义**,触发了审计发现。

**预估**：15 分钟


---

### BUG-101 · PR #120 遗漏:`bugs_list` 分支 stale,开发人员审核时看到的是 pre-refactor 代码

- **状态**：`[ ]` 待修（流程性)
- **严重度**：🟡 LOW（流程审计）
- **位置**：本审计分支 `bugs_list` 本身
- **引入 PR**：无单一 PR,流程问题

**问题**：

本分支 `bugs_list` 落后 `origin/main` 16 个 commit（PR #110~#125）。今天的审计人员（包括本 session 初始行动）先看到的是 `bugs_list` 的工作树 —— 里面:

- `packages/web/src/utils/request.ts` 仍包含 `baseURL: import.meta.env.VITE_API_URL || '/'`（PR #120 前）
- `packages/web/src/utils/yjsManager.ts` 的 `token: 'dev'` 硬编码（PR #113 前）
- `packages/web/src/utils/websocket.ts` 的 `VITE_API_URL` 引用（PR #120 前）

如果审计人员**用 `Grep` 工具扫工作树**而不是 `git grep origin/main`,会得到"PR #120 未真正移除 VITE_API_URL"的**假阳性结论**,误报 bug。

这种混乱会让本审计分支**持续产生无意义的重复 finding**,每次都要先搞清楚"我看的是什么状态"。

**修复方案**：

选项一:定期把 `main` merge 进 `bugs_list`（或 fast-forward rebase,但会丢 BUGS.md 的本地历史）。

选项二:在本分支 `docs/internal/BUGS.md` 顶部加一段**硬性约束**:

```markdown
> **本分支陈旧警告**：本分支只用于维护 BUGS.md,**工作树代码可能落后 main**。
> 审计时必须 `git fetch && git show origin/main:<file>` 或 `git grep <pattern> origin/main`,
> **不要**读本地工作树的源码结论。当前落后数:<N> commits（每周末脚本更新）。
```

选项三:加一个预提交 hook / CI check,阻止在 bugs_list 上编辑 `packages/*` 业务代码（本分支规则已声明只改 doc)。

**修复方案**：

合并上述三者,最小成本是加 README 段落 + 每周自动化 fetch。

**预估**：30 分钟

---

## 相邻 Round 2/3 回归扫描

**结论**：以下 Round 2/3 bug **未被本次审计 PR (#111/#114/#120) 触碰,也未被回归。但仍未修复。**

| # | 原状态 | 回归风险评估 | 理由 |
|---|---|---|---|
| BUG-040 | `[ ]` 待修 | 无回归 | `packages/web/src/utils/yjsProjectManager.ts` 的 `_userOrigin` 逻辑未改。跨 tab 污染依然存在 |
| BUG-041 | `[ ]` 待修 | 无回归 | `packages/web/src/contexts/CanvasDataContext.tsx` 未改。re-render 风暴依然存在 |
| BUG-070 | `[ ]` 待修 | 无回归 | `useYjsProjectStore.ts` 的 `unsubSynced → undoCleanup` 时序逻辑未改。监听器泄漏依然存在 |
| BUG-071 | `[ ]` 待修 | 无回归 | `yjsManager.ts` `destroy()` 内仍然 `subdocProviders.forEach((p) => p.destroy())`,未逐个 `subdoc.destroy()`。内存泄漏依然存在 |

BUG-070 的修复建议会**同时**和 PR #113 的 `onAuthFailed` 相互作用（都在 `useEffect` 里),修复时注意把两者的清理顺序理清:先 `provider.disconnect()` 再 `um.off(...)`,避免 `um` 因 provider 关闭而已不可用。

---

## 相邻:PR #111 审计（vite-api-url-no-api-suffix,现已被 PR #120 吞并）

PR #111 本身是一个**纯文档 bug 修复**:把 `.env.docker` 里的 `VITE_API_URL=https://your-domain.com/api` 改为 `https://your-domain.com`（无 `/api` 后缀),以及 `DEPLOY.md` 3 处示例同步修正。核心逻辑**正确**。

但 PR #120 一并移除了 `VITE_API_URL` 这个变量,所以 PR #111 的文档修订**整体失效**:

- `.env.docker` 的 `VITE_API_URL` 行被 PR #120 的 commit `0e5b4cb` 删掉
- `DEPLOY.md` 里 PR #111 精修的 3 个配对示例也被 PR #120 配套文档改写覆盖

**结论**: PR #111 属于"先治标后治本"的补丁,治本是 PR #120。无新 bug 引入,审计通过。

---

## 审计总结

**审计范围回顾**：PR #111、#114、#120 + Round 2/3 四条前端 bug 的回归扫描。

### 核心架构判断

**PR #120 的相对 URL 重构是正确方向**:
- 解决了"一个域一个 bundle"的 VITE_API_URL 反模式
- dev/prod 都通过单一 reverse proxy（Vite dev server 或 nginx)保持**同源**
- Hocuspocus WebSocket URL 正确使用 `window.location.protocol` 派生 wss/ws,HTTPS 页面不会降级到 `ws`
- Dev 模式 Vite proxy 配置正确,`ws: true` + `changeOrigin: true` 确保 upgrade 正常
- CORS 在同源下不触发,简化了 `packages/server/src/middleware/cors.ts` 的风险暴露面

**但有配套清理不彻底的问题**:
1. `websocket.ts` 文件是**死代码**,PR #120 改了却没发现它无人调用（BUG-C-02）
2. `InfoBadge.tsx` 的 `/terms` / `/privacy` 变成 SPA 内部路由,触发无限跳转 workspace（BUG-C-03）
3. 运行时无跨域 escape hatch,CDN 部署场景被破坏（BUG-C-04）
4. `vite-env.d.ts` 类型过瘦（BUG-C-05）

**PR #114 的 Loading overlay 移除**：
- 理由"Yjs sync < 1s"**只在 warm cache 场景成立**,冷启动 / 大文档 / 连接失败时用户看到空画布与空项目无法区分（BUG-C-01）
- 没有回退的 `onDisconnect` / `onStatus` 处理,彻底失去错误反馈能力

**PR #111 审计通过**，现已被 PR #120 并入更彻底的修复。

### Round 2/3 回归扫描结果

本次 3 个 PR **均未触碰** BUG-040/041/070/071 相关代码,故无回归。但也没有修复,仍为未修状态。

### 交付

- **新发现**: 8 条（均为 P1/P2/LOW）
  - P1: BUG-C-01, BUG-C-02, BUG-C-03, BUG-C-04
  - P2: BUG-C-05, BUG-C-06, BUG-C-07, BUG-C-08
- **回归**: 0
- **误报风险**: 本审计开始时一度被 `bugs_list` 工作树的 stale 代码误导（见 BUG-C-08）,后改用 `git show origin/main:<file>` 和 `git grep origin/main` 核实

### 审计方法备忘

- 所有代码结论以 `git show origin/main:<path>` 或 `git grep <pattern> origin/main` 为准
- 核实 `origin/main` tip 为 `3f29709` (PR #125)
- 本地 `bugs_list` tip 为 `e9bba0d` (PR #109),差 16 commit
- 本审计从未在业务代码做任何修改（MANDATORY role boundary）

---

### BUG-106

**标题**：PR #121 把 `migrate` service 改为 `image:`，但 `working_dir: /app/packages/server` 跟 Dockerfile.server 的 `WORKDIR` 假设耦合，其他基于 `breatic` image 的 compose override 可能静默 run 错目录

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW

- **位置**：`docker-compose.yml:56`（migrate 块）+ `Dockerfile:40`（WORKDIR /app）

**根因**：

PR #121 把 `build: .` 改成 `image: ghcr.io/orime-org/breatic:${BREATIC_TAG:-latest}`，但 `working_dir: /app/packages/server` 是遗留的旧配置——它依赖镜像的 `/app/packages/server/node_modules` 存在。这个耦合现在完全隐式：

- 如果 Dockerfile 未来重组（比如拍扁目录结构、改用 `dist/` 根目录），`migrate` service 会 silently 找不到 `@breatic/core` 而崩。
- 其他服务（api/worker/collab）用的是 `command: ["node", "packages/<name>/dist/index.js"]`，这是 `/app` 根目录下的绝对路径依赖。
- 注释提到 "Must run from packages/server so Node can resolve @breatic/core's transitive deps" 但没解释为什么 api/worker/collab 不需要——因为它们的 `command:` 里写完整路径，Node 从命令行 script 的目录解析 node_modules。

**影响**：

- 今天不坏，但 Dockerfile 和 docker-compose.yml 之间的"workdir / command path"约定是隐式的——维护性风险。
- 重构 Dockerfile 时如果不同步更新 docker-compose.yml，migrate 会在部署时才报错。

**修复方案**：

- 在 Dockerfile 里加 `ENTRYPOINT` 或 shell script，把 "run 某个 package 的 migration / server" 包装成命令。docker-compose.yml 只调 `command: [migrate]` 即可。

**优先级**：LOW——但属于"deploy-dev 边界不清晰"的技术债，PR #121 是改动热点，该修就趁这波。


---

### BUG-108

**标题**：`docker/build-push-action@v7` + `type=gha` cache 对 PR 场景配置不一致，PR 里 `load: true` 但 cache mode 仍是 `mode=max`，会把 PR layer 污染回基 cache 造成跨 PR 缓存脏化

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW

- **位置**：`.github/workflows/ci.yml:110-120`（breatic build block）+ 同样模式的 `.github/workflows/ci.yml:136-145`（breatic-web block）

**根因**：

PR #121 设置：

```yaml
- name: Build + push breatic
  uses: docker/build-push-action@v7
  with:
    push: ${{ github.event_name != 'pull_request' }}
    load: ${{ github.event_name == 'pull_request' }}
    cache-from: type=gha,scope=breatic
    cache-to: type=gha,mode=max,scope=breatic
```

`mode=max` 会把所有中间层 push 到 gha cache。在 `scope=breatic` 下，PR 构建会写入 cache，下一个 PR 或 main push 会读。如果 PR 里有破坏性改动（比如临时 hard-code 某个 secret）而 build 没失败但 layer 泄漏，会被缓存共享给后续 build。

更关键：`scope=breatic` 对所有 PR 和 main 共享——没有按分支隔离。这对 PR CI 是常见反模式：

- PR 可以 poison cache（污染后续 build）；
- 安全建议用 `scope=breatic-${{ github.ref }}` 或至少 `scope=breatic-pr` vs `scope=breatic-main`。

GitHub Docker 官方文档也推荐 PR 用独立 scope 或 mode=min。

**影响**：

- 低——但如果将来加 secret mount（BuildKit secrets），PR 污染 cache 就能拿到 main 的构建上下文。
- layer cache 里可能暴露敏感中间产物（如果 Dockerfile COPY 了 `.env`——目前没有，但 Dockerfile 的复制粒度是 `COPY packages/ packages/`，如果 `packages/` 下有意外文件也会进 layer）。

**修复方案**：`cache-to: type=gha,mode=max,scope=breatic-${{ github.event_name == 'pull_request' && 'pr' || 'main' }}`。对 PR 用 `mode=min` 只缓存 inline manifest。

**优先级**：LOW——目前没造成实际事故，但属于 CI 硬化项。


---

### BUG-109

**标题**：PR #118 升级到 Node 24 runtime，但 `actions/setup-node@v6` 的 `node-version: 22` 跟 runtime 语义冲突，`pnpm/action-setup@v6` + pnpm 9.15.0 在 Node 24 下未经实测

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW

- **位置**：`.github/workflows/ci.yml:16-24`

**根因**：

PR #118 的 commit msg 精确区分了 "action runtime (Node 24)" vs "被安装的 Node 版本 (22)"——这是对的，但：

1. `actions/setup-node@v6` 本身是 Node 24 runtime，但仍支持 `node-version: 22`——OK。
2. `pnpm/action-setup@v6` 在 Node 24 runtime 下装 pnpm 9.15.0，然后 pnpm 9.15.0 内部工具链/nan modules 可能对 Node 24 有不同行为（例如 better-sqlite3 之类的原生模块）。项目 `package.json` 的 `packageManager` 是 `pnpm@9.15.0`，`engines.node` 未声明——这意味着 CI 可以静默用跟生产 Node 22 不同的版本跑工具链。
3. Dockerfile 的 `FROM node:22-slim`——生产还是 Node 22。CI 工具链用 Node 24 跑，生产二进制在 Node 22 上跑，有细微的兼容差异（typically 向下兼容，但 breatic 用 AI SDK + Drizzle + Hocuspocus 这种大量 peer deps 项目，bumps 没做 smoke test）。
4. PR #118 commit msg 提 "bumped to Node 24 majors" 但没声明已验证所有 action 在新 runtime 下成功。实际上 PR #122 就是在 PR #121 跑后发现 login-action v3 / metadata-action v5 的 Node 20 warnings ——说明 PR #118 的升级是不完整的。一周内就发生了 PR #122 作为补漏。

**影响**：

- 目前 CI 能跑过说明工作链 OK，但这是 happy path。将来 Node 25 / Action v7 出来，又会 ripple 一轮。
- 版本漂移：CI Node 24 vs 生产 Node 22 没有 pin policy。

**修复方案**：

- 方案 A：Dockerfile 升到 `node:24-slim`，让 CI 和生产统一。（有 infra 影响，需评估。）
- 方案 B：`package.json` 加 `engines: { node: ">=22.0.0 <23" }`，至少在 CI 里用 setup-node 的 `check-latest: false` + 固定 version。
- 方案 C：保持现状但文档化——CI 工具链 runtime 跟镜像 runtime 可以解耦但要注明。

**优先级**：LOW——但 PR #118/#122 的节奏说明 "runtime 升级" 没有 staging、没有 pre-flight，一周两次补丁。


---

### BUG-110

**标题**：PR #121 的 `workflow_dispatch` 之外，CI 没有 "build only / no push" 的 manual trigger，紧急回滚需手动 push dummy commit

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW

- **位置**：`.github/workflows/ci.yml:1-8`（on: trigger）

**根因**：

CI trigger 只有 push + PR：

```yaml
on:
  push:
    branches: [main, test_thinkai_cc]
    tags: ['v*']
  pull_request:
    branches: [main]
```

没有 `workflow_dispatch`。**回滚场景**：main 上出了破坏性 commit，已经被 CI publish 成 `:latest`。要回滚：

1. 方案 A：revert commit + push → 触发 CI → 重新 publish `:latest`。但这有延迟（CI ~15min）+ 需要 revert 也过 CI，中间窗口期用户已经在拉坏的 `:latest`。
2. 方案 B：手动在 GHCR 把 `:latest` tag retag 到老 digest——需要 package write 权限 + 手动 docker CLI 操作，没有工作流自动化。

这意味着：镜像发版的**时序控制**完全掌握在 main push 上，没有"冷冻/回退"按钮。对于配合 D-04（`:latest` = rolling main）这是复合风险。

**影响**：

- 生产事故响应时间 MTTR 放大——没有 "republish old tag to :latest" workflow。
- test_thinkai_cc 分支的部署 (70dfeaa → f67a74e 轨迹显示经历了 SSH deploy → server-side cron polling 这种反复) 说明部署管道还在迭代，没有成熟的回滚手段。

**修复方案**：

- 加 `workflow_dispatch` 到 trigger，input 接受 `tag_to_promote`，build job 可以手动把老 digest 重新打成 `:latest`。
- 或独立 `.github/workflows/promote.yml` 专门做 tag 改写，不和 CI build 混一起。

**优先级**：LOW——还没出事，但跟 D-04 叠加会很痛。


---

### BUG-111

**标题**：`test_thinkai_cc` 分支作为 staging 入口，但 CI 里 `:test_thinkai_cc` tag 出现在 metadata-action 生成的 tag list 里**同时** `:latest` 也出现（当 is_default_branch），代码路径和 tag 路径之间对"staging"的语义不清晰

- **状态**：`[ ]` 待修
- **严重度**：🟡 LOW

- **位置**：`.github/workflows/ci.yml:101-118`（metadata-action tags 规则）+ `.env.docker` BREATIC_TAG 注释

**根因**：

metadata-action tag 规则：

```yaml
tags: |
  type=ref,event=branch      # → :main / :test_thinkai_cc
  type=ref,event=pr          # → :pr-<number>
  type=semver,pattern={{version}}
  type=semver,pattern={{major}}.{{minor}}
  type=raw,value=latest,enable={{is_default_branch}}
```

推 `main` 会生成 `:main` + `:latest`（两个都是同一个 manifest）。推 `test_thinkai_cc` 生成 `:test_thinkai_cc`。**两套 tag 命名空间没有 "staging/prod" 标签语义**——就是 branch 名称直接当 tag。

问题：

1. 如果开发者在 `test_thinkai_cc` 分支推了临时/破坏性调试代码，`:test_thinkai_cc` 就是脏的。但.env.docker 里"Common values: `test_thinkai_cc` — staging branch"把这个当成了生产可指向的 stable tag。
2. Staging → Prod 的升级路径不明——目前 staging 是 `:test_thinkai_cc`，production 是 `:latest`（= main）；如果想升级"staging 上验证过的这个版本"到 prod，需要手动 `docker tag` + `docker push` 或 merge branch——没有 promotion workflow。
3. `test_thinkai_cc` 分支当前状态（从 git log 看）是和 main 交叉 merge，意味着 staging branch 没有长期独立历史，用 branch name 做 tag 在这个 branching model 下价值不高。

**影响**：

- `:test_thinkai_cc` tag 的稳定性没保证——任何 push 到 `test_thinkai_cc` 都 overwrite。没有 pre-merge 的 staging validation contract。
- 开源用户看 .env.docker 可能误以为 `BREATIC_TAG=test_thinkai_cc` 是一个"公司内部 stable staging tag"——实际上是随 branch HEAD 漂移的。

**修复方案**：

- 方案 A：staging validated 后用 `v<version>-rc1` tag 推 semver 而不是依赖 branch name。
- 方案 B：.env.docker 移除 `test_thinkai_cc` 示例，只推荐 `latest` 或 pinned version。
- 方案 C：staging branch 换成 protected branch with merge queue，保证 tag 语义。

**优先级**：LOW——但是 deploy workflow "不成熟期"的标志，值得在 docs 说明期望。

---

## 审计小结

| 类别 | 数量 |
|------|------|
| MED | 5（D-01, D-02, D-03, D-04, D-06） |
| LOW | 5（D-05, D-07, D-08, D-09, D-10） |

**主要集中方向**：

1. **Nginx canonical redirect 实现** 有 3 个缺陷（D-01 HTTP-only 模式不 canonical、D-02 `$host` open redirect、D-03 证书覆盖假设无校验）。PR #112 / #117 的修复方向对，但实现没有闭环。
2. **GHCR/CI 发版链路** 有 4 个问题（D-04 `:latest` rolling main 无 release gate、D-06 package visibility 手动步骤、D-09 无回滚机制、D-10 staging tag 语义漂移）。这条 pipeline 从 PR #118→#121→#122 三连推证明是快速迭代中，文档跟不上实现。
3. **已知 bug 附带修复情况**：4 个跟 D 组相关的 round-3 bug（BUG-063/074/077）在 PR #112-#122 里**全部未顺手修**。PR #121 动 docker-compose.yml 时本有机会加 worker healthcheck（BUG-063）和 postgres password via env-var（BUG-074），但都保留原样。

**推荐优先级**：D-02（open redirect）> D-01（HTTP-only canonical）> D-04（`:latest` rolling）> 其余。

**没有发现**：5 个 PR 整体没有 introduce 新的 P0 级安全洞或数据丢失风险。方向都在 ops/infra 硬化范畴。

---

## 审计统计

| 桶 | 数量 | 编号 |
|---|------|------|
| P0 | 2 | BUG-079, BUG-093 |
| P1 HIGH | 1 | BUG-092 |
| P1 MED | 14 | BUG-080, 084~090, 094~097, 102~105, 107 |
| P2 LOW | 16 | BUG-081~083, 087, 089, 091, 098~101, 106, 108~111 |
| **合计** | **33** | |

---

## 总体风险判断

1. **`deductOnce` 零调用(BUG-079)是本轮最严重的单点发现**。文档承诺的"幂等扣费"在生产代码里不存在——Agent SSE 断线、BullMQ at-least-once、Hono handler 重入都能触发双扣。PR #125 强化了一个死函数,把真实漏洞延期了一轮。
2. **imageEditor regression(BUG-093)是 PR #113 的 collateral damage**。authz 启用后暴露出 `useYjsStore` 删除 `mode` 参数时留下的既存错误,图像编辑器对协作的连接会 100% 失败。需要立即验证是否实际影响用户。
3. **部署 infrastructure 在快速试错期**。PR #112 错写 apex→www → PR #117 补救 default_server → PR #118 升级未测全 → PR #122 补 login/metadata-action。一周两次补丁说明缺 staging 预验证,值得单独建立"CI/deploy 变更的 gate"。
4. **相邻 bug 未附带修复是 systemic 问题**。10 个触碰热点的 Round 2/3 bug 都没顺手处理。建议下一轮:PR 合入前要求作者 grep 当前改动范围内 BUGS.md 的位置是否有相邻条目,形成最小约束。

---

## 建议派发(next actions)

按严重度 × 根因聚合:

### Critical batch(立即 24h)
- **BUG-079** 把 3 条非任务扣费路径迁移到 deductOnce(spawn / main-agent / text-tool)+ 重新跑 E2E
- **BUG-093** 运行时 repro → 若确认 image editor 协作失败 → 恢复 `useYjsStore` 的 mode 参数 或 拆 `useNodeYjsStore`

### Credit/Payment batch B(本周)
- **BUG-080** schema.ts 加 restrict 到两个兄弟 FK + migration 0009
- **BUG-060**(原) + **BUG-061**(原) + **BUG-062**(原) 合一次性修完(Batch B 延续 #125 节奏)
- **BUG-038**(原) isolation level 配合 Batch B 落地

### Auth 一致化 batch(本周)
- **BUG-086 / 088**(auth failure 路径一致化 Redux + localStorage + SPA navigate vs window.location)
- **BUG-084**(NoAccount 下 LS / Redux 真源统一)
- **BUG-090**(request/sse JSON.parse 抽公共 readAuthFromStorage)
- **BUG-054**(原) + **BUG-092**(collab 入口) 合并修复——把 `env.ENV === "dev"` 白名单下沉 core

### Deploy/CI 硬化 batch(本月)
- **BUG-103**(open redirect)+ **BUG-102**(HTTP-only canonical)+ **BUG-104**(证书 SAN 校验)一起 → nginx canonical 实现闭环
- **BUG-105**(`:latest` rolling)+ **BUG-110**(workflow_dispatch) → release gate 机制
- **BUG-063**(原 Worker healthcheck) + **BUG-074**(原 postgres 密码)顺手在下一个 docker-compose 改动里处理

---

## 附:审计方法备忘

- 所有代码结论基于 `git show origin/main:<path>` 或 `git grep <pattern> origin/main`
- 本地 `bugs_list` 分支落后 `origin/main` 16 commit,Agent C 一度被工作树误导(见 BUG-101),后改用 `origin/main`  核实
- 审计全程未在业务代码做任何修改(MANDATORY role boundary)
- 4 个 agent 各自返回 /tmp/round4-audit-{A,B,C,D}.md,本文件由脚本 `build-round4.py` 合成
