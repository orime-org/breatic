# @web — 包边界(MANDATORY)

> 项目级三层边界见根 [CLAUDE.md](../../CLAUDE.md#关键规范)。本文件只写本包的边界规矩,前端细节(7 层 layered / 节点模型 / 命名 / token 桥接)见 [docs/ARCHITECTURE.md#frontend](../../docs/ARCHITECTURE.md#frontend)。

## 角色
**React 前端 app**(`@breatic/web`)。不是 node 进程,**浏览器里跑**。

## 分层(包内)
7 层 layered 单向依赖:`app → pages → spaces → features → stores → domain → data → ui`(详见 [docs/ARCHITECTURE.md#frontend](../../docs/ARCHITECTURE.md#frontend))。

## 可 import 谁
- ✅ `@breatic/shared`(**唯一**能用的 workspace 包,因为它浏览器安全)+ 外部 npm
- ❌ `@breatic/core` / `@server` / `@worker` / `@collab` —— 这些是 node/后端,**前端用不了**(web ← shared,不依赖 core/server)
- 本包内部用 `@web/*` 前缀(全项目无 `@/`)

## 怎么拿配置
浏览器环境,经 `import.meta.env`(Vite,类型来自 `vite/client`,见 `src/vite-env.d.ts`);不碰 node `process.env`。

## 工业级标准
TS strict 零 `any` · 关键路径 / invariant(StrictMode-safe resource hook / Yjs 协作 / optimistic update race)100% test · a11y · i18n(ICU,禁硬编码文案,`lint:no-cjk` 强制)· 设计 token 严格(走语义 token)· 视觉改动必 ground truth + 真浏览器 verify。

## 产品术语「不翻译表」(DNT glossary,MANDATORY)
8 个产品实体 / 类型名 + 角色名是**品牌词汇,全语言永远英文**(含非英文 locale 的句子内嵌),不本地化。这是工业界 DNT(do-not-translate)惯例(Figma "Frame" / GitHub "Repository" / Notion "Database"):一份术语表 + 一个固定写法 + CI 机器守,保证全站一个名字。

| 类 | 词(永远英文) |
|---|---|
| 实体 / 类型名 | `Studio` · `Project` · `Collection` · `Space` · `Work` · `Canvas` · `Document` · `Timeline` |
| 角色名 | `Owner` · `Editor` · `Viewer` · `Admin` · `Maintainer` · `Guest` |

**三条规则**:

1. **跟英文源走形态**:句中嵌的名词,单复数 = 它对应英文源那条 key 的形态(EN `New project` → `Project`;EN `Recent projects` → `Projects`)。DNT 的标准机制是把英文源里的词原样锁住,不强制单数。
2. **只冻"指实体/类型"的引用**:`新建项目` → `新建 Project`、通知里指 Studio 实体的 `工作室` 也冻(含小写英文 `studio`,但 ICU 占位 `{studio}`/`{project}` 是变量、**绝不动**,URL `/studio/{slug}` 也不动)。
3. **同名普通词保持翻译**(不是产品实体,别冻):绘图面 canvas(`拖入素材到画布` / `画布是空的` / `无限画布`)· 视频编辑器时间轴 timeline(`mediaLibrary` / `timeline.*` / `添加到时间轴`)· "上传文件" 的 document(`project.toolbar.uploadFile`)· 旧 Workspace 壳(`enter_workspace`)。

**强制(CI 双层)**:① `lint:no-translated-product-noun` —— 黑名单扫 4 非英文 locale,无歧义的词(Project / Collection / Work / Studio / Space 的 `工作面`·`作業面` 形)译法残留即 fail(未来新文案自动管住);② `frozen-product-terms.test` —— 点名断言冻结 key 是英文,管角色 + 撞车词(Canvas / Timeline / Document / Space 的 `スペース`·`스페이스` 形,因译法跟绘图面 / 视频轴 / 文件 / Workspace 撞车不能全局禁)。

## 键盘快捷键(MANDATORY)
**所有键盘操作必须同时支持 mac 和 windows 两套快捷键** —— mac 用 `Cmd`(⌘)、windows 用 `Ctrl`;实现用 `event.metaKey || event.ctrlKey` **同认**两个修饰键,别只判一个;测试两路都覆盖。**两平台习惯不同,别照搬一套**:撤销 `Cmd+Z` / `Ctrl+Z`;重做 `Cmd+Shift+Z`(mac)/ `Ctrl+Y` + `Ctrl+Shift+Z`(win,mac 无 `Cmd+Y` redo 习惯)。
