# @breatic/domain — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**server + worker 共享的业务内核**(AIGC 业务大脑)。装两个服务都要用、但 **collab 永不触碰**的共享业务。

## 进本包判定题
是不是 —— 只有 server + worker 共享、collab 绝不碰的业务(积分"花" / 任务 / 节点历史 / agent / model-catalog / canvas-lock)?是 → domain。若 collab 也要用 → 进 core;若只一个服务用 → 留那个服务。

## 装啥
积分"花"侧(credit + `markCompletedAndBill` 原子扣费)· 任务 · 节点历史 · agent(模型 / 工具 / skill 加载 / extract-prompt / llm)· model-catalog(含每次成本)· canvas-lock(节点覆盖锁)。

## agent 这块的抽象判定线(MANDATORY)

**已拍板的四层**:**tool**(一次外部动作,可被任何 skill 复用)· **skill**(一件事的知识 + 它要用的 tool + 它跑在哪个模型 = 定死三样)· **workflow**(把多个 skill 编排成一条线,只跑一个 skill 时也套一层空的,所以 `Agent → workflow → skill / tool` 没有旁路)· **Agent**(拿着 skill 清单和 tool 清单跟用户对话的那个)。

**今天代码里只有三层** —— **workflow 那一层还没建**,全仓没有它的实现;Agent 直接调 skill 和 tool。写在这里是因为它是判定新东西该往哪放的依据,不是因为它已经在跑。**别照着这段去代码里找 workflow**,也别因为它不在就以为四层作废了。

**不派生**:skill 不另开进程 / 线程 / 独立 agent,一律在调用方的循环里跑。

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
