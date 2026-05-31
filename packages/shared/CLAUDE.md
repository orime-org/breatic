# @breatic/shared — 包边界(MANDATORY)

> 项目级三层边界 + 进包判定题见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,细节见 [docs/architecture.md](../../docs/architecture.md)。

## 角色
**web + 后端共用**的纯协议层:zod schema · 类型 · 常量 · 跨服务事件契约的数据格式。

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
`lint:no-relative-import`(走别名)· `lint:no-unresolved-alias-in-dist`(dist 不漏别名)· `lint:no-core-process-env`(零 `process.env`)· `lint:no-library-logger`(零 logger)。
