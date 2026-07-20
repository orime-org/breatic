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

## Toast 单一入口约定(MANDATORY,CI 强制)
**全站 toast 只走一个 wrapper `@web/lib/toast`,禁从 `sonner` 直接 import `toast`**(user 2026-07-18)。这一个入口同时锁住两条不变量,别处无法绕过:

1. **带类型**:wrapper 只暴露 `toast.error()`(失败/出错,红)· `toast.warning()`(被守卫拦下 / 暂不可用,橙)· `toast.success()`(确认成功,绿)· `toast.info()`(中性/信息通知,蓝)+ 透传 `loading` / `promise` / `dismiss` / `custom`。**没有裸 `toast()` / `toast.message()`**——它们在 wrapper 上不可调(TS 直接报错),这就把旧的「toast 必带类型」规则**吸收进类型系统**了。Toaster 按 sonner 的 `data-type` 在 `index.css` 上色(3px 彩色左边框 + 彩色图标,走 `--color-status-*` token);无 `data-type` = 中性、丢严重度信号(2026-07-15 bug 的根)。
2. **内容去重**:wrapper 给每条自动加 `id = type:message`,sonner 按 id 去重 → **同内容快速重复只刷新那一条**(重置计时),不堆成一摞空条(user 2026-07-18「新刷新旧」);**不同内容仍各自堆叠**,不吞信息。要固定 id(如 `warnNodeGate` 的 `canvas-node-gate`)传 `opts.id` 覆盖即可。非字符串 message(ReactNode)无内容 key、不自动加 id。

判定题:**要弹 toast?`import { toast } from '@web/lib/toast'`,选 error/warning/success/info —— 永远别 import 'sonner'**。**error/warning 之分**:系统/操作真失败(`clipboardError` / `reportFailed`)→ error;守卫主动拦下、暂不能做(`canvas.gate.locked` / `tooLarge` / `operationInProgress`)→ warning。**豁免**:wrapper 自己(`lib/toast.ts`)+ Toaster(`components/ui/sonner.tsx`)+ 测试(mock/spy sonner,wrapper 委托 sonner、sonner 级 spy 仍捕获)+ `pages/_dev/`。`lint:single-toast-entry` CI 强制(`scripts/lint-single-toast-entry.sh`,带 matcher 自检;禁 `src` 里非豁免文件 `import { toast } from 'sonner'`)。

## Tooltip 单一 provider(MANDATORY,CI 强制)
**全站只有一个 `<TooltipProvider>`,挂在 `App.tsx`**。它的 `delayDuration`(100ms)是全站校正过的统一时机,Radix 的 skip-delay 分组(扫过一串 trigger 时后续 tooltip 立即弹、不重等 delay)**只在同一个 provider 实例内生效**。组件里**再嵌套一个 `TooltipProvider` = 覆盖那一片子树的时机 + 把它拆成独立 skip-delay 组** —— 这正是 shipped 过两次的 bug(GenerateToolbar `delayDuration=300` 让 user 报「tip 出现时间不对」#337;ThumbnailHoverPreview `delayDuration=200`)。判定题:**要给某处加 tooltip?直接用 `Tooltip`/`TooltipTrigger`/`TooltipContent`,它天然继承 App 的 provider —— 永远别自建 `TooltipProvider`**。**TipTap NodeView 也继承**:`@tiptap/react` 用 `ReactDOM.createPortal` 把 NodeView 挂进 editor 的 contentComponent(在 App.tsx 之下),portal 继承 React context,所以 `@` chip 这类 NodeView 子树照样看得到 App 的 provider(2026-07-17 源码 + 真机双证,推翻「NodeView 脱离 provider」的旧假设)。豁免:`components/ui/tooltip.tsx`(primitive 定义,JSDoc 示例)· `pages/_dev/`(独立 gallery)· 测试(自己包 provider 模拟 App)。`lint:single-tooltip-provider` CI 强制(扫 `App.tsx` 外的 `<TooltipProvider>`;带 matcher 自检防假绿)。这条是「看似合理的造轮子」的活教材:嵌套 provider 有个听着对的理由(统一时机 / NodeView 边界),但一实证就站不住 —— **加 provider 前先问「App 那个不够用吗?为什么?」并实证,别照假设造**。

## 画布内浮层必须跟随视口(MANDATORY)
生成面板 —— **以及未来所有画布内的生成 / mini-tool 面板(视频 / 音频 / 文本生成、mini-tool 编辑面板等)** —— 里**任何锚在节点上的 Radix 浮层**(Popover / Tooltip / DropdownMenu…)打开时必须**跟随画布 pan / zoom**、相对触发它的节点固定,**不是固定在屏幕**。原因:Radix 的 Floating-UI autoUpdate 只认 scroll / resize、**不认祖先 CSS-transform**,而 ReactFlow 靠 transform 做 pan/zoom → 不接跟随的浮层会漂离节点(user 2026-07-19 报 model picker / mode 下拉 / hover 预览都漂,#1796)。做法二选一:① Radix 浮层(picker / tooltip)= `useFollowCanvasViewport(open)`(`spaces/canvas/generate/use-follow-canvas-viewport.ts`,盯 `.react-flow__viewport` 的 transform 变化→每帧 nudge 重定位)**+ `avoidCollisions={false}`**(碰视口边直接裁、不 flip/shift —— flip 会和跟随打架跳来跳去,user 拍板 clip-not-jump);② caret 锚定的 `@` suggestion 浮层 = floating-ui `autoUpdate({ animationFrame: true })`(每帧从 live caret rect 重算)。判定题:**这个浮层开在画布里、锚在某个节点 / caret 上吗?是 → 上面二选一,别只靠 Radix 默认定位**。参照实现:`RatioResolutionPicker` / `CameraPicker` / `ModelPicker` / `ImageModeToggle` / `ThumbnailHoverPreview`。

## 节点状态门控:locked / handling(MANDATORY,单一策略源)
画布节点有两种「冻结变更」的状态,门控规则是**单一真相源** `spaces/canvas/node-gate.ts` 的纯函数 `evaluateNodeGate(state, op)`:**每个变更入口**(删除 / 上传 / 生成执行 / 内容编辑 / 移动 / 改名)都经它判定,**keyed on 状态 + 操作、绝不 keyed on 节点类型** —— 未来 text / 音频 / 视频节点天然复用同一门,新增可生成模态时把它的变更入口接进同一策略即可,**不逐模态补 `if (locked)`**。

| 操作 | locked(节点**自身** `data.locked` = 冻该节点一切) | handling(任务在写 = 冻内容相关) |
|---|---|---|
| 移动 / 改名 | 拦 | **放行**(位置 / 名字与 in-flight 内容写入正交) |
| 删除 / 编辑内容 / 上传 / 生成执行 | 拦 | 拦 |

**两条铁律**:① 被拦的**命令式**入口(键盘/菜单删除 · 上传 picker · 面板执行 · 双击进编辑)一律 `toast.warning`(走 `NODE_GATE_TOAST_KEY` → `canvas.gate.locked` / `canvas.gate.handling`),**禁静默 no-op**(用户点了没反应还不知道为啥);**拖动锁定节点/组**虽 `draggable:false`(ReactFlow 不发拖拽事件),也经画布层**拖动手势探测**(pointerdown 命中 frozen 节点 + 移动超阈值)弹 `canvas.gate.locked`(A.1,user 2026-07-18;单击无位移不弹、区分选中 vs 拖动);只有**纯被动、无手势可探**的 render 门(菜单项隐藏)才静默。② 生成面板对 locked / handling 节点**照常打开、prompt 照常可编辑**,只有**执行提交**被拦 —— 锁冻的是节点内容与结果,不是生成配方 prompt。判定题:**这是不是一个会改节点内容 / 位置 / 存在性的操作?是 → 经 `evaluateNodeGate` 判定,别自己手写状态检查**。策略函数 + 矩阵是本条的实现真相源(`node-gate.ts` 顶部 TSDoc)。

**锁有两种作用域,别混为一谈(MANDATORY,user 2026-07-20)**:

| 作用域 | 冻什么 | 不冻什么 |
|---|---|---|
| **① 节点自身锁**(`node.data.locked`)| 该节点**一切**(内容 / 名字 / 内联编辑 / 上传 / 生成执行 / 移动 / 删除)—— 上表「冻一切」指这个 | — |
| **② 组锁**(`group.data.locked`)| 只冻**几何**(成员移动 / 拖动)+ **结构**(加/删成员:reparent-in、paste-into、ungroup、删成员;组自身移动 / 删除)+ **组自身身份**(组名 / 组位置 / 缩放)| **成员的内容 / 名字 / 内联编辑 / 生成 / 上传 / 连线** —— 这些一律跟随**各成员自己的** `data.locked` |

**边是逻辑关系,永不受锁门控**(节点锁 + 组锁都不锁边;`onConnect` 已不 gate,删边同理对称)—— 删边只跟随「端点是否真被删」(防悬空),显式删边一律放行。判定题:**这个门控的是「几何 / 结构 / 组身份」还是「成员内容 / 名字 / 关系」?前者 → group-aware 冻结集(`group-membership.ts` 的 `lockedNodeIds`,只接进 move 的 draggable + delete 的节点侧);后者 → 节点自身 `data.locked`(fresh 读),别把内容门 group-aware 化**。实现真相源 = `group-membership.ts` 顶部 TSDoc。
