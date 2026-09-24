# @breatic/domain — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**server + worker 共享的业务内核**(AIGC 业务大脑)。装两个服务都要用、但 **collab 永不触碰**的共享业务。

## 进本包判定题
是不是 —— 只有 server + worker 共享、collab 绝不碰的业务(资产 / studio 级鉴权 / 积分"花" / 任务 / 节点历史 / agent / model-catalog / node-task)?是 → domain。若 collab 也要用 → 进 core;若只一个服务用 → 留那个服务。

## 装啥
asset(资产登记 + studio 内去重 + 回收队列 + 上传票据 + 后端上传的两个出口,server 的上传握手与 worker 的产物落库都读它)· auth(**studio 级**鉴权:`studioAuth.service` + `studioMembers.repo`;project 级那套在 core)· 积分"花"侧(credit + `markCompletedAndBill` 原子扣费)· 任务 · 节点历史 · agent(模型 / 工具 / skill 加载 / llm)· model-catalog(含每次成本 + 按用量计费的 `rate`)· node-task(一个节点上并存的任务行)。

## agent 这块的抽象判定线(MANDATORY)

**已拍板的四层**:**tool**(一次外部动作,可被任何 skill 复用)· **skill**(一件事的知识 + 它要用的 tool + 它跑在哪个模型 = 定死三样)· **workflow**(把多个 skill 编排成一条线,只跑一个 skill 时也套一层空的,所以 `Agent → workflow → skill / tool` 没有旁路)· **Agent**(拿着 skill 清单和 tool 清单跟用户对话的那个)。

**今天代码里只有三层** —— **workflow 那一层还没建**,全仓没有它的实现;Agent 直接调 skill 和 tool。写在这里是因为它是判定新东西该往哪放的依据,不是因为它已经在跑。**别照着这段去代码里找 workflow**,也别因为它不在就以为四层作废了。

**不派生**:skill 不另开进程 / 线程 / 独立 agent,一律在调用方的循环里跑。

**一个工具的全部说明只写在它自己的 description 里(MANDATORY)**:它是干什么的、什么时候用、怎么用它的答复,都在工具定义的 `description` 和各字段的 `.describe()` 里,**系统提示词(`packages/server/src/agent/context.ts`)不对任何具体工具作说明** —— 连不点名的「有一个工具……」也不行。系统提示词只放跟所有工具都相关的通用规则(调用工具而不是把调用写出来、读报错、拿不到的要说出来)。理由三条:写在别处的说明是 description 的第二份,两份必然漂;在系统提示词里告诉模型「什么时候该用某个工具」是替它做判断、给它指定倾向,而我们信任模型自己的判断;工具是可拆卸的,拆掉之后系统提示词里那段就在讲一个不存在的东西(user 2026-09-24 拍定)。**skill 同理**:它的用途和时机写在它自己的定义里,不进系统提示词。唯一的例外是 user 明确要求某个工具或 skill 特殊处理。判定题:**我正要写的这句话,是在讲某一个工具或 skill 吗?是 → 它属于那个工具或 skill 自己的定义。**

| 判定题 | 答案 |
|---|---|
| 这东西是「一次外部动作」还是「一件事的知识」? | 动作 → tool;知识 → skill |
| 它要不要另开一个上下文? | **不要**。第一版没有派生,`spawn` 那套已删 |
| 模型 / 指令 / 工具这三样谁来定? | **只有 `agent-config.ts` 的 `buildAgentConfig`**。任何第四处装配都是回到三处各写一套的老路 |
| 哪个界面能用它、谁能调起它? | **`config/skill-routing.yaml`**,不在 skill 自己的文件里(否则 skill 给自己发许可) |
| 这个 skill 该在主对话里跑还是独立跑? | 看它要不要污染主对话的上下文。**这个区别对用户完全不可见** |

**流程型 vs 对话型看 `metadata.json` 的 `output_type`**,不另立一份清单(清单会跟真相漂):`canvas` = 流程型,产物交给下一步程序(落节点 / 起任务);`inline` = 对话型,产物直接给用户读。判定题:**它的产物是给人读的,还是给下一步程序读的?**(不在这里写各有几个 —— 那个数每加一个 skill 就过期一次,字段本身才是唯一真相。)

## 可 import 谁
- ✅ `@breatic/core` · `@breatic/shared` + 外部 npm
- ❌ `@server` / `@worker` / `@collab` / `@web` —— 库不能 import 应用层(`lint:dependency-cruiser` 的 `library-no-app-import` 规则把 domain 一并扫描强制)
- 本包内部用 `@domain/*` 前缀

## 谁能 import 我
- ✅ `@server` / `@worker`
- ❌ `@collab` —— collab 是 server+worker 之外的进程,绝不碰 AIGC 业务(`lint:dependency-cruiser` 的 `collab-no-domain-import` 规则强制)

## 怎么拿配置
经 core 的 `env` Proxy / `getConfig()` / `getRawEnvVar()` 读**注入**的配置;**禁读 `process.env` / 禁 load `.env`**(同 core 纪律,`breatic/no-library-env-access` 把 domain 一并扫描强制)。

## 出错怎么办
**只 throw**(原 error 或 typed `AppError` / `InfraNotReadyError`),或返回 sentinel;**禁调 `logger.*` / `console.*`、禁 `process.exit()`**(同 core 纪律,抛给应用层;`breatic/no-library-logger`(含 `console.*`)+ ESLint 规则 `breatic/no-library-process-exit` 把 domain 一并扫描强制)。
