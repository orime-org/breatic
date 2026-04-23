# Fix Plan: BUG-173 — Text Mini-Tool 扣费绕过

> **性质**:本文是 audit session 给 dev 的**参考 fix 设计**,非 fix PR 本身。`bugs_list` 分支是 audit-only,不写业务代码。
>
> **Severity**:P0 (亿万级扣费绕过,一行 JS 可利用)
>
> **Audit 记录**:[Round 7 archive § BUG-173](../2026-04-23-round-7-found.md#bug-173)
>
> **相关**:同一修复建议覆盖 **BUG-159** 第 7 处裸 `catch {}`(text-tool.service.ts:215);可配合 **BUG-172** 一起 harden text-tools route

---

## 1. Bug 精确描述

`POST /mini-tools/text` 支持客户端通过 `Idempotency-Key` HTTP header 指定幂等 key。服务端把 header 原样拼进 `deductOnce` 的 refKey:`texttool:${idempotencyKey}`。

若 header 含不在 `REFKEY_PATTERN = /^[A-Za-z0-9_:.-]{1,255}$/` 白名单里的字符(最简单:**一个空格**),`deductOnce` 抛 `ValidationError`。该异常被 `deductForTokens` 内部的**裸 `catch {}`** 吞掉,只 log warn + 返回 0。

由于扣费调用发生在 **SSE stream 完整产出文本之后**,用户这时已拿到完整 AI 回复;服务端当作"扣费软失败"处理,0 credit 被记账。

**结果**:**任何登录用户,每次请求塞一个含空格的 `Idempotency-Key`,都能免费使用所有 10 个 text mini-tool(polish / expand / summarize / translate / rewrite / continue / generate / character / storyboard / script)。**

---

## 2. Exploit (验证过的端到端路径)

```javascript
// 登录后在浏览器 devtools 执行:
fetch('/api/mini-tools/text', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'foo bar',        // ← 空格不在 REFKEY_PATTERN 里
    'Authorization': 'Bearer ' + JSON.parse(localStorage.auth).state.token,
  },
  body: JSON.stringify({
    tool: 'polish',
    document: '<h1>hello</h1>',
    selection: { from: 0, to: 12 }
  })
}).then(r => r.text()).then(console.log);
// → stream 完整 AI 回复,server logs: "Credit deduction failed for text tool"
// → user.credits 减 0
```

**攻击面**:一行 JS · 任意登录用户 · 10 个 text-tool 全中 · 无速率限制(BUG-132)→ 可以秒级扫 thousand-req-per-minute 级滥用。

---

## 3. 根因分析(两层)

### 层 1:Route 层读 header 时**不 validate**

**位置**:`packages/server/src/routes/text-tools.ts:46`

```typescript
const idempotencyKey = c.req.header("Idempotency-Key") ?? randomUUID();
```

Fallback 只处理 "absent" 情况(无 header),**未处理 "malformed"** 情况(有 header 但不符 `REFKEY_PATTERN`)。等于信任 untrusted client input。

### 层 2:Service 层 catch 吞掉 `ValidationError`

**位置**:`packages/core/src/modules/text-tool.service.ts:207-220`

```typescript
try {
  await creditService.deductOnce(
    userId,
    `texttool:${idempotencyKey}`,
    credits,
    `Text tool: ${tool}`,
  );
  return credits;
} catch {
  // Don't fail the response if credit deduction fails (e.g. insufficient credits)
  // The text was already generated — deduct what we can
  logger.warn({ userId, tokens, credits }, "Credit deduction failed for text tool");
  return 0;
}
```

**注释里说 "e.g. insufficient credits"** —— 作者意图是**只 catch 账户余额不足类 soft-fail**,但实际 catch **完全不区分类型**,把 `ValidationError`(编程契约违反/用户恶意输入)也一起吞。

**这违反 CLAUDE.md 禁止清单**("裸 catch")+ **规则 #5 新升级版**("zero tolerance for patch")—— 注释里写的 soft-fail 范围 ≠ 实际 catch 范围。

---

## 4. 修复方案

### 方案 A-1:Route 层 validate,invalid → silent fallback 到 UUID

```typescript
// text-tools.ts:46
const headerKey = c.req.header("Idempotency-Key");
const idempotencyKey = (headerKey && REFKEY_PATTERN.test(`texttool:${headerKey}`))
  ? headerKey
  : randomUUID();
```

**优点**:修改最小(1 个 if);不破坏用户体验(malformed header 等价于 absent)。
**缺点**:**silent lying** —— 客户端以为自己指定的 idempotency-key 生效了,服务端偷偷换成 UUID。违反 RFC Idempotency-Key draft 的预期语义。**纯 patch,不是根因**(没修第 2 层的 `catch` 吞错问题)。

### 方案 A-2:Route 层 validate,invalid → `400 Bad Request`

```typescript
// text-tools.ts:46
const headerKey = c.req.header("Idempotency-Key");
if (headerKey !== undefined && !REFKEY_PATTERN.test(`texttool:${headerKey}`)) {
  throw new ValidationError(
    `Idempotency-Key must match ${REFKEY_PATTERN.source.replace("^", "").replace("$", "")} (max 245 chars after "texttool:" prefix)`
  );
}
const idempotencyKey = headerKey ?? randomUUID();
```

**优点**:行为明确契约(对齐 Stripe/Square 的严格 idempotency-key 语义);客户端能立即发现 header 格式错。
**缺点**:向后兼容 — 原先发含空格 header 不会报错,现在会;需沟通。

### 方案 B:Service 层 catch 区分 `ValidationError`

```typescript
// text-tool.service.ts:207
try {
  await creditService.deductOnce(
    userId,
    `texttool:${idempotencyKey}`,
    credits,
    `Text tool: ${tool}`,
  );
  return credits;
} catch (err) {
  if (err instanceof ValidationError) {
    // 编程契约违反(route 应 guard 但没 guard)。ERROR 级日志+rethrow。
    logger.error(
      { err, userId, tokens, credits, idempotencyKey },
      "ValidationError in deductOnce — route failed to guard refKey",
    );
    throw err;  // 向上抛,由 HTTP layer map 为 400(如果在 stream 已开始后到此处,
                // SSE 已 in-flight,需要 yield { type: "error" } 并 return)
  }
  // 账户余额不足 / Redis down 等真 soft-fail 场景
  logger.warn({ err, userId, tokens, credits }, "Credit deduction soft-failed for text tool");
  return 0;
}
```

**优点**:修复"catch 吞错"的根因;ValidationError 走 error path → 监控能发现 route-gap 回归。
**缺点**:stream 已开始(此函数在 stream 结束后调),此时 throw 只能 log + 让请求异常结束;但**用户已经拿到了 token**。单用方案 B 无法阻止免费 AI — 必须配合方案 A 堵入口。

### ⭐ 推荐:**方案 A-2 + B 组合**(双层防御)

```typescript
// text-tools.ts:46  ── 入口 guard (层 1)
const headerKey = c.req.header("Idempotency-Key");
if (headerKey !== undefined && !REFKEY_PATTERN.test(`texttool:${headerKey}`)) {
  throw new ValidationError(
    "Idempotency-Key contains characters not allowed in refKey pattern",
  );
}
const idempotencyKey = headerKey ?? randomUUID();

// text-tool.service.ts:207  ── 防御深度 (层 2)
try {
  await creditService.deductOnce(...);
  return credits;
} catch (err) {
  if (err instanceof ValidationError) {
    // 到此 = route guard 失效 = 真 bug,不是 soft-fail
    logger.error({ err, ... }, "ValidationError reached service — route guard gap");
    throw err;
  }
  logger.warn({ err, ... }, "Credit deduction soft-failed");
  return 0;
}
```

**为什么**:
1. **A-2 堵入口** —— untrusted input 根本不到 `deductOnce`。这是 CLAUDE.md #5 的"根因修"。
2. **B 防御深度** —— 万一未来别处 refactor 漏了 guard,service 层也能监控到(log as ERROR + throw)而不是静默吞。
3. 单用 A 的话:若未来有别的 callpath 跳过 route guard 直接调 service,仍可扣费绕过。
4. 单用 B 的话:stream 已开始,throw 只能产 error event,用户照样拿到了免费 AI。

**符合 CLAUDE.md #5 "zero tolerance for patch"** —— 不止修表面,根本不让 catch 把 ValidationError 吞掉。

---

## 5. 具体位置 + 改动清单

| 文件 | 行 | 改动 |
|------|-----|------|
| `packages/core/src/modules/credit.service.ts` | 29 附近 | **Export** `REFKEY_PATTERN` 或新增 `isValidRefKey(key: string): boolean` helper,让 route / service 共用(已 export,可直接 import) |
| `packages/server/src/routes/text-tools.ts` | 46 | 方案 A-2 改动 — 新增 5 行 validate |
| `packages/core/src/modules/text-tool.service.ts` | 207-220 | 方案 B 改动 — `catch` 改为 `catch (err) { if (err instanceof ValidationError) throw ... }` |
| `packages/core/src/modules/text-tool.service.ts` | 166-178 | **顺带**:error-path 里第 2 个 `deductForTokens` 调用也共用同一 catch 逻辑,无需额外改 |

**Import 补充**:
- `text-tools.ts` 需要 import `REFKEY_PATTERN` from `@breatic/core/src/modules/credit.service.js` + `ValidationError` from `@breatic/core/src/errors.js`
- `text-tool.service.ts` 已 import `ValidationError`(credit.service.ts 第 15 行已在同 package)

---

## 6. 测试 case 清单

### Unit 测试(text-tool.service.ts)

1. `deductForTokens(user, 1000, "polish", "valid-uuid")` 且用户余额充足 → 返回正常 credits
2. `deductForTokens(user, 1000, "polish", "valid-uuid")` 且余额不足 → **return 0**(soft-fail 保留)+ logger.warn
3. `deductForTokens(user, 1000, "polish", "foo bar")` → **throw ValidationError**(不再 return 0)+ logger.error
4. `deductForTokens(user, 0, ..., ...)` → return 0(快速返回,不调 deductOnce)

### Integration 测试(text-tools route)

5. `POST /mini-tools/text` 无 header → stream 正常 + 扣费(fallback UUID)
6. `POST /mini-tools/text` 合法 header `Idempotency-Key: "client-req-123"` → stream 正常 + 扣费
7. `POST /mini-tools/text` **`Idempotency-Key: "foo bar"`** → **`400 Bad Request`**,stream 未开始,user.credits 未变
8. `POST /mini-tools/text` `Idempotency-Key: "a".repeat(300)`(超 255)→ `400`
9. `POST /mini-tools/text` `Idempotency-Key: "\n\r"`(控制字符)→ `400`
10. **同一合法 `Idempotency-Key` 连发 2 次** → 第 1 次扣费 + 返回;第 2 次 `deductOnce` 检测到 duplicate,返回 0 扣费 + stream 仍 serve(正确的 idempotency 语义)

### 监控 / 日志验证

11. 构造一个 dev-only 测试:绕过 route 直接调 `deductForTokens(user, 1000, "polish", "invalid key")` → 看到 `logger.error("ValidationError reached service — route guard gap")`

---

## 7. 捆绑修复建议

### 同 PR 同时处理

- **BUG-159**(6 处裸 catch):本修复顺带处理 `text-tool.service.ts:215` 这第 7 处。建议把 BUG-159 原 audit 里列出的其他 6 处一起改,**因为团队本次就在动 catch 模式**,同一 review 一次改完。
- **BUG-172**(text-tools 无 rate limit):本 PR 的 route 正好在动,可以顺手加 `rateLimit({ key: \`texttool:\${userId}\`, limit: 30, window: 60 })`。解决"侧信道 oracle"风险 + 防止 BUG-132 systemic 子问题。

### 同期不建议合并

- BUG-133(Zod schema max systemic):不同层面问题,单独 PR 更清晰

---

## 8. 部署风险

| 风险 | 评估 |
|------|------|
| 向后兼容 | 现有客户端如果发 malformed header,本次起会 400。**查 prod 日志**:过去 7 天有多少 `POST /mini-tools/text` 带 Idempotency-Key 且不符 pattern?预期 **0**(前端代码里无地方发此 header) |
| Stream 已开始后 throw | 方案 B 的 throw 只在"route guard 失效"场景发生(理论上应 0 次)。真发生时:stream 产 event `{type:"error"}`,用户收到部分文本 + error message。与"静默成功"相比,用户体验 strictly better |
| Redis / DB down 场景 | 方案 B 保留了 soft-fail(return 0),此类真 infra 故障不变 |
| 测试 | `pnpm test core` 15/15 应通过(单测只改 deductForTokens 行为,边界清楚)+ 新增 11 个 case |

---

## 9. 相关

- **BUG-079**(已关,PR #128):同一类"扣费绕过"但在不同 path。修 BUG-079 时 `deductOnce` 本身的 REFKEY_PATTERN guard 做得对,但**调用者没学教训**—— text-tool 这条路径在 PR #128 里新接入,却没把 client-controlled input 先 validate。BUG-173 就是 PR #128 的遗漏补丁。
- **CLAUDE.md #5 升级**(commit `06314f4`):团队正在执行"zero tolerance for patch"。本 fix 方案 A-2 + B 组合严格对齐此标准。
- **Round 7 audit**(2026-04-23):本 bug 的 audit 源。agent 原判 MED,主 session 上调 P0。

---

**提交渠道建议**:本文件当前在 `bugs_list` 分支 `docs/internal/audit/fix-plans/` 目录。合并进 main 后 dev 可以参考;或 dev 直接在自己 fix PR 里引用。
