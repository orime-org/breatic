# Test Mandate — smoke / E2E 验证规范(MANDATORY)

> 仓库根 [AGENTS.md](../AGENTS.md#testing) 测试段里 smoke / E2E 要求的操作细则。
> TDD(单测 / 集成的红绿蓝节奏 + anti-pattern 防御)见 [TDD-MANDATE.md](./TDD-MANDATE.md);
> **本文管 ship 前的端到端验证(smoke / E2E)** —— 即「真的能跑吗」这一关。

## 1. 测试五层(从轻到重)

| 层 | 工具 | 查什么 | 何时 |
|---|---|---|---|
| typecheck | `pnpm turbo typecheck`(`tsc --noEmit`) | 类型对不对 | 每 PR |
| lint | `pnpm turbo lint`(`eslint`) | 代码规范 + 常见坑 | 每 PR |
| unit | `vitest` | 函数 / 组件,mock 依赖 | 写代码时 TDD 红绿蓝 |
| integration | `vitest` `*.integration.test.ts` | 真依赖(PG / Redis / 回环上的真实 socket),**不 mock 关键路径** | 写代码时(碰 DB / 服务 / 传输层)|
| **visual** | 起真实 runtime + 浏览器 | 一个部件自己的行为 / 位置 / 尺寸 / 颜色 / 时序 | **每 PR ship 前**,跑这次改动相关的那些(§2.2) |
| **smoke / E2E** | 起真实 runtime + 浏览器 | 端到端真跑 | **每 PR ship 前**,跑这次改动相关的那些(§2.2) |

前 4 层都**不算 smoke**。**typecheck + 单测全绿 ≠ 真能跑**(esbuild 转译、mock 依赖都可能掩盖真实 runtime 问题)—— 必须再过 smoke / E2E。

### 1.1 一条用例归哪一档(MANDATORY)

| 档 | 判据 | 住哪 |
|---|---|---|
| **smoke** | 走一条用户要办成的事,且跨至少两个部件或一次真实往返 | `packages/web/tests/smoke/`;同意窗口和发往分析、广告服务的请求在 `packages/web/tests/consent/`,它们要按厂商变量分别构建的两份前端 |
| **visual** | 钉一个部件自己的行为 / 位置 / 尺寸 / 颜色 / 时序 | `packages/web/tests/visual/` |
| **unit** | 不需要真浏览器 | 被测对象同级的 `__tests__/` |
| **integration**(只测一个包) | 要真依赖(PG / Redis / 回环 socket),被测代码都在一个包里 | 那个包自己的 `src/` 下(server 统一放 `src/__tests__/integration/`) |
| **integration**(跨服务) | 一次运行里驱动 server / worker / collab 中两个以上的代码 | `packages/integration-tests/src/__tests__/` |

**只有一次真实往返才会让那个东西出现在页面上的用例才是 smoke。** 一条用例需要第二个连接只是为了移动一个目标(另一个人在拖、在选),它仍然是 visual —— 被钉住的还是这一端画出来的样子。

判定题:**这条用例如果只在一个部件里跑,还成立吗?成立 → visual。**

集成测试要起 PG 和 Redis 时,一律用 `@breatic/integration-tests` 的容器启动(包的 `vitest.integration.config.ts` 把 `@breatic/integration-tests/containers` 挂进 `globalSetup`、`@breatic/integration-tests/env` 挂进 `setupFiles`),不在包里再写一份。判定题:**这条集成测试读到了别的服务的源码吗?读到 → 它住 `packages/integration-tests`。**

## 2. smoke(做不了必 explicit 说明,不许默默跳)

最小冒烟:起真实 runtime,确认改动真能跑起来。

| 改动端 | 必做 |
|---|---|
| 后端(server / worker / collab / core / shared)| `pnpm dev` 起服务 → 3 个 healthz(`:3001` `/healthz` · `:9101` · `:1235`)返 200 → 改动涉及的关键 endpoint 实测真返回(curl / 集成测试)|
| 前端(web)| `pnpm --filter @breatic/web dev`(`:8000`)→ 浏览器(chrome-devtools MCP / Playwright)开**改动的页面** → 看真渲染 + 0 console error |
| 纯文档 / 配置 / 注释 | 免 smoke(无 runtime 行为变更)|

### 2.1 套件自己准备它要的一切

`pnpm --filter @breatic/web test:smoke` 不需要任何事先配置。两档默认用 4 个 worker 并行跑(`playwright.config.ts` 的 `WORKERS`,`--workers` 可覆盖),每个 worker 按它的 `parallelIndex`(下称槽位)用自己的一对账号 A / B 和它们的 project:setup 按本轮的 worker 数逐个槽位准备，缺账号的槽位由 `scripts/seed-smoke-account.ts` 直接建账号(调服务端注册接口背后的 `authService.register`,不经 `POST /auth/register`,不占注册限流),再登录、建 studio 和 project,凭据和登录状态写进 `playwright/.auth/`(已 gitignore,`accounts.json` 按槽位分，登录状态是 `<槽位>-a.json` / `<槽位>-b.json`)。第一次跑和数据库被清空之后跑走同一条路。**只对本机**——setup 会建账号、会归档 project,所以它拒绝对着 localhost 以外的地址跑。spec 和 helper 一律从 `tests/helpers/slot.ts` 取 `test`,它打开的页面默认登录成本槽位的 A;从 `playwright/test` 直接取 `test` 会被 ESLint 拦下。

服务端开着邮件时，测注册的那几条 spec(`email-case`、`signup-code`、`trial-credits`)要读寄到 Mailpit 的验证码，所以跑 smoke 的那套服务用 `pnpm dev:mailpit` 起：它起 Mailpit 并把服务端的 SMTP 指过去。用 `pnpm dev` 起的服务按 `.env` 里的发信方式寄信,Mailpit 开着也收不到。

同一套服务同一时间只跑一轮 playwright(见 2.3 末尾)。一轮里的几个 worker 各用各的账号，互不干扰。

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
| `pnpm test:smoke` / `pnpm test:visual` | 默认档:不带标签的那些。任何一台干净机器上都要全绿 |
| `pnpm test:smoke:all` / `pnpm test:visual:all` | 全部,含带标签的，用 1 个 worker |
| `playwright test --project=smoke --workers=1 --grep "@needs-<标签>"` | 单个子门 |
| `pnpm --filter @breatic/web test:consent` | `tests/consent/`:`playwright.consent.config.ts` 把前端按不带和带厂商变量各构建一份、用 `vite preview` 起服务，带 `@no-vendors` 标签的用例跑前一份、其余跑后一份;后端用本地已起的 server,CI 的 `consent-network-audit` 作业由它自己起 |

子门用 1 个 worker 跑，全部落在槽位 0:生成类用例要花积分，买过积分包的是槽位 0 的账号，其余槽位的新账号只有试用积分(`config/pricing.yaml` 的 `trial_grant`)。

**每个 PR 跑这次改动相关的 smoke 和 visual,不跑全套。** 范围按任务分支相对主分支的全部 diff 定。开跑前先列一张表:改动文件 → 运行时变没变 → 哪条 spec 的哪一步走到它，以及那一步在改动前后看到的结果有什么不同。表先给决策人看过再开跑。判据:

| 改动 | 算不算相关 |
|---|---|
| 只改 import、类型、注释、用例名 | 不算 |
| spec 只是引用了改动组件的元素(取 testid、取框、等它可见),那一步在改动前后得到的结果一样 | 不算 |
| 多个 spec 共用的 helper、setup 或配置 | 挑一组能走到它每条分支的 spec,引用它的其余 spec 不跑 |
| 带标签用例背后那个服务的调用路径 | 算,按上表单个子门的写法跑 |
| 带标签用例只做了机械改动 | 不算,由归属的 CC 在发布前签 |

不带标签的用例用默认的 4 个 worker 并行跑,`--workers=1` 只给上表的子门。相关的 spec 里同时有带标签和不带标签的,分两条命令跑。**两条不能合成一条**——`--grep` 和 `--grep-invert` 是与的关系且排除优先,合并之后交集为空,一条都跑不到(playwright 1.62.1 实测 `Total: 0 tests`)。

**按上表不相关的用例红了，不进归属判定。** **失败用例先查已登记的 issue**:同一条用例、同样的失败现象已经有人记过,就不再查原因。**归属一律到主分支上跑同一条完整 spec 定**:主分支也红是既有问题,只在任务分支红的归本次;主分支也红而还没有 issue 的,补一条。

**交付门按标签切成子门**,发布前由上表里归属的 CC 各自签,签完才算这一轮的门过了。没有任何一台机器同时具备全部场景,所以不存在「一台机器跑 `test:smoke:all` 全绿」这个门。

默认档的运行会印出它排除了什么(`覆盖 N 条,共 M 条;排除 K 条:@needs-… `)。**被排除的用例在报告里连一行都没有**,所以那行是唯一能让人知道这个绿盖了多少的地方。

**server 的集成测试层用同一套标签**:`packages/server/vitest.integration.config.ts` 的 `testNamePattern` 默认把名字里带 `@needs-` 的用例排除在外,vitest 把每一条记成 skipped,汇总里的 skip 数就是这个绿没盖到的部分。子门有意去跑,加 `-t @needs-<标签>`,它替换掉默认那条排除。现有一个 `@needs-payments` 子门:`credit-refund-real-stripe.integration.test.ts` 对着真实 Stripe 测试模式跑积分包退款处置,`STRIPE_SECRET_KEY` 不是 `sk_test_` 开头就在第一次调用之前拒跑:

```bash
STRIPE_SECRET_KEY=sk_test_… pnpm --filter @breatic/server test:integration \
  -t @needs-payments src/__tests__/integration/credit-refund-real-stripe.integration.test.ts
```

### 2.3 写一条 smoke 的规则(MANDATORY)

| 条 | 规则 | 守卫 |
|---|---|---|
| 一 | 先按 §1.1 判档。判成 visual 或 unit 的不许写进 `tests/smoke/` | 人判 |
| 二 | 自己造它要的一切:project 从 `tests/helpers/project.ts` 取,Space 自己建自己删,素材用仓内固定文件 | `breatic/no-borrowed-project` |
| 三 | 不打公网 | `breatic/no-untagged-public-host` |
| 四 | 要外部服务的按 §2.2 打标签 | `breatic/declared-scenario-tags` |
| 五 | 不用条件 `test.skip`,文件作用域的也不行 | `breatic/no-runtime-test-skip` |
| 六 | 不依赖同文件里别的用例留下的东西 | 人判 |
| 七 | 写完做一次变异:把被测行为改坏,确认它真的红 | 人判 |
| 八 | 页面上同时挂着几个保活的 Space,读画布或文档里的元素一律限定在当前显示的那个:`visibleSpace(page)` / `VISIBLE_SPACE`(`tests/helpers/space.ts`) | 人判 |
| 九 | 在文档正文里写选区、按会移动浏览器原生选区的键,一律经 `tests/helpers/editor-keys.ts`:写选区用 `selectInBody`,按键用 `pressAndSettle`,点击放光标用 `clickAndSettle` | 人判 |
| 十 | 一次交给画布多个文件之前,先 `await roomForUploads(文件数)`(`tests/helpers/upload-budget.ts`) | 人判 |

第六条守卫看不见,而它是拆开共享开局时冒出来最多的一类:一条用例读上一条留在页面上或留在账号那条会话里的东西,拆开之后要么当场红,要么在什么都没发生的情况下恒为真。判定题:**这条用例断言的那个东西,是它自己放上去的吗?**

第七条同理:有断言不等于断言得到东西。`expect(panelText.length).toBeGreaterThan(0)` 这种在产品坏掉时照样绿。

第九条:ProseMirror 拿到焦点后会在约 20ms 后把它自己记的选区写回页面,写选区与它读回之间插进来的任何一次 dispatch 也会这样写回;脚本的下一步如果抢在读回之前,结果就被撤销,而这只在页面忙的时候发生,表现为时好时坏。`selectInBody` 等到编辑器选区等于写进去的那个范围才返回,被写回时重写。

第十条:服务端每个账号每个窗口只发 `config/rate-limits.yaml` 里 `upload-ticket` 那么多张上传票据,一个文件一张。同一个槽位里上传类用例连着跑时会超过它，超出的文件拿到 429、节点一直空着。`roomForUploads` 按 `openSmokeProject` 打开的页面实际发出的票据计数，等到额度够了再交。记录按槽位存在 `playwright/.auth/upload-tickets-<槽位>.json`:用例红了之后 Playwright 会在同一个槽位上换一个 worker 进程，而服务端的窗口还在接着算。

第五条的两种落点后果一样:用例体里的那一句吃掉这一条,文件顶上的那一句吃掉整个文件,报告两次都写「skipped」而退出码是零。2026-09-19 实测:文件顶上一行 `test.skip(!email || !password, ...)` 换来 12 passed / 289 skipped 和一个零退出码。名字带 body 的 `test.skip('标题', async () => {})` 不在此列——它在报告里有自己的标题,谁都看得见。

**两档都禁 `test.describe.configure({ mode: 'serial' })`**(`breatic/no-serial-tests`)。一条红让同组后面的用例整批不执行——2026-09-19 实测一轮 54 条未执行,其中 44 条出自一个文件。

**超时只有一个数:project 的那个**(`playwright.config.ts`,两档都是 180s)。playwright 的 `test.setTimeout` 是**赋值**不是取大(`playwright/lib/common/index.js:2413`),所以一句写在文件顶上的 `test.setTimeout(90_000)` 把 180 秒降成了 90 秒,而它旁边的注释多半写着「抬高」。判定题:**我要写的这个数,比 project 的大吗?** 不大就别写;大才写,并在同一行说清哪一步要花这么久。

**一台机器上一次只跑一轮。** 一轮里的几个 worker 按槽位分账号，两轮之间没有：setup 开局会把每个槽位上一轮留下的 Project 归档(`tests/helpers/project.ts` 的 `archiveOlderRuns`),而它分不出「上一轮扔下的」和「另一轮正在用的」。smoke 和 visual 同时开两个进程，后起的那个会把先起的那个正在用的 Project 归档掉，先起的那一轮从此只能读、写不进去。

**同一个文件里的用例会分到不同 worker。** 两档都开着 `fullyParallel`,所以第六条在这里同样要成立。一组用例在 `beforeAll` 里建了只该建一次的东西(比如受限流的 team studio),给那个 describe 加 `test.describe.configure({ mode: 'default' })`,整组留在一个 worker 里按顺序跑。

## 3. E2E(关键路径 + 核心用户流必有完整流程验证)

用浏览器 / 真客户端跑完整用户旅程,**不 mock 关键路径**。

- **关键路径 6 类**([AGENTS.md](../AGENTS.md#critical-paths)):支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作 —— 改动碰到必跑对应 E2E
- **核心用户流**:注册 → 登录 → 建 project → canvas 节点 create → mini-tool apply → 邀请
- **工具**:web Playwright(`pnpm --filter @breatic/web test:smoke`)/ chrome-devtools MCP(交互式驱动)/ Yjs 协作类场景需两个会话验证多端 sync
- **视觉改动**:必真浏览器 verify(看实际渲染,不靠文字描述),小批 ship + ground truth 对照(详见 [ARCHITECTURE.md#frontend](./ARCHITECTURE.md#frontend))
- **建了什么就删掉什么(MANDATORY)**:spec 在套件的账号里建的东西(Space / 节点)一律在用例结束时删掉 —— spec 自己建的在它的 `afterEach` 里删,经 helper 建的由那个 helper 导出的 `test` 上的 fixture 删。**每条用例各建一个是对的**(不依赖上一次跑剩下的东西),但**留着就是错的** —— 一个 project 把它们全打开就每份文档占一个可写席位,collab 对此有上限(`packages/collab/src/services/connection-registry.ts`),超了那个 Space 只读、只读提示条吞掉用例的点击;而同一个账号被所有 spec 反复跑:实测一次全套建 32 个 Space,攒到 86 个时标签栏全是测试垃圾。判定题:**这条 spec 建了什么下次跑还看得见的东西吗?建了 → 它自己负责删。** 建和删走同一份实现(`packages/web/tests/helpers/space.ts`),别每个 spec 各写一遍;**删要走用户真实路径**(Space 的删除是 collab 的 `space:delete` RPC,鉴权和审计都在服务端,ADR 2026-05-23 yjs-collab-only-write-authz 禁止客户端直写 `meta.spaces`)。project 归 setup 和 teardown 管:setup 每轮建、teardown 每轮归档(产品没有删除 project,归档后它不再占 studio 的 project 上限),setup 开局还会归档更早的运行留下的(一轮被中断就会留下);任何一个归档不成功,setup 或 teardown 当场红。**账号上的设置同理**:界面语言存在账号上、每个新开的页面加载时都照它切换,所以改了语言的用例结束前要在 `finally` 里改回 English;setup 每轮开局也把两个账号的语言设回 `en`,一轮中途被打断留下的也会被还原
- **helper 不在模块顶层注册钩子(MANDATORY,CI 强制)**:`tests/helpers/` 下的模块顶层不写 `test.beforeEach` / `afterEach` / `beforeAll` / `afterAll` / `test.use`。模块在一个 worker 里只执行一次,顶层的钩子只挂到这个 worker 里**第一个**导入它的 spec 上,之后导入它的 spec 拿不到准备也拿不到清理,而且没有任何报错 —— 哪个 spec 排第一取决于这一轮的调度,于是同一个 spec 单跑绿、整套跑红。helper 的准备和清理(包括窗口大小)一律做成它导出的 `test` 上的 auto fixture(`base.extend({ x: [async ({ page }, use) => { …; await use(); … }, { auto: true }] })`),整个用例都不变的窗口大小可以直接写成 `extend` 里的 `viewport` 值;要用它的 spec 从 helper 导入 `test`。会建东西的 helper 函数在 fixture 没在跑时直接抛错,所以漏导 `test` 当场就红。`breatic/no-helper-module-hooks` 扫 `tests/helpers/**`。判定题:**我正要在 helper 的顶层写一个钩子吗?那就把它写成 fixture。**

## 4. 边界

- **TDD vs smoke/E2E**:TDD(红绿蓝)= 写代码时的单测 / 集成,防回归;smoke/E2E = ship 前端到端确认 + **spec-gap 探测**(production / E2E / 用户反馈才是 spec gap 的真正 detector,不是 unit test —— 见 [TDD-MANDATE.md](./TDD-MANDATE.md))
- **不 mock 关键路径**:integration / E2E 把 DB / API / Stripe 等关键路径 mock 掉 = 假测,违规(见 [TDD-MANDATE.md](./TDD-MANDATE.md))
- **做不了必 explicit 说明**:环境 / 工具限制跑不了 smoke / E2E,必须明说理由,**不许默默跳过**
