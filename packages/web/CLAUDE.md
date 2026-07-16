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

**React 优化 hooks 是质量纪律(MANDATORY)**:`React.memo` / `useMemo` / `useCallback` 正确、彻底地应用,即便某处测不出提速也要用。判定题:**这个值 / 回调每次渲染都新建、且被传给子组件或进依赖数组吗?是 → 稳定它**;**`React.memo` 的组件其 props 必须全部稳定,否则 memo 永不 bail = 等于没 memo**(view-model 每次画布变动重建时,传给 memo 组件的数组 / 对象要单独按真实依赖 memo 化——2026-07-11 对抗曾咬出 ModelPicker 被每帧新数组击穿)。完整判定题与高频列表复用规则见根 [CLAUDE.md](../../CLAUDE.md#关键规范) 前端工业级标准段,此处不复制细节。

## 中性激活边框单一真相源(MANDATORY,CI 强制)
**凡是边框色独立表达「选中 / 聚焦 / 激活」且用黑白灰(中性色)的,一律 `border-active-border`**(= `--color-active-border`,输入框聚焦色)—— 禁止 `border-primary` / `border-foreground` / 自写灰客串激活边框(user 2026-07-11 拍板,此前分辨率选中边框曾写成 `border-primary` 漂移)。**彩色另论**:彩色语义边框(`border-status-*`、palette 七彩,如画布节点选中蓝)是另一套体系,不受此约束。判定题:**这个边框是不是在用中性色告诉用户「这项被选中 / 激活了」?是 → `border-active-border`,没有第二个选项**。**tab 激活下划线也在此列**(user 2026-07-11 拍板收编,`data-[state=active]` 进守卫扫描,别当"文字同色 indicator"豁免)。豁免:shadcn vendor(`components/ui/`,ADR 14 primitive 不动;checkbox/radio 选中边框是填充体系的一部分,非独立边框指示)。`lint:active-border` CI 强制(扫状态变体 + 中性 border 类组合;运行时拼接的条件写法扫不到,靠本条 mandate 兜底)。

## 组件复用:先查 `components/ui/` 再造(MANDATORY)
写任何**浮层 / 表单 / 交互控件**(popover · dropdown · dialog · tooltip · select · menu · command · sheet 等)前,**必须先 grep `components/ui/` 看有没有现成 shadcn primitive,有就复用**。**严禁手写浮层** —— 尤其 `fixed inset-0` 遮罩:它在 ReactFlow 的 `transform` 容器里会相对被变换的祖先定位、不覆盖真视口,导致「点画布关不掉」这类诡异 bug;Radix primitive 走 Portal 逃 transform + 自带 outside-click / Escape / 碰撞翻转,是既定用法(语言 / 主题 / `GroupBackgroundPicker` 都用 `components/ui/popover`)。判定题:**这 UI 是浮层 / 表单 / 交互控件吗?是 → 先 grep `components/ui/`,别手写**。确实需要**新建共享 primitive**(要进 `components/ui/`、design system 级,非一次性 feature 组件)→ **先跟用户确认再建**,不擅自造轮子;一次性 feature 组件(某个具体 chip / 面板)照常建、不用问。承接根 [CLAUDE.md](../../CLAUDE.md) 禁止清单外的 #5「已有同类模式必须对齐,不发明半套」,本条是其 web UI 层的具体化。

## 滚动条唯一入口:Scroller 组件(MANDATORY,CI 强制)
全站**每个可见滚动容器(纵向 + 横向)一律用 `components/ui/scroll-area.tsx` 的 `ScrollArea`**(`scrollbars` 属性选轴),**严禁**裸 `overflow-auto`/`overflow-y-auto`/`overflow-x-auto`/`overflow-scroll` 滚动容器和任何组件级滚动条样式重声明(user 2026-07-15 拍板)。判定题:**这个元素会出现滚动条吗?会 → 包 `<ScrollArea>`,没有第二个选项**(故意隐藏滚动条的滚动容器如 SpaceTabBar 用 `[scrollbar-width:none]` 豁免)。行为契约(滚动/悬停出现 · overlay 零占位 · hover/拖拽只变色 · 不扰动输入态 · 缩放安全拖拽)全部内建在组件里,细节见 [docs/ARCHITECTURE.md#key-conventions](../../docs/ARCHITECTURE.md#frontend)。`lint:no-inline-scrollbar` CI 强制。**布局陷阱**:Radix viewport 内层是自动高度 `display:table` 包裹层,`h-full` 垂直居中在里面会塌陷 —— 居中空态/加载态放 ScrollArea **外面**(StudioRecentPage 模式);内容 padding / 高度上限放 `viewportClassName`(真正滚动的元素)。

## 产品术语「不翻译表」(DNT glossary,MANDATORY)
8 个产品实体 / 类型名 + 角色名是**品牌词汇,全语言永远英文**(含非英文 locale 的句子内嵌),不本地化。这是工业界 DNT(do-not-translate)惯例(Figma "Frame" / GitHub "Repository" / Notion "Database"):一份术语表 + 一个固定写法 + CI 机器守,保证全站一个名字。

| 类 | 词(永远英文) |
|---|---|
| 实体 / 类型名 | `Studio` · `Project` · `Collection` · `Space` · `Work` · `Canvas` · `Document` · `Timeline` |
| 角色名 | `Owner` · `Editor` · `Viewer` · `Admin` · `Maintainer` · `Guest` |

**三条规则**:

1. **跟英文源走形态**:句中嵌的名词,单复数 = 它对应英文源那条 key 的形态(EN `New project` → `Project`;EN `Recent projects` → `Projects`)。DNT 的标准机制是把英文源里的词原样锁住,不强制单数。
2. **只冻"指实体/类型"的引用**:`新建项目` → `新建 Project`、通知里指 Studio 实体的 `工作室` 也冻(含小写英文 `studio`,但 ICU 占位 `{studio}`/`{project}` 是变量、**绝不动**,URL `/studio/{slug}` 也不动)。
3. **同名普通词保持翻译**(不是产品实体,别冻):绘图面 canvas(`拖入素材到画布` / `画布是空的` / `无限画布`)· 视频编辑器时间轴 timeline(`message.addedToTimeline`「添加到时间轴」)· "上传文件" 的 document(`project.toolbar.uploadFile`)· 旧 Workspace 壳(`workspace.*`)。

**强制(CI 双层)**:① `lint:no-translated-product-noun` —— 黑名单扫 4 非英文 locale,无歧义的词(Project / Collection / Work / Studio / Space 的 `工作面`·`作業面` 形)译法残留即 fail(未来新文案自动管住);② `frozen-product-terms.test` —— 点名断言冻结 key 是英文,管角色 + 撞车词(Canvas / Timeline / Document / Space 的 `スペース`·`스페이스` 形,因译法跟绘图面 / 视频轴 / 文件 / Workspace 撞车不能全局禁)。

## 键盘快捷键(MANDATORY)
**所有键盘操作必须同时支持 mac 和 windows 两套快捷键** —— mac 用 `Cmd`(⌘)、windows 用 `Ctrl`;实现用 `event.metaKey || event.ctrlKey` **同认**两个修饰键,别只判一个;测试两路都覆盖。**两平台习惯不同,别照搬一套**:撤销 `Cmd+Z` / `Ctrl+Z`;重做 `Cmd+Shift+Z`(mac)/ `Ctrl+Y` + `Ctrl+Shift+Z`(win,mac 无 `Cmd+Y` redo 习惯)。

## Toast 类型约定(MANDATORY,CI 强制)
**每条 toast 必须显式声明语义类型**:`toast.error()`(失败/出错,红)· `toast.warning()`(被守卫拦下 / 暂不可用,橙)· `toast.success()`(确认成功,绿)· `toast.info()`(中性/信息通知,蓝)。Toaster 按 sonner 的 `data-type`(由这些方法设)在 `index.css` 里上色(3px 彩色左边框 + 彩色图标,走 `--color-status-*` 设计 token);裸 `toast()` 和 `toast.message()` **无 `data-type` = 渲染成中性、丢掉严重度信号**——这正是 2026-07-15 修的 bug(错误/警告提示不上色)的根。判定题:**这条 toast 是啥语义?失败→error · 拦下/暂不可用→warning · 成功→success · 只是告知→info;没有"中性无类型"这一档**。`toast.loading` / `toast.promise` / `toast.dismiss` / `toast.custom` 是特殊用途、不算"无类型消息",照用。**ESLint `no-restricted-syntax` 强制**(`eslint.config.mts`,src 排除测试):基于 **AST** 匹配 `CallExpression`,裸 `toast(` / `toast.message(` 即报错——因为看的是**代码**不是文本,注释 / 字符串里出现 `toast(` **天然不误报**(用 AST 而非文本 grep 是刻意的:查"函数调用"这种代码语法规则,文本匹配分不清代码 vs 注释/字符串、必假阳性)。随 `pnpm lint` 跑,无独立 CI step;正当例外用 `// eslint-disable-next-line no-restricted-syntax`。**error/warning 之分**:系统/操作真的失败了(如 `clipboardError` / `reportFailed`)→ error;守卫主动拦下、暂不能做(如 `canvas.gate.locked` / `canvas.gate.handling` / `tooLarge` / `operationInProgress`)→ warning。

## 节点状态门控:locked / handling(MANDATORY,单一策略源)
画布节点有两种「冻结变更」的状态,门控规则是**单一真相源** `spaces/canvas/node-gate.ts` 的纯函数 `evaluateNodeGate(state, op)`:**每个变更入口**(删除 / 上传 / 生成执行 / 内容编辑 / 移动 / 改名)都经它判定,**keyed on 状态 + 操作、绝不 keyed on 节点类型** —— 未来 text / 音频 / 视频节点天然复用同一门,新增可生成模态时把它的变更入口接进同一策略即可,**不逐模态补 `if (locked)`**。

| 操作 | locked(用户冻结 = 冻一切) | handling(任务在写 = 冻内容相关) |
|---|---|---|
| 移动 / 改名 | 拦 | **放行**(位置 / 名字与 in-flight 内容写入正交) |
| 删除 / 编辑内容 / 上传 / 生成执行 | 拦 | 拦 |

**两条铁律**:① 被拦的**命令式**入口(键盘/菜单删除 · 上传 picker · 面板执行 · 双击进编辑)一律 `toast.warning`(走 `NODE_GATE_TOAST_KEY` → `canvas.gate.locked` / `canvas.gate.handling`),**禁静默 no-op**(用户点了没反应还不知道为啥);纯 render 层门(拖动 `draggable:false`、菜单项隐藏)可不 toast。② 生成面板对 locked / handling 节点**照常打开、prompt 照常可编辑**,只有**执行提交**被拦 —— 锁冻的是节点内容与结果,不是生成配方 prompt。判定题:**这是不是一个会改节点内容 / 位置 / 存在性的操作?是 → 经 `evaluateNodeGate` 判定,别自己手写状态检查**。策略函数 + 矩阵是本条的实现真相源(`node-gate.ts` 顶部 TSDoc)。
