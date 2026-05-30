# Test-Driven Development (TDD) — AI coding 时代完整 mandate

> **CLAUDE.md** 的 "Test-Driven Development" 章节是项目级 TDD 硬约束。本文档是**完整参考**:详细 anti-pattern / property-based 工具 / 衔接 DD / 衔接 audit / 业界印证。
>
> DD → TDD 衔接图详见 [docs/DD-PROCESS.md](./DD-PROCESS.md) 第 10 节。
>
> **边界**:本文管**单测 / 集成的红绿蓝节奏**(测试五层中的 unit / integration 两层);ship 前 **smoke / E2E 端到端验证**(测试五层最上层)见 [docs/TEST-MANDATE.md](./TEST-MANDATE.md)。

## 业界共识(为什么 TDD 在 AI 时代升级而非过时)

| 来源 | 关键引用 |
|---|---|
| [Anthropic Best Practices](https://code.claude.com/docs/en/best-practices) | *"Give Claude a way to verify its work. This is the single highest-leverage thing you can do."* |
| [Anthropic Best Practices](https://code.claude.com/docs/en/best-practices) | *"Always provide verification (tests, scripts, screenshots). If you can't verify it, don't ship it."* |
| [Anthropic Best Practices](https://code.claude.com/docs/en/best-practices) | *"You can do something similar with tests: have one Claude write tests, then another write code to pass them."*(Writer/Reviewer pattern) |
| [Pragmatic Engineer × Kent Beck](https://newsletter.pragmaticengineer.com/p/tdd-ai-agents-and-coding-with-kent) | *"TDD is a 'superpower' when working with AI agents."* |
| [Kent Beck — Augmented Coding](https://tidyfirst.substack.com/p/augmented-coding-beyond-the-vibes) | *"Having trouble stopping AI agents from deleting tests in order to make them 'pass!'"*(cheating warning) |
| [DEV.to case study](https://dev.to/markk40123/when-generated-tests-pass-but-miss-the-bug-a-case-of-false-confidence-from-ai-test-generation-1674) | AI 生成测试 *"asserted the wrong properties: equality on serialized outputs instead of structural invariants"* → false confidence |

## 5 条硬约束(详细)

### 约束 1 — 修 bug 必须先写复现测试

**业界印证**:Anthropic 官方 *"address root causes, not symptoms"* + DEV.to false confidence case study(团队漏抓 production edge case 因为没复现 test)。

**实操**:
- bug → 写 failing test 复现 → 修代码到 test green → commit
- 没有"先看到 fail 再修" 直接给 fix = 违反 CLAUDE.md #5(治标补丁)

### 约束 2 — spec 由 audit / 人写,test 代码由 dev 写

**业界印证**:[Anthropic 官方文档](https://code.claude.com/docs/en/best-practices) 直接 quote:

> *"You can do something similar with tests: have one Claude write tests, then another write code to pass them."*

> *"Multiple sessions enable quality-focused workflows. A fresh context improves code review since Claude won't be biased toward code it just wrote."*

**Breatic 实操**:
- audit session(`bugs_list` 角色)写 spec 到 `bugs/audit/round-N-found.md`,含 input / expected / 边界 / pass / fail
- dev session(fix branch)按 spec 写 `*.test.ts` / `pytest`
- audit 不替 dev 写 test code,dev 不绕过 audit 自己定义 spec

### 约束 3 — 重构前测试必须 green

防 AI 偷换语义。AI 重构容易"形式 OK 但语义偷换"(改名 X→Y 顺手改了类型 / 边界 / 默认值)。

**实操**:
- 重构前:全套 test 必须 green
- 重构中:每一步小改后跑测试
- 重构后:测试全 green = OK;test fail 立刻 revert,不调整 test "让它过"

### 约束 4 — 禁止 AI 通过删除 / 禁用测试通过

**业界印证**:Kent Beck 明确 cheating warning:*"having trouble stopping AI agents from deleting tests in order to make them 'pass!'"*

**实操(CI / pre-commit)**:
- 监控 test 总数(每个 commit 之间对比)
- 异常下降(> 10% 文件数下降)→ pre-commit hook 阻止 + 提示
- CI 报警 webhook 通知 maintainer

### 约束 5 — 单一 AI session 不能同时写 spec + test + 实现

强制反闭环。

**机制**:
- spec 由 audit 写或 user 写
- test 代码由 dev 写,可以是同 dev 但**禁止**同 session 既定义 expected 又写实现
- 多 session 隔离(参考 [Anthropic 官方 Multi-session pattern](https://code.claude.com/docs/en/best-practices)):一个 session 写 test,另一个写实现

## TDD 节奏(production code 适用)

```
红(failing test) → 绿(最小实现) → 蓝(重构 + 跑全套)
   ↑                                    ↓
   └─── 失败 → 重做 DD ─────────────────┘
        (DD 假设错时,违反 #5 不打补丁)
```

### 红 — 具体 assertion

**禁止 weak assertion**(AI 倾向写出来):
- ❌ `expect(result).toBeDefined()`(没具体 expected 值)
- ❌ `expect(result).toBeTruthy()`(没具体 expected 值)
- ❌ `expect(result).not.toBeNull()`(同上)

**强 assertion**:
- ✅ `expect(result).toEqual({ id: '123', status: 'paid' })`
- ✅ `expect(result.balance).toBe(100)`
- ✅ `expect(transactions).toHaveLength(3)`

### 绿 — 最小实现

写**最少代码**让 test 过。注意 AI 倾向 over-engineer(加 try-catch / 防御性 null check / 多层抽象)—— 在 TDD 绿色阶段反而要克制。

### 蓝 — 重构 + 跑全套

测试 green 后才重构。重构后跑**全套** test,不只是当前文件的 test。

### 例外:原型 / explore 阶段

Production code 严禁"先实现再补 test"。但**原型 / spike / explore** 允许后置 test(因为方向未明,先试再补)。

判定:**这段代码会进 main / 上 production 吗?** 会 → TDD;不会(只是试) → 后置 OK。

## 测试质量优于覆盖率数字

业界共识:**测试质量(strong assertion / 显式 invariant)比覆盖率数字更重要**。

| 类别 | 标准 |
|---|---|
| **关键路径** (见下) | 100% + 显式 invariant + property-based |
| **业务逻辑** | unit test + integration test |
| **UI 组件** | 优先 E2E(Playwright),unit test 按需 |
| **配置 / 类型定义** | 不强求测试 |
| **整体覆盖率** | < 80% 不是 hard block,**关键路径裸奔 = P0 BUG** |

### 关键路径定义(6 类)

1. **支付**(Stripe webhook / 扣费 / 退款)
2. **鉴权**(login / OAuth / token / session / 跨租户)
3. **数据完整性**(soft delete / 级联 / FK)
4. **AI tool call**(spawn / run_script / web_fetch / web_search)
5. **积分扣减**(deductCredits / deductOnce 幂等)
6. **Yjs 协作同步**(canvas / textEditor / mixedEditor 节点同步)

每个关键路径必须有 100% test 覆盖 + 显式 invariant assertion。

## 反 AI coding anti-pattern(详细)

### Anti-pattern 1 — single session 闭环

❌ AI session 同时写 spec(注释 / type 定义 expected) + test code + 实现代码 → 闭环 hallucination 风险。

✅ spec 来源外部(audit / human),test code 由 AI 写但只 codify 给定 spec,不自定义 expected。

### Anti-pattern 2 — Weak assertion 凑数

❌ `expect(result).toBeDefined()`、`expect(result).toBeTruthy()`、`expect(arr.length).toBeGreaterThan(0)`

✅ `expect(result).toEqual(specificValue)`,`expect(arr).toHaveLength(3)` + 内容 deep equal

### Anti-pattern 3 — 先实现再补 test

❌ Production code "先写实现 → 测试覆盖率不够 → 后置补 test"

✅ Production code 严格 TDD;原型阶段允许后置(明确标记)

### Anti-pattern 4 — 修 bug 不写复现 test

❌ "看到 bug → 直接给 fix → commit"(AI 补丁式修复 anti-pattern,Anthropic 明确 warning)

✅ "bug → failing test 复现 → 修 → test green → commit"

### Anti-pattern 5 — 大段 mock 关键路径

❌ Integration / E2E test 中把数据库 / API / Stripe 等关键路径 mock 掉,test 实际只测 mock 行为

✅ Integration / E2E **不 mock 关键路径**;mock 只用于 unit test 的 dependency isolation

### Anti-pattern 6 — AI 生成测试视为终态

❌ AI 一次性生成 N 个 test,直接 commit(canonical setup/call/assert pattern,可能漏关键 invariant)

✅ AI 生成测试视为 **draft**,人或 audit review 时显式审:
   - 测的 invariant 是 business-critical 的吗?
   - 漏了哪些边界条件?
   - assertion 是否过于"形式正确"但语义不严?

来源:[DEV.to case study](https://dev.to/markk40123/when-generated-tests-pass-but-miss-the-bug-a-case-of-false-confidence-from-ai-test-generation-1674) — *"Generated tests should be treated as a draft."*

## 显式 invariant + Property-based testing(关键路径必备)

### 为什么需要 invariant testing

DEV.to case study 教训:AI 生成测试**倾向 reproduce canonical setup/call/assert pattern,不会 reason about 哪些 invariant 真正重要**。

修复方式:**显式列出 invariants** + 用 property-based testing 框架覆盖。

### 常见 invariant 类型

| Invariant | 例子 |
|---|---|
| **Idempotency** | `f(f(x)) == f(x)`(如 deductOnce 重复调用结果一致) |
| **Order-independence** | `merge(a, b) == merge(b, a)`(如 Yjs CRDT) |
| **Escaping** | `unescape(escape(x)) == x`(如 sanitize/render 双向一致) |
| **Monotonic** | `t1 < t2 → state(t1) ≤ state(t2)`(如积分余额单调) |
| **Commutative** | `f(a, b) == f(b, a)`(如 set union) |
| **Roundtrip** | `decode(encode(x)) == x`(如 JSON / Y.Doc serialize) |

### 工具

- **TypeScript**:[`fast-check`](https://github.com/dubzzz/fast-check) — property-based testing 主流
- **Python**:[`hypothesis`](https://hypothesis.readthedocs.io/) — property-based testing 主流
- **Go**:[`gopter`](https://github.com/leanovate/gopter)

### 示例(`fast-check`)

```typescript
import fc from 'fast-check';

it('deductOnce is idempotent', () => {
  fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1 }),
      fc.integer({ min: 1, max: 1000 }),
      async (refKey, amount) => {
        const before = await getBalance(userId);
        await deductOnce(userId, amount, refKey);
        const after1 = await getBalance(userId);
        // Idempotency: 同 refKey 第二次调用余额不变
        await deductOnce(userId, amount, refKey);
        const after2 = await getBalance(userId);
        return after1 === after2;
      }
    )
  );
});
```

## 衔接 DD

DD 锁定方案后走 TDD。完整衔接见 [docs/DD-PROCESS.md](./DD-PROCESS.md) 第 10 节。

**关键约束**:TDD 中发现 DD 假设错(test 无论如何写不通)→ **停下重做 DD**,不在错假设上打补丁(违反 CLAUDE.md #5)。

## 衔接 audit 角色

### 角色边界

| 角色 | 写什么 | 不写什么 |
|---|---|---|
| **audit** | 测试 spec(input / expected / 边界 / pass / fail / 边界条件) | 测试代码 |
| **dev** | 测试代码(`*.test.ts` / `pytest`) + 实现 | spec(spec 来源 audit / human) |

### 流程

1. audit 写 spec(input / expected / 边界条件)
2. dev 在 fix branch 实现 + 写 test code
3. audit 在 PR review 核查 test code 是否 codify spec(input/expected 一致)
4. PR merge 后 audit 关闭对应 BUG

## TDD 失败的处理

| 现象 | 多半原因 | 正确做法 |
|---|---|---|
| Test 无论如何写不通 | DD 假设错(spec 与现实不符) | **回到 DD 阶段重审假设**,可能要重开 DD |
| Test 一会过一会不过 | flaky test(timing / 随机性 / shared state) | 修 test(用 deterministic seed / mock time / isolation) |
| Test 通过但 production fail | spec gap(未覆盖的 edge case) | 写复现 test → 修 → 加进 spec |

**禁止**:
- ❌ "修 test 让它过"(可能是 cheating)
- ❌ "调实现迎合 test"(可能是错调实现)
- ❌ 删除 / disable 失败 test(违反约束 4)

## 反 false confidence 文化

业界共识:测试通过 ≠ 信任,只是 known-good。breatic 文化补充:

1. **production / E2E / 用户反馈是 spec gap 的真正 detector**,不是 unit test
2. **任何"测试都过了但生产挂了"事故必须 RCA**(同 R9 BUG-188 模式),调查 spec gap 来源
3. **观测性投入(metrics / logs / tracing)是 spec gap 的兜底机制**(参考 BUG-152 / BUG-150 等可观测性 BUG)
4. **定期 prune 测试套件**(每月 audit weak assertion / 重复测试 / 过时 fixture) — 防 debt 雪球
5. **测试通过的代码仍可能有 unknown unknown gap** — 定期做 fuzz / mutation testing 主动暴露

## 监控 / Enforcement

- **CI test 总数监控**:每 commit 对比 test 总数,异常下降 > 10% 阻止 merge(防约束 4 违规)
- **覆盖率门槛**:整体 < 80% warn(不 block),关键路径 < 100% block
- **audit 抽查**:每月 audit 一次随机抽 5 个 PR 看 test code 是否 codify spec(防约束 2 违规)
- **production incident RCA**:任何 production bug 必须查"为什么 test 没抓到" → 写入 lessons learned

## 参考资料

### 业界文档
- [Anthropic — Best Practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Anthropic — How teams use Claude Code](https://claude.com/blog/how-anthropic-teams-use-claude-code)
- [Pragmatic Engineer — TDD, AI agents and coding with Kent Beck](https://newsletter.pragmaticengineer.com/p/tdd-ai-agents-and-coding-with-kent)
- [Kent Beck — Augmented Coding: Beyond the Vibes](https://tidyfirst.substack.com/p/augmented-coding-beyond-the-vibes)
- [DEV.to — When Generated Tests Pass but Miss the Bug](https://dev.to/markk40123/when-generated-tests-pass-but-miss-the-bug-a-case-of-false-confidence-from-ai-test-generation-1674)
- [Aider docs](https://aider.chat/)

### 工具
- [`fast-check`](https://github.com/dubzzz/fast-check) — property-based testing for TS
- [`hypothesis`](https://hypothesis.readthedocs.io/) — property-based testing for Python
- [`stryker-mutator`](https://stryker-mutator.io/) — mutation testing for JS/TS
- [Vitest](https://vitest.dev/) / [Jest](https://jestjs.io/) — TS test framework

### 项目内文档
- DD 流程:[docs/DD-PROCESS.md](./DD-PROCESS.md)(第 10 节衔接 TDD)
- smoke / E2E ship 验证:[docs/TEST-MANDATE.md](./TEST-MANDATE.md)(测试五层 / smoke 定义 / 关键路径 E2E / 边界)
