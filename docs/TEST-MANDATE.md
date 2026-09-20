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
| integration | `vitest` `*.integration.test.ts` | 真依赖(PG / Redis / 回环上的真实 socket),**不 mock 关键路径** | 写代码时(碰 DB / 服务 / 传输层)|
| **visual** | 起真实 runtime + 浏览器 | 一个部件自己的行为 / 位置 / 尺寸 / 颜色 / 时序 | **每 PR ship 前**,默认那一档 |
| **smoke / E2E** | 起真实 runtime + 浏览器 | 端到端真跑 | **每 PR ship 前**,默认那一档;带场景标签的按 §2.2 |

前 4 层都**不算 smoke**。**typecheck + 单测全绿 ≠ 真能跑**(esbuild 转译、mock 依赖都可能掩盖真实 runtime 问题)—— 必须再过 smoke / E2E。

### 1.1 一条用例归哪一档(MANDATORY)

| 档 | 判据 | 住哪 |
|---|---|---|
| **smoke** | 走一条用户要办成的事,且跨至少两个部件或一次真实往返 | `packages/web/tests/smoke/` |
| **visual** | 钉一个部件自己的行为 / 位置 / 尺寸 / 颜色 / 时序 | `packages/web/tests/visual/` |
| **unit** | 不需要真浏览器 | 被测对象同级的 `__tests__/` |

**只有一次真实往返才会让那个东西出现在页面上的用例才是 smoke。** 一条用例需要第二个连接只是为了移动一个目标(另一个人在拖、在选),它仍然是 visual —— 被钉住的还是这一端画出来的样子。

判定题:**这条用例如果只在一个部件里跑,还成立吗?成立 → visual。**

## 2. smoke(做不了必 explicit 说明,不许默默跳)

最小冒烟:起真实 runtime,确认改动真能跑起来。

| 改动端 | 必做 |
|---|---|
| 后端(server / worker / collab / core / shared)| `pnpm dev` 起服务 → 3 个 healthz(`:3001` `/healthz` · `:9101` · `:1235`)返 200 → 改动涉及的关键 endpoint 实测真返回(curl / 集成测试)|
| 前端(web)| `pnpm --filter @breatic/web dev`(`:8000`)→ 浏览器(chrome-devtools MCP / Playwright)开**改动的页面** → 看真渲染 + 0 console error |
| 纯文档 / 配置 / 注释 | 免 smoke(无 runtime 行为变更)|

### 2.1 套件自己准备它要的一切

`pnpm --filter @breatic/web test:smoke` 不需要任何事先配置:setup 自己注册两个账号、建它们的 studio 和 project,把凭据写进 `playwright/.auth/`(已 gitignore)。第一次跑和数据库被清空之后跑走同一条路。**只对本机**——setup 会注册账号、会删 project,所以它拒绝对着 localhost 以外的地址跑。

### 2.2 要外部服务的用例:声明、默认不跑、发布前必须跑(MANDATORY)

一条用例真的去打模型 / 公网 / R2 / ingest Worker / 声音目录 / Stripe / Brave / 本机 ffmpeg,就在 `test()` 名字末尾挂标签:

| 标签 | 要什么 | 谁在发布前签它 |
|---|---|---|
| `@needs-model` | 真实模型 provider | 做 agent 与生成那块的 CC |
| `@needs-internet` | 公网站点 | 跟着它所在用例的那块走 |
| `@needs-storage` | R2 | 做上传那块的 CC |
| `@needs-ingest` | ingest Worker | 做上传那块的 CC |
| `@needs-tts` | ElevenLabs / Fish 声音目录 | 做 agent 与生成那块的 CC |
| `@needs-payments` | Stripe 与积分包 | 做支付那块的 CC |
| `@needs-search` | Brave | 做 agent 与生成那块的 CC |
| `@needs-ffmpeg` | 本机 ffmpeg | 做上传那块的 CC |

**判据是用例做了什么,不是它叫什么。** 拦截了请求的用例到不了它背后那个服务;一个登录过的账号和一个 project 是 setup 的活,不算外部场景。**共享一个 page 的文件里,标签要么全带要么全不带**——只给真去打服务的那几条挂标签,`--grep-invert` 把它们排除之后,同文件其余用例会跑在没人给它铺过路的页面上。

| 命令 | 跑什么 |
|---|---|
| `pnpm test:smoke` / `pnpm test:visual` | 默认档:不带标签的那些。**每 PR 必跑,任何一台干净机器上都要全绿** |
| `pnpm test:smoke:all` / `pnpm test:visual:all` | 全部,含带标签的 |
| `playwright test --project=smoke --grep "@needs-<标签>"` | 单个子门 |

**每个 PR 跑两条命令,分开跑**:`pnpm test:smoke`,外加自己那块的子门。**两条不能合成一条**——`--grep` 和 `--grep-invert` 是与的关系且排除优先,合并之后交集为空,一条都跑不到(playwright 1.62.1 实测 `Total: 0 tests`)。

**交付门按标签切成子门**,发布前由上表里归属的 CC 各自签,签完才算这一轮的门过了。没有任何一台机器同时具备全部场景,所以不存在「一台机器跑 `test:smoke:all` 全绿」这个门。

默认档的运行会印出它排除了什么(`覆盖 N 条,共 M 条;排除 K 条:@needs-… `)。**被排除的用例在报告里连一行都没有**,所以那行是唯一能让人知道这个绿盖了多少的地方。

### 2.3 写一条 smoke 的七条(MANDATORY)

| 条 | 规则 | 守卫 |
|---|---|---|
| 一 | 先按 §1.1 判档。判成 visual 或 unit 的不许写进 `tests/smoke/` | 人判 |
| 二 | 自己造它要的一切:project 从 `tests/helpers/project.ts` 取,Space 自己建自己删,素材用仓内固定文件 | `breatic/no-borrowed-project` |
| 三 | 不打公网 | `breatic/no-untagged-public-host` |
| 四 | 要外部服务的按 §2.2 打标签 | `breatic/declared-scenario-tags` |
| 五 | 不用条件 `test.skip`,文件作用域的也不行 | `breatic/no-runtime-test-skip` |
| 六 | 不依赖同文件里别的用例留下的东西 | 人判 |
| 七 | 写完做一次变异:把被测行为改坏,确认它真的红 | 人判 |

第六条守卫看不见,而它是拆开共享开局时冒出来最多的一类:一条用例读上一条留在页面上或留在账号那条会话里的东西,拆开之后要么当场红,要么在什么都没发生的情况下恒为真。判定题:**这条用例断言的那个东西,是它自己放上去的吗?**

第七条同理:有断言不等于断言得到东西。`expect(panelText.length).toBeGreaterThan(0)` 这种在产品坏掉时照样绿。

第五条的两种落点后果一样:用例体里的那一句吃掉这一条,文件顶上的那一句吃掉整个文件,报告两次都写「skipped」而退出码是零。2026-09-19 实测:文件顶上一行 `test.skip(!email || !password, ...)` 换来 12 passed / 289 skipped 和一个零退出码。名字带 body 的 `test.skip('标题', async () => {})` 不在此列——它在报告里有自己的标题,谁都看得见。

**两档都禁 `test.describe.configure({ mode: 'serial' })`**(`breatic/no-serial-tests`)。一条红让同组后面的用例整批不执行——2026-09-19 实测一轮 54 条未执行,其中 44 条出自一个文件。

**超时只有一个数:project 的那个**(`playwright.config.ts`,两档都是 180s)。playwright 的 `test.setTimeout` 是**赋值**不是取大(`playwright/lib/common/index.js:2413`),所以一句写在文件顶上的 `test.setTimeout(90_000)` 把 180 秒降成了 90 秒,而它旁边的注释多半写着「抬高」。判定题:**我要写的这个数,比 project 的大吗?** 不大就别写;大才写,并在同一行说清哪一步要花这么久。

**一台机器上一次只跑一轮。** setup 开局会把上一轮留下的 Project 扫掉(`account.setup.ts` 的 `removeOlderRuns`),而它分不出「上一轮扔下的」和「另一轮正在用的」。smoke 和 visual 同时开两个进程,后起的那个会删掉先起的那个正在用的 Project。

## 3. E2E(关键路径 + 核心用户流必有完整流程验证)

用浏览器 / 真客户端跑完整用户旅程,**不 mock 关键路径**。

- **关键路径 6 类**(CLAUDE.md):支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作 —— 改动碰到必跑对应 E2E
- **核心用户流**:注册 → 登录 → 建 project → canvas 节点 create → mini-tool apply → 邀请
- **工具**:web Playwright(`pnpm --filter @breatic/web test:smoke`)/ chrome-devtools MCP(交互式驱动)/ Yjs 协作类场景需两个会话验证多端 sync
- **视觉改动**:必真浏览器 verify(看实际渲染,不靠文字描述),小批 ship + ground truth 对照(详见 [ARCHITECTURE.md#frontend](./ARCHITECTURE.md#frontend))
- **建了什么就删掉什么(MANDATORY)**:spec 在套件的账号里建的东西(Space / 节点)一律在 `afterEach` 里删掉。**每条用例各建一个是对的**(不依赖上一次跑剩下的东西),但**留着就是错的** —— 一个 project 把它们全打开就每份文档占一个可写席位,collab 对此有上限(`packages/collab/src/services/connection-registry.ts`),超了那个 Space 只读、只读提示条吞掉用例的点击;而同一个账号被所有 spec 反复跑:实测一次全套建 32 个 Space,攒到 86 个时标签栏全是测试垃圾。判定题:**这条 spec 建了什么下次跑还看得见的东西吗?建了 → 它自己负责删。** 建和删走同一份实现(`packages/web/tests/helpers/space.ts`),别每个 spec 各写一遍;**删要走用户真实路径**(Space 的删除是 collab 的 `space:delete` RPC,鉴权和审计都在服务端,ADR 2026-05-23 yjs-collab-only-write-authz 禁止客户端直写 `meta.spaces`)。project 归 setup 和 teardown 管:setup 每轮建、teardown 每轮删,而且它扫掉更早的运行留下的(一轮被中断就会留下,而 project 也有上限)

## 4. 边界

- **TDD vs smoke/E2E**:TDD(红绿蓝)= 写代码时的单测 / 集成,防回归;smoke/E2E = ship 前端到端确认 + **spec-gap 探测**(production / E2E / 用户反馈才是 spec gap 的真正 detector,不是 unit test —— 见 [TDD-MANDATE.md](./TDD-MANDATE.md))
- **不 mock 关键路径**:integration / E2E 把 DB / API / Stripe 等关键路径 mock 掉 = 假测,违规(见 [TDD-MANDATE.md](./TDD-MANDATE.md))
- **做不了必 explicit 说明**:环境 / 工具限制跑不了 smoke / E2E,必须明说理由,**不许默默跳过**(CLAUDE.md 头号原则测试表)
