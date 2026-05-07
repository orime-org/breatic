# Due Diligence (DD) — 完整流程文档

> **本文是 DD 流程的完整参考**(详细模板 + 反例 + 衔接图)。 CLAUDE.md 中的 DD 章节是项目级 mandate(必读),本文是 dev 实际执行 DD 时的操作手册。

## 1. 什么算"重大决策"(任一即触发 DD)

- 影响**安全模型**(凭据存储 / 协议鉴权 / 外部网络 / 用户数据)
- 影响**长期维护负担**(核心依赖 / 协议层 / 数据层)
- 影响范围**超过单个 package**(跨包接口 / 共享类型 / 全局状态)
- **反悔代价 > 1 周工作量**

### Breatic 高频场景示例

以下是上述触发的**具体化示例**,不是新增 mandate:

| 高频场景 | 对应触发 |
|---|---|
| AIGC provider 选型(image / video / audio / 3d / tts / understand 模型路由) | 长期维护 + 跨 package |
| Agent / Skill 定义变更(system prompt / tools 列表) | 安全模型(prompt injection)+ 长期维护 |
| 核心架构变更(三层记忆 / Turn 压缩 / Yjs 结构 / Redis Streams) | 长期维护 + 跨包 |
| 积分 / 计费机制(pricing / Stripe webhook / 扣费幂等) | 安全模型 + 反悔代价 |
| 部署形态变更(Docker / nginx / CI 流水线) | 长期维护 + 反悔代价 |

## 2. 两类 DD

| 类型 | 适用 | 流程 |
|---|---|---|
| **A. 选型 DD**(5 步全套) | 多候选选择题(哪个库 / 架构 / 路径) | 第 3 节 |
| **B. 事实验证 DD**(轻量版) | "假设 X 成立吗" 类问题(hook 行为 / API schema / 协议字段填充率) | 第 4 节 |

## 3. 选型 DD 的 5 步流程

### Step 1 — 候选枚举

穷举所有可见候选,**包括但不限于**:

- `from scratch`(自己实现)
- vendor in(把第三方代码搬进 package)
- npm / pip / cargo depend(直接依赖)
- 第三方 API 调用
- 跨语言抄(借 Go / Rust 实现)
- 已有 breatic 内部代码可复用

**禁止**只列 2-3 个候选(假对比)。即使某些候选明显劣,也要列出+给筛选理由。

### Step 2 — 每候选尽调(5 维度)

对每个候选,从 5 个维度收集**可引用证据**:

| 维度 | 检查内容 | 证据形态 |
|---|---|---|
| **实测** | 能装能跑?核心 path 通? | demo test commit hash + 跑通日志 |
| **源码** | 体量(行数 / 文件数)/ 模块化 / 测试覆盖 / 依赖清单 | GitHub stats / `cloc` / `npm view` |
| **治理** | commit 频率 / issue 响应 / 维护者画像 / license | GitHub Insights / GitHub Pulse / SPDX |
| **安全** | 外部 HTTP / 用户数据上传 / 已知 CVE / 沙盒越狱 | Snyk / GitHub Security / npm audit |
| **上游跟进** | 协议变化时这个仓库的反应速度(如适用) | 历史 release note 时间分布 |

**禁止**填"印象 / 感觉",必须可追溯到具体证据。

### Step 3 — 对比矩阵

候选 × 维度 → 表格。每格 cell **必须填**:

- 实证数据(数字 / 状态)
- 引用 link(commit hash / GitHub link / log 路径 / Snyk advisory ID)

**禁止**留空 cell 或填"待补"。无证据就明确写"未找到 / 不确定",不要装作有数据。

### Step 4 — 推荐 + 理由

每条推荐理由**必须可追溯到矩阵某格证据**。

格式:

```
推荐:候选 X
理由:
1. <理由 A> — 证据:矩阵第 N 行 M 列
2. <理由 B> — 证据:...
3. ...
```

**禁止**单点论据(只引一格)。**禁止**总结性陈述(如"它 stateless 所以好",但 stateless 不是矩阵 cell)。

### Step 5 — 用户决定

- DD 报告 commit 入仓库前,**必须经过用户(maintainer)review + 显式拍板**
- 用户拍板时间 + 依据写入 DD 报告"用户决定"段
- 锁定到 CLAUDE.md / 其他相关 docs(如适用)

## 4. 事实验证 DD(针对"假设"而非"选型")

适用场景:"假设 X 成立吗"类问题(如:hook 行为 / API schema / 协议字段填充率 / 性能假设)。

### 流程

1. **假设清单** —— 列出 N 条具体假设(每条带 ID,如 H1 / H2)
2. **实测方法** —— 每条假设的实测脚本 / 命令 / 输入
3. **实测结果** —— 实际数据
4. **假设状态升级表** —— 每条假设标 ✅ 验证 / ❌ 推翻 / ⚠️ 部分

### 输出

仍归档到 `docs/dd/<YYYY-MM-DD>-<topic>-dd.md`,但**不需要候选枚举 / 对比矩阵**(不是选择题)。

## 5. 反 DD 模式(一律违规)

| 反 pattern | 表现 |
|---|---|
| **浅表决策** | 凭 star 数 / README / "感觉合适" / share 对话拍板 |
| **hearsay 升格** | 把 AI 对话(含 ChatGPT / Claude share)当 ground truth |
| **假对比** | 跳过候选枚举只列 2-3 个 |
| **单点论据** | 推荐时引用单一证据(如"它 stateless 所以好") |
| **治标补丁** | 提议"先用 X 后续再换"(违反 CLAUDE.md #5) |

## 6. DD 文档要求

### 保存位置

| 文档类型 | 位置 | 性质 |
|---|---|---|
| 公开选型 DD(技术栈 / OSS 库) | `docs/dd/<YYYY-MM-DD>-<topic>-dd.md` | OSS contributor 可见,透明信号 |
| 敏感选型 DD(vendor 关系 / 内部成本 / 安全模型) | 团队私有 channel(Notion / 内部 wiki / private repo) | **不入公开仓库** |
| 事实验证 DD | `docs/dd/<YYYY-MM-DD>-<topic>-verify.md` | 同选型 |

### 命名规范

- `<YYYY-MM-DD>-<topic>-dd.md`(选型)
- `<YYYY-MM-DD>-<topic>-verify.md`(事实验证)
- topic 用 lowercase + dash 分隔,描述精确(`yjs-collab-protocol-dd.md` 不是 `yjs-dd.md`)

### 强制要求

- **跟设计 doc / PR 一起 commit**(**不进 git = 没真正 DD 完**)
- **每个论断必须可追溯到具体证据**(commit hash / issue 链接 / log / 实测产物路径)
- DD 报告完成后,在相关 PR description 中 link 到 DD 报告
- audit role 在 PR review 时核查 DD 是否合规(详见 [breatic-inner CLAUDE.md L13](https://github.com/orime-org/breatic-inner) audit enforcement 章节)

## 7. 违规成本

> 未做 DD 就动手 = **违反纪律 = 当场撤回**。
> 绕开 DD 的方案 = **治标补丁 = 对用户时间的犯罪**(用户耗费精力识别、拆穿、重提需求)。
> 发现自己写了未 DD 的方案 → 立即撤回、重做,**不许辩护、不许找理由、不许谈工作量**。

## 8. 合格 DD 报告骨架

```markdown
# <Topic> DD 报告

**Topic**: <一句话>
**Date**: YYYY-MM-DD
**Status**: ✅ 已锁定 / 🟡 进行中 / ❌ 已废弃
**结论**: <一句话方案 + 关键证据 1-3 条>

## 候选枚举(第 1 步)

<穷举表 + 每个候选的筛选理由>

## 5 维度尽调(第 2 步)

### 候选 A
- **实测**:...
- **源码**:...
- **治理**:...
- **安全**:...
- **上游跟进**:...

### 候选 B
...

(per-candidate 数据 + 引用证据 inline)

## 对比矩阵(第 3 步)

| 维度 | 候选 A | 候选 B | 候选 C |
|---|---|---|---|
| 实测 | ... (commit hash / log 链接) | ... | ... |
| 源码 | ... | ... | ... |
| 治理 | ... | ... | ... |
| 安全 | ... | ... | ... |
| 上游跟进 | ... | ... | ... |

## 推荐 + 理由(第 4 步)

**推荐:候选 X**

1. <理由 1> — 证据:矩阵第 X 行 Y 列
2. <理由 2> — 证据:...

## 用户决定(第 5 步)

- **拍板时间**:YYYY-MM-DD
- **拍板依据**:<引用上面理由序号 + 任何额外考虑>

## 实施清单 / 风险与缓解 / 参考资料

(按需填写)
```

## 9. DD vs 普通设计的区别

| | 普通设计 | DD |
|---|---|---|
| **过程** | 你想了一下觉得 X 合理 → 写代码 | 穷举所有 X 替代品 → 用数据比较 → 给用户可质疑的推荐 → 用户拍板 → 才写代码 |
| **输出** | 代码 + commit message | DD 报告(可被审计 / 反驳) + 用户拍板 + 代码 |
| **本质** | 经验直觉 | **强迫自己跳出第一直觉,看见自己没看见的可能性** |

DD 的本质**不是流程仪式感**,而是**强迫看见自己没看见的可能性**。

如果你做 DD 后发现"哦原来还有这条路"或"哦那个候选其实更合适",DD 就成功了。如果做完后觉得"果然还是我最初想的那个" — 仍 OK,但要诚实问"我是真的对比了,还是只是 confirmation bias"。

## 10. DD → TDD 衔接

DD 锁定方案后,实施时走 TDD 节奏(详见 [CLAUDE.md "Test-Driven Development" 章节](../CLAUDE.md#test-driven-development-tdd--ai-coding-时代版))。本节描述 DD 与 TDD 的边界、衔接、AI 时代的反闭环约束。

### 衔接图

```
DD 锁定方案 → TDD 写代码(红 → 绿 → 蓝)→ 关键路径 100% + invariant 覆盖 → CI 强制 → commit
   ↑                                                              ↓
   └─── 实施中发现 DD 假设错 → 停下重做 DD ─────────────────────────┘
        (不在错假设上打补丁,违反 #5)
```

### DD vs TDD 边界

| 维度 | DD | TDD |
|---|---|---|
| **阶段** | 决策前 | 决策后实施 |
| **解决** | "做什么 / 选什么" | "实现是否正确" |
| **范围** | 对外部库 / 假设 / 跨包接口 | 对自己写的代码 |
| **节奏** | 候选枚举 / 尽调 / 矩阵 / 推荐 / 决定 | 红 → 绿 → 蓝 |

### 重叠场景

- **选型 DD 的"实测"维度** ≈ 迷你 TDD(候选库写一条 demo test 看核心 path 通)
- **事实验证 DD** 本身就有 TDD 节奏(声明假设 → 实测 → 看结果)
- **TDD 红色阶段写"会失败的测试"** = 半个事实验证 DD(用测试 codify 假设)

### AI 时代特别约束

业界共识(Anthropic / Kent Beck / case study)证实 AI coding 引入新风险,DD-TDD 衔接需注意:

1. **DD 假设错 → 立刻停 + 重做 DD** —— 实施中发现假设错,**禁止**在错假设上打 TDD 补丁(违反 #5)
2. **测试 cheat detection** —— TDD 阶段如果 AI 删 / 禁测试通过,警惕(Kent Beck 明确警告)
3. **测试 as draft mindset** —— AI 写的 TDD 测试是初稿,review 时显式审 invariant 是否覆盖真实约束
4. **Writer/Reviewer 强制分离** —— 一个 Claude session 不能同时定义 expected(spec)+ 写 test code + 写实现
   - Breatic 实践:audit 写 spec(`bugs/audit/round-N-found.md`),dev 写 test code,严格分离

### TDD 失败的处理

- TDD 中测试无论如何写不通 → 多半是 DD 假设错(spec 与现实不符)
- **不要**"修 test 让它过" 或 "调实现迎合 test" —— 都是补丁
- **正确做法**:回到 DD 阶段重审假设,可能要重开 DD(候选枚举 / 矩阵 / 重新拍板)

---

## 衔接到 audit 流程

audit role(`bugs_list` 分支 / `breatic-inner` 仓库)对 DD 的核查机制:

- 任何 PR / commit 改动满足 DD 触发条件之一时,audit 必须核查 PR description 是否含 DD 报告引用
- 无 DD 报告 → 记入 BUGS.md 流程类条目(类 R9 BUG-188 history rewrite 零 disclosure)
- audit 不替 dev 写 DD,只 catch 缺失

具体核查机制详见 [breatic-inner CLAUDE.md](https://github.com/orime-org/breatic-inner)(私有,access 申请 security@breatic.ai)。
