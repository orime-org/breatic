# Test Mandate — smoke / E2E 验证规范(MANDATORY)

> CLAUDE.md 头号原则「每次完成任务必须测试」的操作细则。
> TDD(单测 / 集成的红绿蓝节奏 + anti-pattern 防御)见 [TDD-MANDATE.md](./TDD-MANDATE.md);
> **本文管 ship 前的端到端验证(smoke / E2E)** —— 即「真的能跑吗」这一关。

## 1. 测试五层(从轻到重)

| 层 | 工具 | 查什么 | 何时 |
|---|---|---|---|
| typecheck | `pnpm turbo typecheck`(`tsc --noEmit`) | 类型对不对 | 每 PR |
| lint | `pnpm turbo lint`(`eslint`) | 代码规范 + 常见坑 | 每 PR |
| unit | `vitest` | 函数 / 组件,mock 依赖 | 写代码时 TDD 红绿蓝 |
| integration | `vitest` `*.integration.test.ts` | 真 PG / Redis,**不 mock 关键路径** | 写代码时(碰 DB / 服务)|
| **smoke / E2E** | 起真实 runtime + 浏览器 | 端到端真跑 | **每 PR ship 前** |

前 4 层都**不算 smoke**。**typecheck + 单测全绿 ≠ 真能跑**(esbuild 转译、mock 依赖都可能掩盖真实 runtime 问题)—— 必须再过 smoke / E2E。

## 2. smoke(每 PR 必做;做不了必 explicit 说明,不许默默跳)

最小冒烟:起真实 runtime,确认改动真能跑起来。

| 改动端 | 必做 |
|---|---|
| 后端(server / worker / collab / core / shared)| `pnpm dev` 起服务 → 3 个 healthz(`:3001` `/healthz` · `:9101` · `:1235`)返 200 → 改动涉及的关键 endpoint 实测真返回(curl / 集成测试)|
| 前端(web)| `dev:web`(`:8000`)→ 浏览器(chrome-devtools MCP / Playwright)开**改动的页面** → 看真渲染 + 0 console error |
| 纯文档 / 配置 / 注释 | 免 smoke(无 runtime 行为变更)|

## 3. E2E(关键路径 + 核心用户流必有完整流程验证)

用浏览器 / 真客户端跑完整用户旅程,**不 mock 关键路径**。

- **关键路径 6 类**(CLAUDE.md):支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作 —— 改动碰到必跑对应 E2E
- **核心用户流**:注册 → 登录 → 建 project → canvas 节点 create → mini-tool apply → 分享 / 邀请
- **工具**:web Playwright(`pnpm --filter reagt-jike test:smoke`)/ chrome-devtools MCP(交互式驱动)/ Yjs 协作类场景需两个会话验证多端 sync
- **视觉改动**:必真浏览器 verify(看实际渲染,不靠文字描述),小批 ship + ground truth 对照(详见 [frontend.md](./frontend.md))

## 4. 边界

- **TDD vs smoke/E2E**:TDD(红绿蓝)= 写代码时的单测 / 集成,防回归;smoke/E2E = ship 前端到端确认 + **spec-gap 探测**(production / E2E / 用户反馈才是 spec gap 的真正 detector,不是 unit test —— 见 [TDD-MANDATE.md](./TDD-MANDATE.md))
- **不 mock 关键路径**:integration / E2E 把 DB / API / Stripe 等关键路径 mock 掉 = 假测,违规(见 [TDD-MANDATE.md](./TDD-MANDATE.md))
- **做不了必 explicit 说明**:环境 / 工具限制跑不了 smoke / E2E,必须明说理由,**不许默默跳过**(CLAUDE.md 头号原则测试表)
