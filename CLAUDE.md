# 头号原则(MANDATORY)

> 解决问题要找根因 — 不在症状上贴补丁,不"先这样后续再改",不拿"工作量大 / 时间紧"当借口。

每个 PR 动手前回答:**这个修改是在解决根因,还是在压住症状?** 答不上来停下来,重新想,或者问用户。

解决后再问:**真的解决了根本问题,还是把症状搬到了别处 / 把问题往后拖了一步 / 让自己看起来像解决了?** 答错就停,先跟用户沟通。

**每次完成任务必须测试 + 同步所有受影响文档:**

| 项 | 内容 |
|---|---|
| 测试 | typecheck + 单测 + smoke / e2e / 浏览器交互。做不了要 explicit 说明,不许跳过。**smoke / e2e 操作规范见 [docs/TEST-MANDATE.md](./docs/TEST-MANDATE.md)**(测试五层 / smoke 定义 / 关键路径 E2E / 边界)|
| 文档 | `docs/*` 等所有受影响项。**落后文档比没文档更糟** |

**所有任务必须先列 todo 计划,按计划执行,完成后对照复核**。不分 research / 执行 / 测试 / 文档,**也不分大小** — 哪怕一两步也写。**取消"小任务豁免"**:小任务也写、也复核。

# 判性质先于找根因(MANDATORY)

> **每一个问题,动手之前先判它的性质:承诺内 / 承诺外 / 用户的不正当使用 / 别的。性质决定该怎么处理,也决定该不该处理。**

**判不准,或者自己判不了 —— 停下来问用户,别自己拍。** 这是硬要求,不是建议:性质判错了,后面的根因分析、方案、对抗全都建在错的地基上,而每一轮对抗还会让它看起来更像真问题。

**承诺的出处只有三个**:① 用户拍板的决定 · ② 任务目标那一句 · ③ 已发布文档。**自己拆的验收清单不算出处** —— 清单是从这三个推出来的,推不出来的那一条本来就不该写进去。判定题:**我正要处理的这个行为,能指到那三个出处里的哪一个?指不到 → 它不是承诺内,先问。**

**承诺外有一个很好认的形状**:服务器的数据没有被破坏,只是这一端屏幕上显示的东西不对。这类东西天然有一条绝对的出路 —— 用户刷新一下页面就好了 —— 所以处理方式是**提供那条出路,不是保证它不发生**。

**对抗关交回来的每一条,都要单独走一遍这道判定**,不许整批贴标签。对抗者只看得见局部,它报回来的东西默认没有性质;性质由你逐条判,判不准的逐条问。

代价是实测出来的:任务 #123 那次里,我把两条自己加进验收清单的一致性要求当成承诺内,为它建了一整套仲裁机制,连续四轮实现对抗咬出的问题全部出自它,最后整套撤回、净删 662 行;同一个任务里另有一处焦点处理同样如此,又删 46 行。**两次都不是修错了,是从一开始就不该修。**

# 项目简介

面向内容创作者的 AI 无限画布协作平台。全栈 TypeScript monorepo,7 包 + 3 服务。

**架构详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**(backend 全部技术栈 / 包依赖 / 3 服务 / 画布协作 / 三层记忆 / Worker / Mini-Tool / Skill / Agent tools / 配置 / 日志)。**前端详见 [docs/ARCHITECTURE.md#frontend](./docs/ARCHITECTURE.md#frontend)**(技术栈 / 7 层 layered / 节点模型 / 命名规范 / 路由)。

# 开发命令

```bash
# 本地:首次复制 .env.dev → .env,docker 起 PG+Redis,pnpm db:migrate;之后 pnpm dev
# Docker 全量:复制 .env.docker → .env,改域名/密钥,docker compose up -d
pnpm dev              # turbo 跑全部服务(自动先 build shared/core,再 watch server/worker/collab)
pnpm db:migrate       # 拉新 migration 后跑
pnpm db:journal-add <tag>  # 手写完 NNNN_name.sql 后加 journal 条目,`when` 由它取时钟
pnpm db:journal-repair    # 拉到迁移时间戳修正后每个库跑一次(先看报告,再 --apply)
pnpm test / typecheck / lint
```

启动时先 `checkInfraReady()` 验证 PG/Redis 可达;连不上立即退出(避免无声挂死)。Migration 是独立步骤,不绑在 dev 启动里。

# 代码风格

- **函数定义格式规范(MANDATORY)**:命名函数单元(函数声明 / 类方法 / 类 / 变量赋值的箭头·函数表达式)必须有 TSDoc 文档注释 + 显式返回类型 + `@throws {ErrorType}` 异常类型;类型信息归签名(显式)、注释禁写类型,唯异常类型签名表达不了归注释。**不分导出 / 私有**(规则只有 0/1);内联匿名回调 + 测试豁免。详见 [docs/ARCHITECTURE.md#coding-standards-function-definition-format](./docs/ARCHITECTURE.md#coding-standards-function-definition-format)
- **文件头版权声明(MANDATORY)**:每个首方 TypeScript 源文件(`packages/*/src/**/*.{ts,tsx}` + `eslint-rules/src/**/*.ts` + `repo-lint/src/**/*.ts`,含测试)顶部必须有 SPDX 双行头(`// Copyright (c) 2026 Orime, Inc.` + `// SPDX-License-Identifier: LicenseRef-BSAL-1.0`);shadcn vendor(`web` 的 `components/ui/`)豁免(第三方 IP,不挂 Orime 版权)。CI `breatic/no-missing-license-header` 强制,**双行都校验**(只校验第一行等于只强制了一半);缺头跑 `pnpm lint:fix` 自动补(规则自带 fixer,头文本只有它一处定义)。详见 [docs/ARCHITECTURE.md#coding-standards-function-definition-format](./docs/ARCHITECTURE.md#coding-standards-function-definition-format)
- TypeScript strict,禁止 `any`(用 `unknown`),禁止 `var`/`require`
- ESLint + eslint-plugin-jsdoc 强制(`recommended-typescript-error` + require-jsdoc 全量 + explicit-function-return-type)
- 前端命名规范见 [docs/ARCHITECTURE.md#naming-conventions](./docs/ARCHITECTURE.md#naming-conventions)
- 前端 layered 架构以 `app → pages → spaces → features → stores → domain → data → ui` 单向依赖(详见 [docs/ARCHITECTURE.md#layered-architecture](./docs/ARCHITECTURE.md#layered-architecture))

# 关键规范

- **`@shared` vs `@core` 内容归属(MANDATORY)**:`@breatic/shared` = **web + 后端共用**的东西,**必须浏览器安全**(零 `node:*` / `fs` / `async_hooks` 等依赖,`sideEffects: false`);`@breatic/core` = **仅后端共用**(可用 node API)。判定题:**web 用得到吗?用得到 → `shared`;用不到 → `core`**。后端专用的东西(doc-name 构造、node i18n 适配器等)放 `core`,不许塞进 `shared`。`shared` 单入口(`tsup src/index.ts` 全 bundle),不开多 subpath 入口——多入口会把内部别名 `@shared/*` 泄漏进 dist 解析不了
- **后端两个维度:包归属 + 包内分层(MANDATORY)**:**① 包归属(看「谁用」,决定进哪个包)** —— `@breatic/core` = 全后端(含 collab)共享内核(基础设施 / DB schema / 跨服务事件 / 统一鉴权);`@breatic/domain` = 只 server+worker 共享、collab 永不碰的 AIGC 业务(积分花 / 任务 / 节点历史 / agent / model-catalog / canvas-lock);**只一个服务用 → 那个服务**(如 `server/src/modules/`)。判定题:collab 用 且 ≥1 其他后端也用(鉴权 / 会话 / 角色 / 成员事件)· 或 基础设施 / 共享 DB schema / 跨服务事件 → core;只 server+worker 用 → domain;只一个服务用 → 那个服务。**core / domain 都不是业务的默认堆放处**。依赖图 `shared ← core ← {domain, collab};domain ← server / worker`。**② 包内分层(看「翻译还是写业务」,决定进哪一层)** —— 路由层(server route / worker handler / collab hook)只把协议翻译成业务调用、**不写领域业务**(禁止清单 #1);领域 service 层写业务逻辑、**不 import 协议框架**(禁止清单 #2)。**两维度正交不冲突**(例「只 server 用的业务」= 包归属在 server + 写在 server 的 service 层而非 route 层)。**一张表一个 repo 家**:一张表的数据访问(repo)只在一个模块,service 调 repo、不写 SQL。跨服务通信:同步要答案 → 函数调用(类型安全);异步 / 跨进程 / 扇出 → Redis 事件(数据契约在 core/shared)。CI 强制(`lint:dependency-cruiser` 声明式规则):`library-no-app-import`(core / shared / domain 出现 import `@server` / `@worker` / `@collab` / `@web` 即 fail)+ `collab-no-domain-import`(collab import `@breatic/domain` 即 fail)。每个包根有独立 `CLAUDE.md` 写该包的角色 + 可 import 谁 + 暴露啥 + 怎么拿配置。细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **环境变量注入(MANDATORY)**:`@breatic/core` / `@breatic/shared` / `@breatic/domain` **不读 `process.env`、不 load `.env`**(配置 ACQUISITION 是 application 决策,同 logger / `process.exit()` 的 library 边界原则)。**application entry(server / worker / collab = composition root)**启动时第一件事 `dotenv` + `initCore(process.env)` 一次,core 的 **zod schema** 校验后存住;library 经 **`env` Proxy / `getConfig()` / `getRawEnvVar()`** 读注入的配置,源码零 `process.env`。**db / Redis / LLM provider / logger 全延迟单例**(模块 import 时不读 env,首次用时才建,确保 `@breatic/core` barrel 在 `initCore` 前可安全 import)。3 个 healthz 端口(`SERVER_HEALTH_PORT` 3001 / `WORKER_HEALTH_PORT` 9101 / `COLLAB_HEALTH_PORT` 1235)统一进 core schema,从 `env.*` 读;`PATH` / `HOME` **不入 schema**(自动继承宿主;schema 之外的动态键名一律经 `getRawEnvVar` 取,provider 的 `api_key_env` 也走它)。`breatic/no-library-env-access` CI 强制(`src/` 出现任何 `process.env` 即 fail;`process.cwd()` 不算)。entry 读 env 是 composition root 的本职,不算违规
- **软删除(MANDATORY)**:所有表用 `deleted_at` 标记,FK `restrict`,list 默认过滤 `deleted_at IS NULL`。**禁止硬删除**(GDPR 删号走单独流程)。`breatic/schema-timestamps` CI 强制;确实无可删语义的表(append-only 账本 / 内部队列 / 一次性凭据)写进规则里的 `NO_SOFT_DELETE` 并**当场写清理由** —— 名单只认带理由的条目,不带理由的豁免就是违规的停车场
- **`created_at`(MANDATORY)**:所有 PG 表必须有 `created_at timestamp with time zone DEFAULT now() NOT NULL`。业务实体表用 `timestamps` helper(`created_at` + `updated_at` 一对);append-only 历史 / 事件表只用 `created_at`。`breatic/schema-timestamps` CI 强制,**`created_at` 零豁免**(豁免名单只管 `deleted_at`);规则读的是 `pgTable` 的列对象本身,读不到列(第二个参数不是对象字面量)一律判失败——守卫看不见就得说看不见,不能放行
- **禁止 AI 作者署名(MANDATORY)**:commit 署名禁 AI 工具名,`.husky/commit-msg` + PR CI 强制
- **语言(MANDATORY)**:breatic 是全球源代码可用(source-available)项目,贡献者来自世界各地 → **代码 + 注释必须英文**(给人读,方便全球协作)。三类例外可非英文:① i18n 多语言文案(`locales/*.json` + 语言原生名等故意产品数据)· ② **测试文件整体豁免**(`__tests__/` 目录下的一切,加上 `*.test.ts|mts|cts|tsx` / `*.spec.*` —— 即守卫 `TEST_FILE` 的判据,`repo-lint/src/file-kinds.ts`);测试就是拿来测的,用例名和注释里写中文不算违规,不必为了过守卫把话说别扭。**但「测试脚手架」不在豁免内**:名字像普通模块、住在 `src/` 下、只被测试 import 的东西(`packages/web/src/test-utils/a11y.ts` · `packages/core/src/db/test-support.ts`)不符合 `TEST_FILE`,照样被扫、照样必须英文 —— 这是刻意的,判据看**路径**不看**用途**· ③ repo-lint 的 `no-cjk` 检查 allowlist 里的故意产品数据字符串(两条:语言原生名 + 禁译词表本身)。**规范文档(`CLAUDE.md` / `docs/*` / 各包 `CLAUDE.md` 等 `.md`)是给机器(AI)读的,中文 OK、不强制英文** —— 代码给人看(英文)、文档给机器读(中文)是两个层面。判定题:**这内容会编译进产物 / 被开发者直接读吗?会 → 英文(代码 + 注释);只是给 AI 读的规范说明 → 中文 OK**。repo-lint 的 `no-cjk` CI 强制,范围 = **git 追踪的、外加未跟踪也未被忽略的** `.ts/.mts/.cts/.tsx/.css/.yaml/.yml/.sh/.mjs/.cjs`(含注释)—— 从 `git ls-files` 取,所以**仓库根目录和 `scripts/` 下的非 `.sh` 文件也在内**;旧守卫用 `find packages` 够不着这两处,对它们恒报 clean。`.md` 不扫(规范文档中文 OK)
- **PostgreSQL**:Drizzle + UUID + JSONB,积分扣费走 `db.transaction()`(扣费+记流水原子)。**迁移从 0018 起全手写,journal 条目一律 `pnpm db:journal-add <tag>` 加、`when` 绝不手打(MANDATORY)** —— `drizzle-orm@0.45.2` 靠「库里最新那条的时间戳」判迁移跑过没(不是靠已执行清单),所以一条填到未来的 `when` 会把之后按真实日期写的迁移**静默跳过**,`pnpm db:migrate` 照样报 completed、退出码 0。实测 54 条**全部**跟真实创建时间不符(落后最多 49 天,超前最多 4.7 天),而 `0051_purge_pre_parts_messages` 因此在某个 dev 库里从来没跑过。`repo-lint` 的 `migration-journal` CI 强制(严格递增 + 不在未来)。判定题:**我正要往 journal 里手打一个数字吗?那就错了,跑那条命令**。**另一半在数据库里,仓库够不着**:drizzle 把 journal 的 `when` 原样存进 `drizzle.__drizzle_migrations`,所以修了文件不等于修了库 —— 已迁移过的库水位线仍是旧值,之后新加的迁移照样被跳过,而且**已经被跳过的那些不会自动补回来**。拉到迁移时间戳修正后**每个库各跑一次 `pnpm db:journal-repair --apply`**(它同时改 `created_at` 和补跑漏掉的迁移)。守卫只读文件、看不到库,**守卫绿不等于库会跑**
- **时间(MANDATORY)**:**服务器一律以 UTC 记录** —— PG 列 `timestamp with time zone`,写入用 `now()`,库里存到微秒。**wire 上一律是绝对时刻**,形式看那条接口既有的约定(ISO 串或 epoch 毫秒,同一个字段别换);两种都不带时区,读的人自己落到本地。**前端一律按读者本地时区显示** —— 先 `new Date(iso)` 落到本地,再取值或格式化。**格式听设计的**(有 demo 就照 demo;`YYYY-MM-DD` 这类跨语言一致的形状直接从本地 Date 的年月日拼);**任何 `toLocale*` 格式化(`toLocaleDateString` / `toLocaleTimeString` / `toLocaleString`)都必须把 `getLocale()` 传进去** —— 传 `undefined` 取的是浏览器或操作系统的语言,不是语言开关设的那个。判定题:**我正要把一个时间戳变成给人看的字吗?那就不能切字符串** —— `iso.slice(0, 10)` 切出来的是 UTC 那一天,UTC+8 的用户每天有 8 小时(00:00–08:00)会看到前一天,而这一列常常是一条记录唯一的时间信息。**另一半在 JS 那边**:`Date` 只装得下毫秒,所以任何「把库里的时间戳经过 `Date` 再送回数据库比较」的路径都会丢掉微秒 —— keyset 分页的游标正是这种路径,丢掉的后果是同一毫秒内跨了页边界的行被静默跳过。要跨边界携带时间戳就带全精度文本,别让它经过 `Date`。
- **Redis 4 DB**:DB0 session/lock/rate-limit,DB1 BullMQ,DB2 跨服务 Streams,DB3 collab 实例间协调(Hocuspocus pub/sub + space-delete 锁 + 每文档可写连接数 registry)。Key `{env}:{service}:{entity}:{id}`,**禁止无 TTL**,Stream MAXLEN ~10000。**同机多套部署并行时,DB 号和端口各有隔离不到的东西**:pub/sub 频道不认 DB 号(`SUBSCRIBE` 实例级、不认 `SELECT`)· session cookie 不认端口(RFC 6265 §8.5,同 host 共用一个 cookie jar,同名就互相顶掉登录态)。这两样一律靠 `REDIS_KEY_PREFIX`(默认 = env)分开,cookie 名的唯一构造处是 core 的 `sessionCookieName()`。判定题:**这东西真的被 DB 号 / 端口分开了吗?频道和 cookie 名没有 → 它俩只能靠前缀**
- **Auth 安全**:登录 5/分,注册 10/时,Google OAuth 10/分(Redis 滑窗)。邮箱两步注册(注册即发 session,onboarding 闸门 = 个人 studio 为空);**所有环境一律必须登录**——早期那个跳过鉴权的 dev 免密模式已于 #147 移除,没有任何开关能关掉登录(repo-lint 的 `no-auth-bypass-residue` CI 强制,扫**全部** tracked 文件、不按扩展名筛 —— 当初的四处残留分别在 README、一个没扩展名的 Dockerfile、一个 spike 脚本和两份 env 模板里,扩展名清单会漏掉其中三处)
- **XSS / Prompt**:**当前不渲染任何用户提供的 HTML**,所以没有、也不需要 sanitize 环节。**将来要渲染用户 HTML,防护方案另行确定后才动手**,不许先渲染后补。判定题有**两问,缺一不可**:**① 我正要把一段用户可控的内容当 HTML 塞进 DOM 吗?**(`dangerouslySetInnerHTML` / `innerHTML` / `insertAdjacentHTML` / `document.write`)**② 我正要把它交给一个会把内嵌 HTML 当标记渲染的库吗?**(markdown 渲染器开了 raw HTML —— `react-markdown` + `rehype-raw`、`marked` 不转义、`v-html` 之流)。任一为是 → 停,先定方案。**第二问是补进来的**:2026-07-31 判定"零渲染"时只 grep 了第一类关键词,而 `react-markdown` + `rehype-raw` 当时正躺在 web 的依赖里 —— 结论侥幸没错(源码零 import,2026-08-01 已把这两个死依赖删掉),但那套判定方法配不上这个结论,只查第一类会让第二类永远发现不了。AIGC prompt 另算,一律先经 `extractPromptText()` 去 HTML / 注释 / 不可见字符(`packages/domain/src/agent/extract-prompt.ts`)
- **异常**:`AppError(status, msg)` 在 Service 层抛,路由层 handler 处理(NotFound / Conflict / Validation / Forbidden / Unauthorized)。**消息一律经 `t()`,禁写字面量**——`errorHandler` 把 `AppError.message` 原样放上线,写死的英文就是用户读到的英文,而产品出五种语言。**出口按「谁造成的」判,不按异常类型判**:只认 `AppError`(我们抛的)和 `HTTPException`(hono 抛的、body 读不出来),其余一律 500 + `logger.error`——异常类型只说「有个解析失败了」,不说「谁的输入失败了」,我们自己的 config yaml 就是在请求内惰性解析的。**路由不许自己解析请求体**,一律挂 `validate(target, schema)`。`breatic/no-untranslated-error-message` + `breatic/no-raw-body-parse` CI 强制。判定题:**这句话会被用户读到吗?会 → 它必须来自 `t()`**
- **SSE**:仅 Agent 聊天 + Text mini-tool,**per-request 私有流**(前端 `fetchEventSource` POST,每次请求各开各的流、靠回调对账)。**事件 `data` 不携带归属 ID** —— 对话归属由 `conversations` 表的 `user_id` / `project_id` 列兜底(SSE 片段不落库、前端不读、每 chunk 重复 = 冗余无消费方);要审计单次操作走 application 层 `logger`,不塞进 wire。**每个 SSE 入口必须订阅客户端离开(`s.onAbort`),并把这个信号一路传到真正在干活的那一层(MANDATORY)** —— 客户端断开时 `StreamingApi.write` **会把写失败这个错误吞掉**,所以只盯着自己写成功没有的循环**永远不会知道没人在听了**,它会继续调模型、继续跑工具、继续按用户的账扣钱。判定题:**这个流的生产者,在没人听的时候会自己停吗?不会 → 它必须收到那个信号。** 现存三个入口(`chat.ts` 的 `/message` 与 `/skill`、`text-tools.ts`)全部照此办
- **会话归属(MANDATORY)**:**会话 ID 由客户端提供**(一个用户可能开着多个标签页、各看一条会话,服务端存一个「当前会话」只能存下其中一个,另一个从此写错地方)。因此**每个写入会话的入口,写第一个字之前必须查三样:这条会话属于这个用户 · 属于这个 project · 没被软删**;三样**一律答 404**(三种可区分的答案 = 状态码自己告诉调用方是哪一条没过)。**会话只在一处被自动创建**(「打开聊天」端点),别的入口一律只写不建 —— 多一个创建点,一个失效的 ID 就会静默变成一条新会话,而用户以为自己还在原来那条里。判定题:**我正要往一个客户端给的会话 ID 里写东西吗?那三样查了吗?** 细节见 [docs/ARCHITECTURE.md#chat-conversation-ownership](./docs/ARCHITECTURE.md#chat-conversation-ownership)
- **存储(MANDATORY)**:Local / S3 / Aliyun OSS / Cloudflare R2。**浏览器不直接碰存储** —— 先向 `POST /assets/upload-ticket` 换一张签好的票据(有效期走 `config/storage.yaml`,30/分限速),再把分片发给我们部署的 **ingest Worker**,由它转写 R2 并边写边算 sha256,写完拿共享密钥 `POST /assets/ingest-report` 回报。四条铁律:**① runtime 只插不删** —— 上传 / 生成路径对物理对象零删除,去重多出来的那份只**登记**进待回收表交离线处理;**② 消费方 URL 一律取自登记记录**(节点 / 历史 / 活动流都钉 `publicUrl(记录.storage_key)`),绝不钉刚上传、可能成孤儿的 key;**③ 登记失败即上传失败** —— `/ingest-report` 零例外(封面是另一条资产、另一个 job:抽不出来或登记不上时,视频照常是成功的,节点拿到的是一个没有缩略图的视频);**④ 没 hash 不许传** —— 前端算不出就不发起,ticket 必填、报告说成功也必填。判定题:**这条 URL 会被谁钉住吗?会 → 它必须来自登记记录**。key 租户中立(不含 user/project 前缀),**hash 和大小一律取自 Worker 报回来的那份**(前端声明的那两个只做去重预检和 UX,不当权威门);**类型是票据里签着的那个** —— 前端声明、ticket 端点校验过是不是可上传的那三族,Worker 原样写进 R2 对象、原样回报,它不测量字节;报告的后果落在哪个 studio、哪个节点,全从票据那一行读 —— Worker 只知道票据告诉它的,一样都证明不了
- **支付(会员 + 积分两条独立的腿)**:**会员分四档**(Base 免费 / PRO / Team / 商务谈),档位只分**容量、协作规模、商用与治理**;**全部创作功能和模型质量全档通用、不设墙** —— 判定题:**我正要按档位关掉一个「能不能生成」的功能吗?那就错了,档位只管容量和协作规模**。**积分是另一条腿,会员不含积分、积分单独购买**:Stripe Checkout 一次性买积分包(5 档),1 积分恒等于 1 美分,积分永不过期,生成失败退积分。**充值是账号级的,每个积分包整笔指定给一个 studio 去消耗**(个人 studio 也算一个),一个包只能指定给一个 studio。**指定是 admin 切断该 studio 消耗的总开关**:没有积分包指给它,这个 studio 里任何人任何 project 都执行不了生成 —— 所以「未指定花不出去」是开关的默认态,不是限制。由此得出一条硬规则:**一个人不再是某个 studio 的 admin 的那一瞬间,他名下指向这个 studio 的积分包全部解除指定**,四条触发路径是被降级 · 被移出 · studio 转让走 · studio 被删除,清空必须跟角色变更同事务。**会员是同一条规则的另一种实现**:一个 studio 的档位就是它**当前 admin** 那个账号的档位(`membership.repo.ts` 的 `readStudioAdmin` 按 `studio_members.role='admin'` 现查) —— 会员不存这个关系所以换人自动就对,积分把关系存成一列所以必须主动清。**这条规则执行在唯一可达的那条路径上**(任务 #15;studio 删除那一路归 #26)。2026-08-24 逐个文件核实:**四条路径今天只有转让一条走得通**(`studioTransfer.service.ts` 的 `confirmTransfer`,它把前任 admin 降为 maintainer);被降级和被移出都被 `studioMember.service.ts` 的 `ConflictError` 拦死,主动退出跟被移出共用同一处拦截,**studio 被删除那一条整个还不存在**(全仓没有任何代码软删 studio)。**被拦死的根源在数据库**:一个 studio 至多一个 active admin 由部分唯一索引 `studio_members_one_admin_per_studio` 保证,所以「admin 走了这个 studio 就没有 admin 了」这个状态压根到不了写入那一步。可达的那一条会清空指定:`confirmTransfer` 在降级和升级之间调 `creditLotService.releaseDesignations`,跟角色变更在同一个事务里,所以中途读不到「已经不是 admin 了、指定还在」这个状态。**扣除侧零毛利**(扣多少就是我们付出去多少,用户可拿去跟模型官方价对账),**加价只在充值侧**(buffer 做进包价)。Webhook 幂等(CAS),`chargeOnceForGeneration(refKey, ...)` 保证扣费幂等。**数值、包价表、五层限制、待拍板项以 marketing 的会员与积分两份决议为准**(2026-07-30 会员分档 · 2026-07-31 积分体系),别在这儿复制会漂的数字。**档位的上限值落在 `config/membership.yaml`**(loader `packages/core/src/config/membership.ts`):每个值都是普通的非负整数上限、判定一律 `count >= limit`,**没有「无限制」这个哨兵** —— 想不设限就填一个够不着的数,所以零就是真值零。判定题:**我正要在代码里写一个上限数字吗?那就错了,它在那份 yaml 里**。**代码里有两个档位集合,别混**(`packages/shared/src/types/membership.ts`):`MEMBERSHIP_TIERS` 五个 —— `base` / `pro` / `team` / `self_hosted` / `enterprise`,是**一个账号能在的全部档位**,数据库的 CHECK 约束列的就是这五个(`self_hosted` 是部署形态、`enterprise` 是商务谈,两个都不在价目表上);`CONFIGURED_MEMBERSHIP_TIERS` 四个 —— 是**配额写在那份 yaml 里的那些**,企业版不在内。**企业版必须进枚举**:枚举缺它、而 CHECK 列了它,数据库允许存的一个合法值就会被读侧的 `asKnownTier` 当成损坏值拒掉(报「Unknown membership tier "enterprise" … this build knows base, pro, team, self_hosted」),那个账号从此每次取上限都失败 —— 两道守卫对同一个值给出相反的答案。**但它坚决不进 yaml** —— 数值一家一谈、将来从数据库读,在配置里编一组数会让被设成企业版的账号拿到谁都没谈过的额度而且不报错。所以 `getMembershipLimits` 的参数类型收窄成 `ConfiguredMembershipTier`,**编译器因此逼每条从档位到配额的路径显式处理企业版**;运行时真正指名账号抛错的是 `packages/core/src/auth/membership.repo.ts` 的 `limitsFor`(经 `getLimitsForUser` / `lockLimitsForUser` / `getLimitsForStudio` 三个入口到达)。判定题:**我这个集合要回答的是「账号能不能在这一档」还是「这一档的配额从哪读」?前者五个,后者四个**
- **服务器端工业级标准(MANDATORY)**:所有 server / collab / worker / core 逻辑按生产级标准实现,**禁止** "dev 阶段先这样后续再补"。**必须有**:

| 项 | 要求 |
|---|---|
| 错误日志(application 层) | **application 层(server route / collab hook / worker job handler 顶层)**所有 `catch` 必 `logger.error({ err, ctx })` 留可追溯链 — 因为只有 application 层知道 `userId` / `requestId` / `projectId` 等上下文,知道该返回什么给 client / 是否需要 alert;禁 silent fail / 裸 `catch (e) {}` |
| 错误日志(library 层禁) | **`@breatic/core` / `@breatic/shared` / `@breatic/domain` 不调用任何 `logger.*`(包括 `info` / `warn` / `error` / `debug`)或 `console.*`**。两条规则:① 默认 `throw`(抛原 error 或 typed `AppError(NOT_FOUND, ...)` / `InfraNotReadyError` 等让上层 catch 时判定);② 无法继续 throw 的场景(HTTP/RPC handler 在 Node 物理 constraint 下必须 catch 否则进程崩;第三方 library 用 exception 表达业务正常态如 S3 `NotFound`),catch 后**返回给上层正确的事件类型 / sentinel**(`{ exists: false }` / `CheckResult{ok:false}` 等)让上层正确处理 — 这是业务转换不是 log。**library 函数体内出现任何 `logger.*` 调用一律违规**:audit log(`user_registered` / `payment_completed` 等)移到 application 层(server route handler 调完 service 后 log);Redis client `.on('error')` 等 EventEmitter listener 由 caller(application entry)attach 而不是 factory 内默认 attach。`breatic/no-library-logger`(扫 core / shared / domain,含 `console.*`)CI 强制 |
| 进程生命周期(library 层禁) | **`@breatic/core` / `@breatic/shared` / `@breatic/domain` 不调用 `process.exit()` / 不主动终止进程**。library 知道"出错了"但不知道"该不该退" — 只有 application 层(每个 service entry)知道这个进程的生命周期决策(`server` 退就是 503 永不恢复;`worker` 退就是 BullMQ 重试链路;`collab` 退就是 hocuspocus 协作中断)。library 遇到"必须让上层中止进程"的场景(startup connectivity check 失败、env var 缺失等)**抛 typed error**(`InfraNotReadyError` 等),application entry 在 top-level `try/catch` 里接、log 上下文、`process.exit(1)`。`console.error` 也算 log,library 禁用(归 `breatic/no-library-logger` 守卫)。`breatic/no-library-process-exit` ESLint 规则(扫 core / shared / domain)CI 强制 |
| 环境变量(library 层禁) | **`@breatic/core` / `@breatic/shared` / `@breatic/domain` 不读 `process.env` / 不 load `.env`**(配置 ACQUISITION 是 application 决策,跟 logger / `process.exit()` 同一条 library 边界)。**entry(server / worker / collab)**第一件事 `dotenv` + `initCore(process.env)`,core 的 zod schema 校验后存住;library 经 **`env` Proxy / `getConfig()` / `getRawEnvVar()`** 读注入的配置。**db / Redis / LLM provider / logger 必延迟单例**(import 时不读 env;首次用时建),否则 `@breatic/core` barrel 在 `initCore` 前被 import 就抛。healthz 端口进 core schema 从 `env.*` 读;`PATH` / `HOME` 不入 schema(继承宿主;schema 之外的动态键名一律经 `getRawEnvVar` 取)。`breatic/no-library-env-access` 强制 |
| Connection 健康 | DB(`postgres-js`)/ Redis(`ioredis`)/ 队列 client 必显式配置 `max_lifetime` / `idle_timeout` / `keepAlive` / `reconnectOnError`,**不靠 client 默认**(默认通常不 idle recycle → 长跑后 connection stale,query throw 但 pool 不知道)|
| Health check | 长跑 service(server / collab / worker)必有 `/healthz` endpoint ping 关键依赖(PG + Redis + 队列),N 次 fail 后判定不健康。**谁来"恢复"要分清**:LB / Swarm / k8s 会摘掉或替换不健康实例(真自愈);**单机 `docker compose` 不会** —— `restart:` 只对进程退出生效,`unhealthy` 对它纯属信息,容器会一直挂在那儿不服务。所以单机部署的自愈靠监控告警接管,不靠 compose。**每条 critical Redis / DB 连接都要进探针**——collab 曾漏探 DB0(会话库),连接漂了 healthz 仍绿、LB 不重启 = 静默鉴权宕机(2026-06-16 补 `redis_general`)。CI 强制分两半:`breatic/service-observability`(ESLint,判三个入口**真的调用**了 logger 和 `startHealthServer` —— 只 import 不调用不算,旧的文本守卫会放过)+ repo-lint 的 `service-entries-present`(判这三个文件还在 —— 文件被删/改名就没有文件被 lint,规则静默不跑,这半 ESLint 结构上做不到)|
| 安全监控 | auth / 鉴权失败 / rate-limit 命中 / 异常 query / pool 耗尽 必有结构化日志(json + ctx);生产上报 metrics(error rate / connection pool size / acquire latency)看 trend 提前预警 |
| 守护 | critical path(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)必 alarm 链 + 自动重试 / 降级 fallback;process 收 SIGTERM 必 graceful shutdown(等 in-flight request 完成再退) |

写一行 `try { ... } catch (e) {}` 之前先问:**生产环境 3am 出问题,oncall 能从日志倒推到根因吗?** 答不能就停手,补 log + 监控再写

- **前端工业级标准(MANDATORY)**:`web` 同样按生产级实现,跟后端一个门槛,**禁止** "原型先这样后续再补"。整体约束:TS strict 零 `any` · layered 单向依赖(`app → pages → spaces → features → stores → domain → data → ui`)· 关键路径 / invariant(StrictMode-safe resource hook、Yjs 协作、optimistic update race 等)100% test · **React 优化 hooks 是质量纪律(MANDATORY)**:`React.memo` / `useMemo` / `useCallback` 正确、彻底地应用本身就是工业级代码质量——**即便某一处测不出提速也要用**(稳定引用 / 避免无谓重渲是纪律,不拿"省不了多少 / 测不出差别"当跳过借口);判定题:**这个值 / 回调每次渲染都新建、且被传给子组件或进依赖数组吗?是 → 稳定它**。**`React.memo` 的组件其 props 必须全部稳定,否则 memo 永不 bail = 等于没 memo(留个不 bail 的 memo 是质量瑕疵,要么稳定 props 要么别 memo)**。高频列表(画布节点等)镜像重建时未变项复用旧对象引用,memo 才生效 · a11y(语义 HTML / focus-visible / 键盘可达)· i18n(ICU,5 locale,禁硬编码文案)· 设计 token 严格(禁 raw brand / 静态 palette,走语义 token;repo-lint 的 `no-brand-usage` CI 强制(扫 `web/src` 的 `.ts/.tsx/.css`,**剥注释后判**——注释里提某个 brand token 不会让 chrome 变得不中性),**仅 logo 保留品牌**——studio 容器已转中性、不再是例外)· 视觉改动必有 ground truth + 小批 ship + 真浏览器 verify · **控件先查组件库再自己写(MANDATORY)**:要画按钮 / 弹层 / 输入框 / 徽章之前先看 `packages/web/src/components/ui/` 有没有,有就用现成的,没有才自己写、且写完视觉要跟整体一致 —— 不许自己拼一个长得差不多的 · **有 demo 的改动,收尾必须跟 demo 逐项比对(MANDATORY)**:把 demo 写死的视觉决定(圆角 / 对齐 / 间距 / 哪一格空着 / 哪些元素同一行)在真机上用 `getComputedStyle` 和 `getBoundingClientRect` 逐条量出来比,**不是「看着差不多」** —— 「代码里写了」也不算数(例:`border-collapse` 下浏览器直接忽略单元格 `border-radius`,写了不渲染)。判定题:**这次改动有 demo 吗?有 → 收尾必须有这一步** · **浮层不许贴着它挂的那个面(MANDATORY)**:下拉 / 弹层 / 提示浮出来的时候,跟触发它的那个面之间要留一条看得见的固定缝隙(顶栏语言与主题菜单就是这个样子,user 2026-08-26 拍定)。**缝隙从用户看得见的那条边算,不是从内部的 trigger 元素算** —— `sideOffset` 量的是 trigger,trigger 外面每包一层框,那层的 padding 和 border 都从缝里扣掉。判定题:**我这个浮层的 trigger,外面还套着别的框吗?套着 → 那层的 padding + border 要加进 `sideOffset`,否则用户看到的缝比设的小**。**细节实现规范见 [docs/ARCHITECTURE.md#frontend](./docs/ARCHITECTURE.md#frontend)**(命名 / 节点模型 / token 桥接 / shadcn vendor 边界 / 浮层缝隙 / 各 trap)

- **无障碍边界(MANDATORY)**:按**谁受益**划,不按「能不能操作」划 —— 后者会把键盘可达和读屏播报正好切反。**双受益的五项(键盘可达 · 焦点可见 · 视觉可读 · 错误可懂 · 语义 HTML)属于前端工业级质量,照常做**,不许拿「无障碍要不要做」当跳过的理由;**只有读屏用户受益的(`aria-label` / `aria-live` / `alt` / 读屏驱动的创作流),承诺止于「查看已有内容」** —— 生产与生成路径(生成面板 · mini-tool · 上传 · 节点编辑 · 画布操作 · 协作编辑)的读屏适配不承诺、不计入缺陷。判定题两层:**① 除了读屏用户还有别人受益吗?有 → 照常做。② 只有读屏用户受益 → 它服务的是「看到 / 听到已有内容」还是「做出新内容」?前者承诺内,后者不承诺。** 对外不得声称符合 WCAG 2.1 AA 或 EN 301 549。**这条边界是在欧盟《无障碍法案》微型企业豁免(<10 人且年营业额 ≤200 万欧元,超线即刻失效)的前提下定的,接近阈值必须重新拿给决策人审**。详见 [docs/ACCESSIBILITY.md](./docs/ACCESSIBILITY.md)

- **CLAUDE.md ↔ 细节文档边界(MANDATORY)**:**CLAUDE.md 写 mandate(整体约束 + 红线 + 判定题),不写实现细节**;细节落 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)(Backend 后端 / 跨服务 / 数据流 · Frontend 前端实现 · Coding standards 函数定义规范,三部分合一)。判定题:**这是"必须遵守的约束"还是"怎么做的细节"?** 约束 → CLAUDE.md;细节 → ARCHITECTURE.md。CLAUDE.md 提到某机制时只给一句 mandate + 指向细节文档的链接,不复制细节(细节会 drift,两处维护必失同步)

# 禁止清单

| # | 禁 |
|---|---|
| 1 | 路由层写业务 |
| 2 | Service import hono |
| 3 | Drizzle 类型泄漏 |
| 4 | 硬编码密钥 |
| 5 | `allow_origins: ["*"]` + credentials |
| 6 | 裸 SQL |
| 7 | 非原子积分扣减 |
| 8 | 裸 catch |
| 9 | `any` 类型 |
| 10 | 同步阻塞事件循环 |
| 11 | 命名函数缺 TSDoc / 显式返回类型(详见 [coding-standards](./docs/ARCHITECTURE.md#coding-standards-function-definition-format))|
| 12 | `var` / `require()` |
| 13 | YAML 中文 |
| 14 | AIGC sync 路径 |
| 15 | 非测试代码用相对路径 import(`./` / `../`)— 一律走 path alias:每个包用**全局唯一前缀** `@shared` / `@core` / `@domain` / `@collab` / `@worker` / `@server` / `@web`,**全项目无 `@/`**(规则零例外:任一包源码被另一包 resolution 上下文 import 时,`@/` 会撞车,唯一前缀消除歧义)。测试代码豁免。CI `breatic/no-relative-import` 强制(覆盖 import / 两种 re-export / 动态 `import()` / `require()` / 裸 `"."`),**带 autofix**:`pnpm lint:fix` 直接改写成正确别名,别名从文件自身路径推导、不依赖 eslint 从哪个目录启动。**判定一条 tsconfig 别名是不是死的,不能只看本包源码 grep 得到几次** —— 三个库包(`shared` / `core` / `domain`)的 `exports.types` 指向自己的 `src`(不发布 npm 的内部包一律如此,换来「改了类型立刻看到、不等构建」;应用包无 `exports`,但 `collab` 和 `worker` 被 server 的集成测试按 `@breatic/<pkg>/src/...` 直取源码,后果相同;`server` / `web` 没有任何包 import 它们),消费方 `import` 包名后 TypeScript 会进被依赖包的**源码**、撞上它内部写的别名,所以**消费方必须能解析被依赖包的内部别名**(例:`packages/web/src` 一次都不用 `@shared/*`,但 web 的 tsconfig 必须有它,否则读不了 `shared/src/index.ts`)。真判据 = **依赖图允许的方向 + 传递可达**,`grep` 零命中只是必要条件 |

# 编码行为准则

减少常见 LLM 编码错误的行为指南。这些准则偏向谨慎而非速度,简单任务自行判断。

## 1. 先想再写

**不假设,不隐藏困惑,主动暴露权衡。** 假设要明说;有多种理解就列选项让用户选,不要默默选一个;有更简单方案要说出来;有不清楚的就停下来问。

## 2. 简单优先

**写能解决问题的最少代码,不做推测性开发。** 不做超出要求的功能,单次使用不抽象,没人要的"灵活性 / 可配置"不加,不可能发生的场景不做错误处理。自检:"高级工程师会说这过度复杂吗?" 会就重写。

## 3. 精准修改

**只改必须改的,只清理自己造的废物。** 不"顺手改进"周围的代码 / 注释 / 格式,不重构没坏的东西。发现无关死代码,提一下不要删。**你的修改**导致无用的 import/变量/函数才删。检验标准:diff 每一行都应直接追溯到用户需求。

## 4. 目标驱动执行

**定义成功标准,循环直到验证通过。** 把任务转化成可验证目标("加验证"→"为非法输入写测试,然后让测试通过";"修 bug"→"写复现测试,然后让测试通过";"重构 X"→"确保重构前后测试通过")。多步任务声明简要计划:每步配验证方式。强标准让你能独立循环,弱标准("让它能跑")需要不断确认。

## 5. 彻底解决,禁止补丁(MANDATORY — 零容忍)

承接头号原则。**方案未经用户确认前不动代码**;方案不唯一时(含治本/治标取舍)列选项让用户选,不自己拍板;拿不准必须问,不猜、不"先实现一版试试";架构有根本缺陷就提架构变更,不打补丁;已有同类模式必须对齐,不发明半套。

**禁止补丁词汇**(任一即违规,立即停手):

| 类 | 词 |
|---|---|
| 兼容层 | compat shim · 兼容层 · 适配层 · legacy mirror · 只读镜像 |
| 跳过修复 | escape hatch · 全局 ref · 单例 |
| 拖延 | 临时 · 过渡 · 暂时 · 先这样 · 后续再改 |
| 范围回避 | 为了不改 N 个 callsite |
| 路径分裂 | 两条路径并存 · hybrid · 双写 |

**动手前三自检**(全过才写):(1) 解决根因还是压症状?(2) 唯一解还是从多个挑了一个?(3) 是否有任一"暂时/兼容/补丁"?

**发现自己写了补丁 → 立即撤回,不辩护、不找理由、不谈工作量。**

# Due Diligence (DD) — 重大决策纪律(MANDATORY)

**决策前的纪律**(跟决策后的 #1~#5 不互替)。完整流程 + 模板 + 反例见 [docs/DD-PROCESS.md](./docs/DD-PROCESS.md)。

**触发**(任一):

- **安全模型**(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)
- **跨界**(跨 ≥ 2 package 接口 / 数据模型 / 协议 / 关键 dep 增删升级)
- **已扩散**(已 merge 入 main / 已落 ADR 被引用 / 已发给用户)
- **架构 / 长期维护**(整体目录结构 / 公共 API / 跨服务边界)
- **状态机**(一个事实有 ≥ 2 种状态,且有 ≥ 2 条路径能改它 —— 面板 / 会话 / 任务 / 连接的生命周期,前端 store 与长跑服务尤其高发)

breatic 高频:AIGC provider 选型 · Agent / Skill 定义 · 三层记忆 / Yjs 结构 · 积分计费。

**硬流程**:候选枚举 → 5 维度尽调(实测 / 源码 / 治理 / 安全 / 上游)→ 对比矩阵(每格证据可追溯)→ 推荐 + 理由 → **用户拍板**。

**状态机必须先出转移文档,再写代码(MANDATORY)**:命中「状态机」这条触发的,**DD / 设计文档里必须写出状态转移与转换条件** —— 状态全集 · 事件全集(用户动作 / 响应回来 / 超时 / 离场都算) · **状态 × 事件的转移表,每一格都填**(不可能发生的格子写「不可能」并说明凭什么) · 每条转移的触发条件 · 任何时刻都成立的不变量 · **每个状态的唯一写入点**(多条路径要改同一个状态,先把仲裁规则写进表里)。**表填不满就是设计没做完**:空着的每一格都是一条没人定义过的路径,而代码到了运行时照样会走到它,于是每条都得等对抗或用户来发现。判定题**分两问,第一问先于第二问**:**① 这个东西从产生到用户看见,中途经过几处各自存了一份、又各自有人能改的地方?每一处都是一个独立的事实**(不经过我们代码的那几段不算);**② 对每一处各问一遍:它有几种状态、有几条路径能改它?两样都 ≥ 2 → 它是状态机,那张表必须先于实现代码存在。** **只给其中一处填表,剩下几处就是没有设计** —— 任务 #2004 实测:一份数据有四段在我们自己的代码里,交出的是其中一段的表,五轮实现对抗咬出的十条承诺内问题里,六条落在没有表的那三段。表的模板与填法见 [docs/DD-PROCESS.md](./docs/DD-PROCESS.md)。

**反 DD 模式**(违规):浅表决策(star / "感觉")· hearsay(AI 对话当 ground truth)· 假对比(候选不全)· 单点论据 · "先用 X 后续再换"(同 #5 补丁)。**未做 DD 就动手 = 当场撤回**(同 #5)。

**轻量 vs 完整**:候选明显 / 单文件 util → 轻量 Research(GitHub search 等);触发命中 → 必须完整 DD。

# Test-Driven Development (TDD) — AI coding 时代(MANDATORY)

业界共识(Anthropic / Kent Beck):TDD 在 AI 时代是关键纪律,但 AI 引入"作弊 / false confidence"风险需专门防御。完整 anti-pattern + invariant 工具见 [docs/TDD-MANDATE.md](./docs/TDD-MANDATE.md)。

**3 条硬约束**(零容忍):

1. **修 bug 必须先写复现测试**(违反 = 同 #5)
2. **重构前测试必须 green**
3. **禁止 AI 通过删除 / 禁用测试通过**(CI 监控 test 总数下降)

**节奏**:红(具体 assertion,禁 `toBeDefined()` 等 weak)→ 绿(最小实现)→ 蓝(重构 + 跑全套)。原型 / 探索期允许后置 test。

**关键路径**(支付 / 鉴权 / 数据完整性 / AI tool call / 积分扣减 / Yjs 协作)→ 100% 覆盖 + 显式 invariant + property-based(`fast-check` / `hypothesis`)。**关键路径裸奔 = P0 BUG**(整体覆盖 < 80% 不 hard block,关键路径必须满)。
