# @web — 包边界(MANDATORY)

> 项目级三层边界见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,前端细节(7 层 layered / 节点模型 / 命名 / token 桥接)见 [docs/frontend.md](../../docs/frontend.md)。

## 角色
**React 前端 app**(`@breatic/web`)。不是 node 进程,**浏览器里跑**。

## 分层(包内)
7 层 layered 单向依赖:`app → pages → spaces → features → stores → domain → data → ui`(详见 frontend.md)。

## 可 import 谁
- ✅ `@breatic/shared`(**唯一**能用的 workspace 包,因为它浏览器安全)+ 外部 npm
- ❌ `@breatic/core` / `@server` / `@worker` / `@collab` —— 这些是 node/后端,**前端用不了**(web ← shared,不依赖 core/server)
- 本包内部用 `@web/*` 前缀(全项目无 `@/`)

## 怎么拿配置
浏览器环境,经 `import.meta.env`(Vite,类型来自 `vite/client`,见 `src/vite-env.d.ts`);不碰 node `process.env`。

## 工业级标准
TS strict 零 `any` · 关键路径 / invariant(StrictMode-safe resource hook / Yjs 协作 / optimistic update race)100% test · a11y · i18n(ICU,禁硬编码文案,`lint:no-cjk` 强制)· 设计 token 严格(走语义 token)· 视觉改动必 ground truth + 真浏览器 verify。
