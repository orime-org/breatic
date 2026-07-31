# @breatic/shared — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 角色
**web + 后端共用**的纯协议层:zod schema · 类型 · 常量 · 跨服务事件契约的数据格式 · **统一 HTTP 传输层**(`http/`)与退避原语(`backoff.ts`)。

## 统一 HTTP 传输层(`src/http/`,#36 2026-07-30)
全项目**唯一**一处带重试的 HTTP:worker 的 provider 调用 · agent 的联网工具 · 浏览器上传全走它。判据在 `decide-retry.ts` 一处,分两层知识:**协议语义归传输层**(429/408 = 对方没处理 → 无条件重;其他 4xx = 请求本身的问题 → 永不重)· **应用语义由调用方声明**(`replaySafe`:再送一遍这个请求会不会产生第二次副作用 —— 只有调用方知道 `POST /predictions` 会多花一次 vendor 的钱)。**`replaySafe` 是事实陈述不是重试偏好**,别为「让它更可靠」到处开 true。重试次数(首次 + 2)与退避基数写死在 `http/constants.ts`、**故意不做配置**(原先 worker 和浏览器各配一份、已漂移成两种含义);per-attempt 超时仍是参数(不同 vendor / 不同文件大小天然不同)。判定题:**我要加的重试参数,是「各场景天然不同」还是「统一一个答案更安全」?后者 → 写死,别开旋钮。**

## 进本包判定题
web **用得到**吗?用得到 → `shared`;用不到 → `core`。

## 可 import 谁
- ✅ 外部 npm(必须**浏览器安全**:零 `node:*` / `fs` / `async_hooks`,`sideEffects: false`)
- ❌ `@breatic/core` / `@server` / `@worker` / `@collab` / `@web` —— 一个都不行(shared 是最底层)
- 本包内部用 `@shared/*` 前缀

## 暴露啥
**单入口** `src/index.ts`(`tsup` 全 bundle),不开多 subpath 入口(多入口会把 `@shared/*` 泄漏进 dist)。

## 怎么拿配置
不拿。shared 是纯数据/类型层,不读配置、不读 `process.env`、不写日志。

## 守卫
`breatic/no-relative-import`(走别名)· repo-lint 的 `no-unresolved-alias-in-dist`(dist 不漏别名)· `breatic/no-library-env-access`(零 `process.env`)· `breatic/no-library-logger`(零 logger)。
