# Bug 修复清单 — Round 2

审计日期：2026-04-15
前置：见 [audit/2026-04-15-round-1-closed.md](./audit/2026-04-15-round-1-closed.md)（Round 1 的 29 个 bug 已全部关闭）

状态标记：`[ ]` 待修 · `[~]` 进行中 · `[x]` 已修 · `[-]` 不修（附原因）

## Round 2 背景

Round 1 在 PR #81-90 密集修复了 29 个 bug（XSS、提示词注入、NoAccount 守卫、Stripe 竞态、cascade 迁移等）。第 6 次审计复查发现：

- ✅ **21 个旧 bug 真修了**（不是表面修复）
- ⚠️ **修复引入 15 个新 regression**（3 HIGH + 10 MED + 2 LOW）
- 🔴 **测试质量 2/5 星** —— 65 个测试里只有 ~4 个真测业务

本 Round 2 清单专注解决：(a) 新引入的 regression，(b) 测试质量提升。

---

## P0 — 立刻修（安全 + 部署阻塞）

### BUG-030 · Rate Limiter 可被 X-Forwarded-For 绕过（HIGH）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/infra/rate-limiter.ts:25` · `packages/server/src/routes/auth.ts`
- **当前代码**：
  ```typescript
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
  ```
- **问题**：直接信任客户端 `X-Forwarded-For` header。攻击者每次请求改 `X-Forwarded-For: 1.1.1.X` → 每次都是新 key → rate limit 永远不触发 → **BUG-010 的 rate limit 修复被完全架空**
- **修复**：
  1. 实现 `getClientIp(c)` helper：
     ```typescript
     function getClientIp(c: Context): string {
       const xff = c.req.header('x-forwarded-for')
       if (xff) {
         const ips = xff.split(',').map(s => s.trim()).filter(Boolean)
         return ips[0] || 'unknown'
       }
       return c.req.header('x-real-ip') ?? 'unknown'
     }
     ```
  2. 所有 rate limit 使用 `getClientIp(c)` 代替手搓 header 解析
  3. **生产侧**：nginx.conf 要配 `set_real_ip_from` 只信任内网代理 IP，防止外部伪造
- **验证**：
  ```bash
  # 攻击模拟: 不同 header 发 20 次 login
  for i in {1..20}; do
    curl -X POST https://thinkai.cc/api/auth/login \
      -H "X-Forwarded-For: 1.1.1.$i" \
      -d '{"email":"a@b.c","password":"x"}'
  done
  # 修复前: 全部 200/401(rate limit 被绕)
  # 修复后: 第 6 次起 429(rate limit 生效)
  ```
- **预估**：30 分钟 + nginx 配置 15 分钟

### BUG-031 · deleteProject 不级联软删子记录（HIGH）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/modules/project.repo.ts:190`
- **当前代码**：
  ```typescript
  export async function deleteProject(id: string): Promise<void> {
    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, id))
  }
  ```
- **问题**：BUG-020 把 FK 从 cascade 改成 restrict 后，deleteProject 只软删 project 本身，不级联软删 conversations / node_history / project_memories 等子表。结果：
  1. 列表查询时，属于"已删除 project"的 conversation 仍然出现
  2. 未来做 GDPR 硬删时触发 FK restrict 违反
  3. 数据一致性被破坏
- **修复**：
  ```typescript
  export async function deleteProject(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      const now = new Date()
      await tx.update(conversations).set({ deletedAt: now }).where(
        and(eq(conversations.projectId, id), isNull(conversations.deletedAt))
      )
      await tx.update(nodeHistory).set({ deletedAt: now }).where(
        and(eq(nodeHistory.projectId, id), isNull(nodeHistory.deletedAt))
      )
      await tx.update(projectMemories).set({ deletedAt: now }).where(
        and(eq(projectMemories.projectId, id), isNull(projectMemories.deletedAt))
      )
      await tx.update(projectMemoryEntries).set({ deletedAt: now }).where(
        and(eq(projectMemoryEntries.projectId, id), isNull(projectMemoryEntries.deletedAt))
      )
      await tx.update(tasks).set({ deletedAt: now }).where(
        and(eq(tasks.projectId, id), isNull(tasks.deletedAt))
      )
      // yjs_documents 需要特殊处理(doc name 含 project-{id})
      await tx.update(yjsDocuments).set({ deletedAt: now }).where(
        sql`name LIKE ${`project-${id}/%`}`
      )
      await tx.update(projects).set({ deletedAt: now }).where(eq(projects.id, id))
    })
  }
  ```
- **验证**：
  - 创建一个 project + 3 个 conversation + 2 个 task
  - 调 deleteProject
  - 检查 conversation / task 是否都 `deletedAt IS NOT NULL`
- **预估**：1 小时（含测试）

### BUG-032 · Presigned URL 修复只做了 4/7 子问题（HIGH）

- **状态**：`[ ]` 待修
- **位置**：`packages/server/src/routes/assets.ts` · `packages/core/src/infra/storage/s3.ts`
- **问题**：PR #88 修了 4 个子问题但遗漏 3 个关键项：
  | 子问题 | PR #88 状态 |
  |--------|-------------|
  | Presign expiry 5min | ✅ 已修 |
  | Local key 路径验证 | ✅ 已修 |
  | Rate limit on /presign | ✅ 已修 |
  | Key 格式正则 | ✅ 已修 |
  | **MIME 类型验证** | ❌ 未做 |
  | **Post-upload HEAD 验证** | ❌ 未做 |
  | **reportHistory fileUrl IDOR** | ❌ 未做 |
  | **S3 Content-Length-Range** | ❌ 未做 |
- **攻击场景**：
  1. 上传 `shell.exe` 带 `Content-Type: image/png` → 后端接受 → 后续展示触发 XSS
  2. 用户 A presign 一个 key → 泄露给 B → B 用 fileUrl 关联到自己的 conversation（IDOR）
  3. 上传 100GB 文件 → S3 账单爆炸
- **修复**：
  1. **MIME + magic bytes 验证**：上传完成后 HEAD + 下载头 12 字节做 magic bytes 检查
  2. **Post-upload HEAD endpoint**（`POST /assets/complete`）：
     ```typescript
     const head = await adapter.head(key)
     if (head.size > UPLOAD_MAX[kind] * 1024 * 1024) {
       await adapter.delete(key)
       throw new ValidationError('File too large')
     }
     const magic = await adapter.getRange(key, 0, 12)
     if (!validateMagicBytes(kind, magic)) {
       await adapter.delete(key)
       throw new ValidationError('File type mismatch')
     }
     ```
  3. **reportHistory fileUrl 验证**：presign 时写 ticket 到 Redis（`upload:ticket:{userId}:{nodeId}` → key），reportHistory 时校验 fileUrl 包含这个 key
  4. **S3 presigned POST policy**（不是 PUT）：加 `Conditions: [['content-length-range', 0, maxBytes]]`
- **预估**：2.5 小时

### BUG-033 · Canvas task 创建顺序错（孤儿 task）（HIGH）

- **状态**：`[ ]` 待修
- **位置**：`packages/server/src/routes/canvas.ts:80-88`
- **当前代码**：
  ```typescript
  const task = await taskService.create(...)   // 1. 先创建 task
  if (nodeId && projectId) {
    const acquired = await acquireNodeLock(..., task.id)   // 2. 后锁
    if (!acquired) {
      throw new ConflictError(...)   // ❌ task 已创建,孤儿
    }
  }
  ```
- **问题**：锁失败时 task 已经建了但没入队 → 数据库有永远 pending 的孤儿 task → 前端显示"pending"永不结束
- **修复**：锁失败时回滚 task
  ```typescript
  const task = await taskService.create(...)
  if (nodeId && projectId) {
    const acquired = await acquireNodeLock(..., task.id)
    if (!acquired) {
      await taskService.softDelete(task.id)   // 回滚
      throw new ConflictError(...)
    }
  }
  ```
  或更好的设计：**先锁后建**（避免回滚）
- **预估**：15 分钟

### BUG-034 · Docker Compose 端口暴露到公网（HIGH）

- **状态**：`[ ]` 待修
- **位置**：`docker-compose.yml`
- **问题**：`postgres:5432`、`redis:6379`、`collab:1234` 全部 bind 到 `0.0.0.0`。公网部署直接暴露数据库和 Redis
- **修复**：
  ```yaml
  postgres:
    ports:
      - "127.0.0.1:5432:5432"   # 只绑 localhost,内网 docker 网络不受影响
  redis:
    ports:
      - "127.0.0.1:6379:6379"
  collab:
    ports:
      - "1234:1234"              # Collab 必须对外,保持原样
  ```
- **预估**：5 分钟

---

## P1 — 本周修

### BUG-035 · Lua 锁释放脚本 null taskId 处理（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/infra/canvas-lock.ts:109-122`
- **当前代码**：
  ```lua
  if data.taskId == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return -1
  ```
- **问题**：BUG-012 修复前的老事件没有 `taskId` 字段，`data.taskId == nil`，`ARGV[1]` 是字符串 `"undefined"` → 比较 false → **锁永远不释放**
- **修复**：向后兼容处理
  ```lua
  if not data.taskId or data.taskId == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return -1
  ```
- **预估**：10 分钟

### BUG-036 · 6 张表 deletedAt filter 审计（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/modules/*.repo.ts`（memory 相关）
- **问题**：PR #86 给 6 张 memory 表加了 `deletedAt`，但 list / select 查询未全部更新过滤
- **影响**：用户软删 conversation 后，其 memory 可能仍被 LLM 加载为 context，导致 AI 基于过时数据做决策
- **修复步骤**：
  1. 列出需要审计的表：
     - `conversationMemories`
     - `memoryHistoryEntries`
     - `userMemories`
     - `userMemoryEntries`
     - `projectMemories`
     - `projectMemoryEntries`
  2. 用 grep 找所有查询：
     ```bash
     grep -rn "from(conversationMemories)\|from(userMemories)\|from(projectMemories)\|from(userMemoryEntries)\|from(projectMemoryEntries)\|from(memoryHistoryEntries)" packages/core/src/
     ```
  3. 每处查询加 `isNull(tableName.deletedAt)`
  4. 抽 helper：
     ```typescript
     export function notDeleted<T extends { deletedAt: PgColumn }>(table: T) {
       return isNull(table.deletedAt)
     }
     // 使用:
     .where(and(eq(userMemories.userId, userId), notDeleted(userMemories)))
     ```
- **预估**：1 小时

### BUG-037 · 文本编辑器工具栏上传绕过 presign 流程（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/apps/project/components/textEditor/ui/RightToolbar.tsx`（d7a8d9b 新增）
- **问题**：新工具栏上传功能可能直接 POST 文件，绕过现有的 presigned URL + rate limit + MIME 校验流程
- **修复**：
  1. 审查 RightToolbar 上传逻辑
  2. 强制走标准流程：`fetch('/presign', ...)` → `fetch(uploadUrl, { method: 'PUT', ...})` → `fetch('/complete', ...)`
  3. 复用 canvas 上传的 hook（抽成 `useUploadFlow`）
  4. 加客户端侧大小/类型预检（体验）
- **预估**：1 小时

### BUG-038 · Credit Transaction 隔离级别未设置（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/modules/credit.service.ts:50-75`
- **当前代码**：
  ```typescript
  await db.transaction(async (tx) => {
    // 两步: deductCredits + recordTransaction
  })
  ```
- **问题**：未显式设 isolation level。高并发下两个 deduct 可能互相锁 user row 导致死锁
- **修复**：
  ```typescript
  await db.transaction(async (tx) => {
    // 用 FOR UPDATE 显式锁目标行
    const [user] = await tx
      .select({ id: users.id, credits: users.credits })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('update')    // ← 行锁
      .limit(1)
    
    if (!user || user.credits < amount) throw new InsufficientCreditsError()
    
    await tx.update(users).set({ credits: user.credits - amount }).where(eq(users.id, userId))
    await tx.insert(creditTransactions).values({ userId, amount: -amount, reason, ... })
  }, { isolationLevel: 'read committed' })
  ```
- **预估**：30 分钟

### BUG-039 · DOMPurify ALLOWED_TAGS 过度严格（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/utils/sanitize.ts`
- **问题**：BUG-002 修复时 ALLOWED_TAGS 没包含 BlockNote / TipTap 实际产出的节点类型（`figure`、`video`、`audio`、`data-*` 属性等）。用户插入媒体块被静默 strip
- **修复**：扩充白名单覆盖 BlockNote schema：
  ```typescript
  const RICH_TEXT_SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'blockquote',
      'a', 'img',
      'figure', 'figcaption',     // 新增
      'video', 'audio', 'source',  // 新增(source 必需给 video/audio 用)
      'span', 'div',
      'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'mention', 'reference',      // BlockNote 自定义节点(如果有)
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class', 'style',
      'data-*',        // BlockNote / TipTap 节点元数据
      'width', 'height',
      'colspan', 'rowspan',
      'controls',      // video/audio
      'type',          // source
    ],
    ALLOWED_URI_REGEXP: /^(https?:\/\/|mailto:|tel:|\/|data:image\/)/i,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'formaction'],
  }
  ```
- **验证**：测试插入图片/视频/表格/mention 后预览不丢内容
- **预估**：20 分钟

### BUG-040 · Undo/Redo 跨 Tab 污染（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/utils/yjsProjectManager.ts`
- **问题**：BUG-018 修复时 origin 设为 `'canvas-user:' + userId`。用户开两个 tab → 同 userId → tabA 的 undo 影响 tabB
- **修复**：追加 sessionId
  ```typescript
  const sessionId = useMemo(() => crypto.randomUUID(), [])
  const userOrigin = `canvas:${userId}:${sessionId}`
  
  const undoManager = new Y.UndoManager([nodesMap, edgesMap], {
    trackedOrigins: new Set([userOrigin]),
  })
  ```
- **预估**：10 分钟

### BUG-041 · CanvasDataContext Re-render 风暴（MEDIUM）

- **状态**：`[ ]` 待修
- **位置**：`packages/web/src/contexts/CanvasDataContext.tsx:116-119`
- **问题**：`value` 对象 useMemo 的 deps 包含 `nodesById`（每次 nodes 变都是新 Map）。所有 consumer 重渲染，即使只订阅 `toasts`
- **修复方案 A（简单，推荐）**：拆分 context
  ```typescript
  // 拆成 4 个 context
  const CanvasNodesContext = createContext<...>(...)       // nodes, edges, nodesById
  const CanvasLoadingContext = createContext<...>(...)     // loading, syncError
  const CanvasToastsContext = createContext<...>(...)      // toasts, dismissToast
  const CanvasActionsContext = createContext<...>(...)     // applyLocalNodeChanges
  
  // Provider 套 4 层
  ```
  订阅 `toasts` 的组件只关心 `CanvasToastsContext`，nodes 变化不触发重渲染。
- **修复方案 B（更现代）**：用 `use-context-selector` 库做字段级订阅
  ```bash
  pnpm --filter @breatic/web add use-context-selector
  ```
- **预估**：1 小时（方案 A）

---

## P2 — 本月修

### BUG-042 · extractPromptText ReDoS 风险（LOW）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/agent/extract-prompt.ts`
- **问题**：正则 `/<[^>]*>/g` 对深度嵌套 HTML 有 ReDoS 风险。`'<div'.repeat(10000) + '>'` 卡住 Worker
- **修复**：加长度限制 + 超时保护
  ```typescript
  export function extractPromptText(prompt: unknown): string {
    if (prompt == null) return ''
    let text = typeof prompt === 'string' ? prompt : String(prompt)
    
    // 防 ReDoS: 超长输入截断
    if (text.length > 100_000) {
      logger.warn({ length: text.length }, 'Prompt too long, truncating')
      text = text.slice(0, 100_000)
    }
    // ... 其余不变
  }
  ```
- **预估**：5 分钟

### BUG-043 · 错误日志泄露 stack trace（LOW）

- **状态**：`[ ]` 待修
- **位置**：`packages/server/src/middleware/error-handler.ts:21`
- **当前代码**：`logger.error({ err }, "Unhandled error")`
- **问题**：完整 err 对象含 stack trace + 内部路径。如果日志被访问 → 信息泄露
- **修复**：
  ```typescript
  logger.error({
    code: err.code ?? 'UNKNOWN',
    message: err.message,
    // 开发环境才记 stack
    ...(env.ENV !== 'production' && { stack: err.stack }),
  }, 'Unhandled error')
  ```
- **预估**：10 分钟

### BUG-044 · schema.ts 注释过时（LOW）

- **状态**：`[ ]` 待修
- **位置**：`packages/core/src/db/schema.ts:180`（其他地方也可能有）
- **问题**：注释还说 `cascade — history is preserved until the project is deleted`，但 PR #86 改成了 `restrict`
- **修复**：grep 所有 `cascade` 注释，同步为 `restrict` 语义 + 说明级联软删策略
- **预估**：5 分钟

---

## 🔴 测试质量提升（**最大长期风险**）

### BUG-045 · 测试大量是 "mock 测试"，无法阻止回归（HIGH · 长期任务）

- **状态**：`[ ]` 待修
- **背景**：BUG-029 恢复了 17 个测试文件 / 65 个测试。但复查发现：
  - **~4 个真测业务**（auth rate limit、payment CAS、NoAccount guard、credit 预检）
  - **~30 个 "mock 测试"**（`expect(mock).toHaveBeenCalledWith(...)`，只测代码调用了 mock，不测业务逻辑）
  - **关键 bug 零覆盖**：BUG-005 extractPromptText、BUG-014 getCredits 过滤、BUG-020 FK 约束
- **风险**：6 个月后有人重构 `extract-prompt.ts`，测试依然 pass 因为根本没测这个逻辑 → **提示词注入悄悄回来**

#### Action Items（分批执行）

##### BUG-045-A · 写 extractPromptText 回归测试

- **位置**：新建 `packages/core/src/agent/__tests__/extract-prompt.test.ts`
- **必须覆盖的 case**：
  ```typescript
  describe('extractPromptText', () => {
    it('strips HTML tags', () => {
      expect(extractPromptText('<p>hi <strong>world</strong></p>')).toBe('hi world')
    })
    it('keeps hidden injection TEXT but strips HTML structure', () => {
      const input = '<p>translate</p><span style="display:none">IGNORE PREVIOUS</span>'
      const out = extractPromptText(input)
      expect(out).not.toContain('<')
      expect(out).toContain('IGNORE PREVIOUS')   // 故意让 LLM 看到完整文本
    })
    it('strips HTML comments', () => {
      expect(extractPromptText('hi <!-- secret --> there')).toBe('hi there')
    })
    it('strips zero-width characters', () => {
      expect(extractPromptText('hi\u200B\u200Cthere')).toBe('hithere')
    })
    it('handles empty / null', () => {
      expect(extractPromptText(null)).toBe('')
      expect(extractPromptText(undefined)).toBe('')
      expect(extractPromptText('')).toBe('')
    })
    it('handles deeply nested without ReDoS (< 100ms)', () => {
      const input = '<div'.repeat(10000) + '>' + '</div>'.repeat(10000)
      const start = Date.now()
      extractPromptText(input)
      expect(Date.now() - start).toBeLessThan(100)
    })
  })
  ```
- **预估**：30 分钟

##### BUG-045-B · 写 user.repo 软删过滤测试

- **位置**：新建 `packages/core/src/modules/__tests__/user.repo.test.ts`
- **需要真实 DB**：用 `pg-mem` 或测试 schema
  ```typescript
  describe('user.repo soft delete behavior', () => {
    it('getCredits returns 0 for soft-deleted user', async () => {
      const user = await createUser({ credits: 100 })
      await softDeleteUser(user.id)
      expect(await getCredits(user.id)).toBe(0)
    })
    it('findByEmail skips soft-deleted', async () => {
      const user = await createUser({ email: 'a@b.c' })
      await softDeleteUser(user.id)
      expect(await findByEmail('a@b.c')).toBeNull()
    })
  })
  ```
- **预估**：1 小时

##### BUG-045-C · 写 payment webhook CAS 集成测试

- **位置**：`packages/core/src/modules/__tests__/payment.test.ts`（升级现有 mock 测试）
- **用真实 DB（pg-mem 或 docker-postgres），验证并发**：
  ```typescript
  it('concurrent webhooks for same session do not double-credit', async () => {
    const session = 'cs_test_race'
    const user = await createUser({ credits: 0 })
    await createPayment({ sessionId: session, userId: user.id, amount: 100, status: 'pending' })
    
    // 并发触发两次 webhook
    await Promise.all([
      handleCheckoutCompleted(session, 'pi_1', 100, user.id),
      handleCheckoutCompleted(session, 'pi_1', 100, user.id),
    ])
    
    const { credits } = await getUser(user.id)
    expect(credits).toBe(100)   // 只加一次,不是 200
  })
  ```
- **预估**：1.5 小时

##### BUG-045-D · 引入 Mutation Testing（推荐 stryker）

- **目的**：stryker 会偷偷改你的代码（把 `>` 改成 `>=`，把 `&&` 改成 `||`），看你的测试能不能抓到。抓不到的 mutation = 测试盲区
- **配置**：
  ```bash
  pnpm --filter @breatic/core add -D @stryker-mutator/core @stryker-mutator/vitest-runner
  ```
- **跑一次 baseline report**：预计会发现 **50-70% 的测试无法抓 mutation**（"看起来有测试实际没用"）
- **预估**：1 小时配置 + 持续迭代

##### BUG-045-E · 重写 HTTP route 测试（从 mock 测试 → 真实请求）

- **当前**：`projects.test.ts`、`conversations.test.ts`、`tasks.test.ts` 等 HTTP 测试只断言 status code + mock 调用
- **改成**：
  ```typescript
  // 之前(低价值)
  expect(mocks.projectService.deleteProject).toHaveBeenCalledWith('proj-1', 'user-1')
  
  // 之后(高价值)
  await api.delete('/projects/proj-1').expect(204)
  const project = await db.select().from(projects).where(eq(projects.id, 'proj-1'))
  expect(project[0].deletedAt).not.toBeNull()   // 真的软删了
  const conversations = await db.select().from(conversations)
    .where(eq(conversations.projectId, 'proj-1'))
  expect(conversations.every(c => c.deletedAt !== null)).toBe(true)   // 级联软删
  ```
- **预估**：每个 route 文件 1-2 小时，总 ~8 小时

**BUG-045 总预估**：~12 小时（分 2-3 个 sprint 做）

---

## 📋 汇总表（Round 2）

| ID | 标题 | 严重度 | 位置 | 时间 |
|----|------|-------|------|------|
| BUG-030 | Rate limiter X-Forwarded-For 绕过 | 🔴 HIGH | rate-limiter.ts + nginx | 45m |
| BUG-031 | deleteProject 不级联软删 | 🔴 HIGH | project.repo.ts | 1h |
| BUG-032 | Presigned URL 3 子问题遗漏 | 🔴 HIGH | assets.ts + s3.ts | 2.5h |
| BUG-033 | Canvas task 创建顺序错 | 🔴 HIGH | canvas.ts | 15m |
| BUG-034 | Docker 端口暴露公网 | 🔴 HIGH | docker-compose.yml | 5m |
| BUG-035 | Lua 脚本 null taskId | 🟠 MED | canvas-lock.ts | 10m |
| BUG-036 | 6 张表 deletedAt filter | 🟠 MED | memory repos | 1h |
| BUG-037 | 工具栏上传绕过 presign | 🟠 MED | RightToolbar.tsx | 1h |
| BUG-038 | Credit transaction 隔离 | 🟠 MED | credit.service.ts | 30m |
| BUG-039 | DOMPurify 过度 strip | 🟠 MED | sanitize.ts | 20m |
| BUG-040 | Undo 跨 tab 污染 | 🟠 MED | yjsProjectManager.ts | 10m |
| BUG-041 | Context re-render 风暴 | 🟠 MED | CanvasDataContext | 1h |
| BUG-042 | extractPromptText ReDoS | 🟡 LOW | extract-prompt.ts | 5m |
| BUG-043 | 错误日志泄 stack trace | 🟡 LOW | error-handler.ts | 10m |
| BUG-044 | schema.ts 注释过时 | 🟡 LOW | schema.ts | 5m |
| BUG-045 | 测试质量提升（含 5 个 action items） | 🔴 长期 | 测试全库 | ~12h |

**P0/P1 总时间**：约 **9 小时**（可 1-2 天完成）
**含测试质量提升**：约 **21 小时**（约 1 周）

---

## 🚀 推荐 Claude Code 派发策略

### 今天派发（P0 批次，2 小时）

```
修复 BUG-030、BUG-033、BUG-034（共约 1 小时）
  → 都是独立改动,可单 Claude 一次完成
  → 验证: pnpm typecheck && pnpm test
  → Commit: "fix: P0 batch — BUG-030/033/034"
```

### 明天派发（P0 剩余 + P1 部分，4 小时）

```
Claude A: BUG-031（deleteProject 级联软删）
Claude B: BUG-032（Presigned URL 3 子问题）
Claude C: BUG-036（memory 表 deletedAt filter）
  → 三个 worktree 并行,互不冲突
  → 每个完成后 merge 回 main
```

### 本周收尾（P1 剩余，3 小时）

```
单个 Claude 按顺序做: BUG-035, 037, 038, 039, 040, 041
  → 都是小改动,适合一个 Claude 连续处理
```

### 下周专注测试质量（BUG-045，12 小时）

```
分 5 个 PR:
  PR a: BUG-045-A extractPromptText test
  PR b: BUG-045-B user.repo test
  PR c: BUG-045-C payment webhook CAS test
  PR d: BUG-045-D mutation testing (stryker)
  PR e: BUG-045-E 重写 HTTP route tests
```

### 一行 prompt 模板

```
我要修复 breatic_ai 的 [BUG-XXX]。详细信息在 docs/internal/BUGS.md 里。

请:
1. 读 BUGS.md 中 BUG-XXX 的完整说明
2. 读相关源文件(路径在描述里)
3. 按修复方案精确修改
4. 跑 pnpm typecheck && pnpm test 确认
5. 执行验证步骤(如有)
6. Commit message: "fix: [BUG-XXX] short description"
7. commit 署名禁止出现 Claude/Anthropic/AI 字样(项目规则)
```

---

## 历史记录

- **Round 1**（2026-04-15）：29 个 bug 全部关闭。详见 [audit/2026-04-15-round-1-closed.md](./audit/2026-04-15-round-1-closed.md)
- **Round 2**（2026-04-15）：本文档，15 个 regression + 1 个测试质量 meta issue
