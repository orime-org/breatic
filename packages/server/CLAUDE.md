# @server — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**HTTP 壳**(Hono):把 HTTP 请求翻译成业务调用。只它认识 Hono。

## 分层(包内)
- `routes/` + `middleware/` = 路由层,**只当接线员,不写业务**(禁止清单 #1)
- 自己的**领域 service 层**(`src/modules/`,**按域分功能文件夹**:`auth/`〔auth + recovery-code + user.repo〕· `conversation/` · `memory/` · `notification/` · `payment/` · `project/`〔project + projectMembers〕· `role-upgrade-request/` · `studio/` · `skill/` · `text-tool/` · `yjs-doc/`,每域放自己的 service + repo + test,镜像 `@breatic/domain` 功能文件夹;`index.ts` barrel 统一 re-export,消费方经 `@server/modules` 整桶引)放 server 私有业务逻辑,**不 import Hono**(禁止清单 #2),**不塞进 core**(只 server 用的不进共享内核)
- `index.ts` = composition root,启动第一件事 `dotenv` + `initCore(process.env)`,是**唯一**读 env 的地方

## 可 import 谁
- ✅ `@breatic/core` · `@breatic/domain` · `@breatic/shared` · 外部 npm
- ❌ `@worker` / `@collab` —— 服务之间互不 import(共享逻辑沉 core;server+worker 共享的 AIGC 业务沉 domain)
- 本包内部用 `@server/*` 前缀

## 怎么拿配置
入口注入后,业务经 core 的 `getConfig()` / `env` Proxy 读;`src/modules/` 的领域逻辑**不直接读 `process.env`**(同 core 纪律,只入口 composition root 读)。

## 关键路径
支付 / 鉴权 / 积分扣减 / AI tool call 走 server,必 100% TDD + 结构化错误日志(application 层 catch 必 `logger.error({ err, ctx })`)。
