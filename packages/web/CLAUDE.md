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
TS strict 零 `any` · 关键路径 / invariant(StrictMode-safe resource hook / Yjs 协作 / optimistic update race)100% test · a11y · i18n(ICU,禁硬编码文案,repo-lint 的 `no-cjk` 强制)· 设计 token 严格(走语义 token)· 视觉改动必 ground truth + 真浏览器 verify。

**React 优化 hooks 是质量纪律(MANDATORY)**:`React.memo` / `useMemo` / `useCallback` 正确、彻底地应用,即便某处测不出提速也要用。判定题:**这个值 / 回调每次渲染都新建、且被传给子组件或进依赖数组吗?是 → 稳定它**;**`React.memo` 的组件其 props 必须全部稳定,否则 memo 永不 bail = 等于没 memo**(view-model 每次画布变动重建时,传给 memo 组件的数组 / 对象要单独按真实依赖 memo 化——2026-07-11 对抗曾咬出 ModelPicker 被每帧新数组击穿)。完整判定题与高频列表复用规则见根 [CLAUDE.md](../../CLAUDE.md#关键规范) 前端工业级标准段,此处不复制细节。

## 写进内容里的链接用 `--color-content-link`(MANDATORY)

**chrome 保持中性说的是整体视觉效果,不是「内容里也不许有颜色」**(user 2026-08-12)。正文里的链接是那个
例外:它必须能跟周围的字分开,而**下划线一个人做不到这件事** —— 富文本正文同时提供 `Cmd+U` 的下划线标记,
实测两者的计算样式只差 `text-underline-offset`(2px 对 auto),给一段已加下划线的文字粘上 URL 屏幕上零变化。

所以内容里的链接一律 **`color: var(--color-content-link)` 加下划线两样都要**:颜色让它跟正文分开,下划线
保住「颜色不能是唯一信号」这条(WCAG 1.4.1)。这个 token 指向 palette 的 blue,而 palette 那段注释自己写着
identity 值就是给彩色文字用的;我们的 blue 锚在 Radix step 11,定值时校验过它跟 Primer 的 accent 蓝(也就是
Primer 的链接色)落在同一个行业收敛区里。业界三家(GitHub 蓝 + 下划线 ·
Notion 灰 + 下划线 · NN/g 的通则)没有一家让链接跟正文同色。

判定题:**这条链接嵌在一段话里、要让人看出它能点吗?是 → `--color-content-link` 加下划线**。chrome 里的
链接(导航、面包屑、按钮式链接)不在此列,那些靠位置和形状就说明了自己是什么,照旧走中性。

## 每一条线都是一个像素(MANDATORY,CI 强制)

**边框和焦点环一律 1px,`ring-offset` 一律不用**(user 2026-08-22 拍定)。理由是**整体观感**:粗一点的线会让界面显脏,而我们是一个给人创作的产品,chrome 要安静、要让位。

**「我有理由用粗的」不构成理由。** 想用 2px 只有一条路:**拿这一处单独去问 user,他拍板说可以**。表格的总计线、强调分隔、突出某一块 —— 这些都是理由,而理由不是通行证。

**这条是踩出来的**:2026-08-22 做积分页合计行时,已确认的 demo 写着 `border-top-width:2px`,我据此加了 `border-t-2`,被 `breatic/one-px-border` 拦下。当时我论证「守卫的注释自己写着 for no reason the user can name,而这里说得出理由」,把 demo 和守卫端成一道拍板题。user 的裁决是 **demo 改掉、守卫不动**:「没有什么必要不能用两个像素」。守卫那句措辞已经改掉,它读起来像一个说得出理由就能走的口子。

判定题:**我正要写一个大于 1px 的边框或 ring 吗?那就是错的 —— 除非 user 为这一处单独拍过板。**

## 中性激活边框单一真相源(MANDATORY,CI 强制)
**凡是边框色独立表达「选中 / 聚焦 / 激活」且用黑白灰(中性色)的,一律 `border-active-border`**(= `--color-active-border`,输入框聚焦色)—— 禁止 `border-primary` / `border-foreground` / 自写灰客串激活边框(user 2026-07-11 拍板,此前分辨率选中边框曾写成 `border-primary` 漂移)。**彩色另论**:彩色语义边框(`border-status-*`、palette 七彩,如画布节点选中蓝)是另一套体系,不受此约束。判定题:**这个边框是不是在用中性色告诉用户「这项被选中 / 激活了」?是 → `border-active-border`,没有第二个选项**。**tab 激活下划线也在此列**(user 2026-07-11 拍板收编,`data-[state=active]` 进守卫扫描,别当"文字同色 indicator"豁免)。豁免:shadcn vendor(`components/ui/`,ADR 14 primitive 不动;checkbox/radio 选中边框是填充体系的一部分,非独立边框指示)。`breatic/active-border` CI 强制(扫状态变体 + 中性 border 类组合;运行时拼接的条件写法扫不到,靠本条 mandate 兜底)。

## 组件复用:先查 `components/ui/` 再造(MANDATORY)
**写任何 UI 组件之前**,**必须先 grep `components/ui/` 看有没有现成的,有就复用**。**范围是「任何」,没有类别限定** —— 浮层 / 表单 / 交互控件固然算,**骨架屏、徽章、分隔线、头像这些纯展示的东西一样算**。这条一度写作「写任何浮层 / 表单 / 交互控件前」,而 2026-08-18 手写的那个消息骨架屏正好落在三类之外:`components/ui/skeleton.tsx` 就在那儿、仓里 5 个文件在用,我照样写了裸 `<div className='skeleton-shimmer ...'>`,还给它挑了一套比全仓任何一处都细的高度(`h-2` = 8px,而仓里文字占位最细的一处是 `h-2.5`,主流是 `h-3` / `h-4`)。**按无关属性把同类切成两半,灰色地带就会被试探** —— 所以判据只剩一个:**它是不是一个 UI 组件?是 → 先 grep。**

**三步,一步都不许跳(user 2026-08-18 定死)**:① **任何 UI 表现,先看组件库里有没有** —— 不分类别,浮层 / 表单 / 交互控件算,骨架屏 / 徽章 / 分隔线 / 头像 / 空态 / 进度条这些纯展示的一样算;② **有就用它**,别照着它再写一个(手写 `className='skeleton-shimmer'` 拿到的是同样的像素,但等于把 `Skeleton` 的实现复制了一份 —— 它以后换动画、改圆角、加分支,都跟这一处无关了);③ **确实没有才自己做,而且做出来必须跟仓里已有的视觉表现一致** —— 尺寸、间距、圆角、颜色一律去数仓里同类现在用的是什么,别自己挑一套。**理由是视觉一致性**:user 原话「不然的话,就没办法保证整个视觉效果的一致性了」。判定题:**我正要给这个新组件填一个尺寸 / 颜色 / 圆角吗?仓里同类现在用的是什么?数过了吗?**

**严禁手写浮层** —— 尤其 `fixed inset-0` 遮罩:它在 ReactFlow 的 `transform` 容器里会相对被变换的祖先定位、不覆盖真视口,导致「点画布关不掉」这类诡异 bug;Radix primitive 走 Portal 逃 transform + 自带 outside-click / Escape / 碰撞翻转,是既定用法(语言 / 主题 / `GroupBackgroundPicker` 都用 `components/ui/popover`)。判定题:**我正要写一个 UI 组件吗?是 → 先 grep `components/ui/`,别手写**。**找到了就用它,别照着它再写一个** —— 复用的是那个组件,不是它的样式类名(手写 `className='skeleton-shimmer'` 等于把 `Skeleton` 的实现抄了一遍,它以后怎么改都跟这一处无关了)。确实需要**新建共享 primitive**(要进 `components/ui/`、design system 级,非一次性 feature 组件)→ **先跟用户确认再建**,不擅自造轮子;一次性 feature 组件(某个具体 chip / 面板)照常建、不用问。承接根 [CLAUDE.md](../../CLAUDE.md) 禁止清单外的 #5「已有同类模式必须对齐,不发明半套」,本条是其 web UI 层的具体化。

## 有 demo 的改动,收尾必须跟 demo 逐项量(MANDATORY)

新增界面 / 改布局 / 改关键状态,规矩是先出 demo 给用户确认(根 [CLAUDE.md](../../CLAUDE.md) 前端工业级标准段)。**确认过的 demo 是验收基准,不是参考图** —— 所以功能做完、**尤其是 smoke 那一步**,必须多一个动作:把 demo 写死的视觉决定(圆角 · 对齐 · 间距 · 哪一格空着 · 哪些元素在同一行)列出来,在**真机上**用 `getComputedStyle` 和 `getBoundingClientRect` 逐条取值比。

**判定题:这次改动有 demo 吗?有 → smoke 里必须有这一步,而且是量出来的数,不是「看着差不多」。**

**为什么不能靠看**:#106 会员面板,四条 Stripe 路径在真机上全跑通、日志全对、截图也发出去了,用户一眼看出两处跟他确认过的 demo 不一样(高亮列该有 6px 圆角做成了直角;取消入口该在底部跟联系方式并成一行,被摆到了档位名右边)。两处都不是设计没写,是写了没照做 —— 而截图我自己看过觉得没问题,**因为脑子里没有那份 demo 的样子,只有刚写完的代码的样子**。

**「代码里写了」也不算数**:同一次里,圆角的 class 加上去了却不渲染 —— 表格在 `border-collapse`(合并边框模型)下浏览器**直接忽略单元格的 `border-radius`**,必须 `border-separate` + `border-spacing-0` 才画得出来。这类「写了不生效」只有量真机才发现得了。

## 按钮只有一种拼法:一律走 `Button` primitive(MANDATORY,CI 强制)

**`packages/web` 里禁止手写 `<button>`,一律用 `components/ui/button` 的 `Button`**(user 2026-08-08 拍定,原话「所有 button 不允许小写,必须都是大写」)。`createElement('button')` 是同一个元素换个写法,同样禁。

**为什么是禁令而不是"尽量"**:一个元素两种拼法,任何关于按钮的检查都只看得见它被教过的那一种,另一种就成了没人管的地方 —— 当初画布里那三个无边框文字按钮正是写在手写 `<button>` 上,而当时那道只认 `Button` 组件的边框检查盯着组件、报告一切正常(那道检查已不存在,见下一节)。**一种拼法把这个问题消掉,而不是逐个回答它。**

**什么都没有牺牲**:`Button` 继承 `React.ButtonHTMLAttributes<HTMLButtonElement>` 并透传收到的一切,`type` / `role` / `aria-*` / `data-*` 和自定义 class 原样通过;触发器归别的 primitive 拥有时用 `asChild` 把元素交出去。裸 `<button>` 能做的,`<Button>` 都能做。

**换写法的时候不许顺手改外观(MANDATORY)**:把一个手写 `<button>` 改成 `Button` 是**换写法**,不是重新设计它。原来的 `className` **一个字都不动**,变体和尺寸一律 `variant={null} size={null}` —— cva 只在这两个属性是 `undefined` 时才套默认值,显式给 `null` 就一个变体类都不出,外观完全由这个按钮自己原来的样式决定。**别把原来写在 `className` 里的边框挪进变体**,那会让这个按钮从此依赖变体、换个变体就变样。

判定题:**我这次是在换写法,还是在改这个按钮长什么样?换写法 → `variant={null} size={null}`,className 原样不动。**

**这条是踩出来的**:82 处转换时我按「文字按钮该有边框」给每个按钮挑了变体,结果左侧栏、思考过程折叠头、生成面板等二十来处凭空多了边框和底色,还有若干处的高度被 `size` 改掉;user 逐一指出来才退回去(2026-08-08)。

**反过来的情形不归这条管:这个按钮本来就是 `Button`,而它要的外观逐字就是某个现成变体(MANDATORY)**。上面那条约束的是**换写法**那一刻 —— 手写 `<button>` 变成 `Button`,此时挑变体等于顺手改外观。它**不是**在说「`Button` 一律不许用变体」:如果一个按钮从来就是 `Button`,而设计系统里已经有一个变体在描述它想要的样子,**用那个变体,别把变体的类手抄进 `className`**。

判定题:**我是在换写法(手写 `<button>` → `Button`),还是在给一个本来就是 `Button` 的按钮选它该有的变体?** 前者 `variant={null}`;后者用变体。

**怎么确认「逐字就是」**:把手写的那串类跟 `buttonVariants` 的 base 和目标变体逐个比对,再在真机上比一遍两种写法的计算样式 —— 零差异才叫同一件事,有差异就是在改外观、退回上一条。

**这条也是踩出来的**:2026-08-11 做 rail 时,我看到折叠箭头和汉堡按钮写得逐字相同,把共享的类抽成了一个函数;对抗指出那 14 个类里 7 个是 base 无条件给的、3 个逐字就是 `chrome-ghost`,只有尺寸是自己的 —— 我做的是「给重复起个名字」,而不是「用已经有的那个」。换成 `variant='chrome-ghost'` 后计算样式零差异,函数删掉。**症状是「两处代码写得一模一样」时,先问「设计系统里是不是已经有一个名字在说这件事」,再考虑抽共用的东西。**

**真要给某个按钮定变体时,`className` 怎么跟变体类合并要弄清楚**:`cn()` 走 twMerge,**只在同一个 utility 组里让后写的赢** —— 你写的 `bg-muted` 盖得掉变体的 `bg-background`;但带 modifier 的自成一组,变体的 `hover:bg-accent` **不会**被一个无 modifier 的 `bg-*` 盖掉。所以**给了自定义底色就必须把 hover 一起重述**,否则鼠标一放上去你的底色就被变体的 hover 顶掉。选中态尤其容易踩:选中项的底色被 hover 顶掉之后,它跟一个被 hover 的未选中项长得一模一样。

**CI 强制**:`breatic/no-raw-button`(ESLint),扫 `src/**/*.{ts,tsx}`(`.ts` 也扫 —— `createElement('button')` 这种写法就住在普通模块里)。**豁免按出身不按目录**:只放行 `components/ui/button.tsx` 一个文件(`Button` 自己要渲染这个元素),**不放行整个 `components/ui/`** —— 那个目录不是纯 vendor,`password-input` 是我们自己的。另豁免 `_dev` 陈列页(它的用途就是把被替换掉的原生控件并排展示)和测试。

## 按钮的边框:看着定,不上机器守卫(MANDATORY)

**独立摆着的文字按钮应当有边框**(user 2026-08-07 原话「你连个边框都没有,用户是看不出来它是个按钮的」),包括弹窗的「取消」。写新按钮时按这条办:一段文字单独摆着能点 → 给它 `variant='outline'`。

**但这条不上 CI**(user 2026-08-08 拍定,原话「这个问题能明确,现在应该是有边框的,把它改成有边框的就行了,其他的就不要管了。等我发现有问题的时候,我就会说这个地方改」)。原因是**机器判不了**:一个按钮该不该有边框,取决于它最终被放进什么容器里(下拉菜单的行、已有边框的卡片内部、标签条),而那个容器写在别的文件、运行时才拼起来 —— ESLint 一次只读一个文件,看不到。硬要机器判,它就只能拿一个看得见的属性(比如 size)去代理那个看不见的前提,而那道缝就是往后每一轮补丁的来源。**想给这条加 lint 规则的念头出现时,回来读这一段。**

判定题:**这个按钮是独立摆着的一段文字吗?是 → `outline`。它的框由外面那层(菜单行 / 卡片 / 标签条)画吗?画了就别自己再画一个。** 两问都拿不准时**默认给 `outline`**;视觉上不对由人在真界面上指出来再摘掉。

## 禁止浏览器 / OS 原生渲染的交互控件(MANDATORY,CI 强制)
**凡「视觉皮肤由浏览器 / 操作系统绘制」的交互控件,一律禁用,必须自绘(Radix primitive 或自绘组件)。** 根因:各引擎(Chrome / Safari / Firefox)画同一个原生控件长得不一样,**对创作类产品这种跨引擎不一致是致命的**;「跨引擎像素一致」是硬功能需求,不是锦上添花。这是滚动条 / toast / tooltip 那些单点守卫背后的**总原则** —— 它们都是本条的实例,本条把教训泛化,让每个新原生控件(color → range → 未来 date)被**机械挡住**,而不是每次靠真机 review 一个个逮。

**判定题:这个 UI 的样子是浏览器 / OS 画的吗?是 → 自绘,没有第二个选项。**

**禁用清单 + 自绘替代(primitive 登记表)**:

| 原生(禁) | 引擎不一致点 | 自绘替代(用这个) |
|---|---|---|
| `<input type=color>` | 色块 + OS 取色弹窗 | react-colorful 进 Radix Popover(见 `EmptyImageColorPicker`) |
| `<input type=range>` | thumb / track 形状(Safari 胶囊 vs Chrome 圆) | `<Slider>`(`components/ui/slider`,Radix) |
| `<input type=date/time/…>` | 日历 / spinner 弹层每浏览器天差地别 | 自绘 date picker(需要时先在 `components/ui/` 建一个) |
| `<select>` 原生下拉 | OS 画的 option 列表 | `<Select>`(`components/ui/select`,Radix) |
| `<audio>/<video controls>` | OS 原生播放条 | 自绘 `MediaPlayer`(不挂 `controls`) |
| 原生滚动条 | thumb 宽度 / hover / 色 UA 私有 | `<ScrollArea>`(见下条) |

**CI 强制**:ESLint 规则 `breatic/no-native-rendered-ui` 机械挡上表**能从 JSX 结构精确判定的子集**(color / date / time / range / 裸 `<select>` / 带 `controls` 的 media);注释里提及被禁形**天然不算违规** —— AST 不含注释,旧的文本守卫才需要专门过滤注释行。**逃生舱**:极少数正当例外在同一行加 `native-ui:allow` + 理由注释。**mandate-only(grep 太吵、不上 CI,靠本条人守)**:`title=` 当 tooltip 用(vs iframe/svg 的合法 a11y label)· 原生表单校验气泡 —— 这两类也禁,只是机械守卫覆盖不到,别以为不在 CI 里就能用。**元教训**:「简单优先」在这类问题上权重会错 —— 原生控件是「最少代码 + 功能能跑」,但「功能能跑」≠「可接受」,视觉确定性对创作类产品是硬需求(2026-07-21 user 拍板,承 color/scrollbar 反复踩坑)。

## 滚动条唯一入口:Scroller 组件(MANDATORY,CI 强制)
全站**每个可见滚动容器(纵向 + 横向)一律用 `components/ui/scroll-area.tsx` 的 `ScrollArea`**(`scrollbars` 属性选轴),**严禁**裸 `overflow-auto`/`overflow-y-auto`/`overflow-x-auto`/`overflow-scroll` 滚动容器和任何组件级滚动条样式重声明(user 2026-07-15 拍板)。判定题:**这个元素会出现滚动条吗?会 → 包 `<ScrollArea>`,没有第二个选项**(故意隐藏滚动条的滚动容器如 SpaceTabBar 用 `[scrollbar-width:none]` 豁免)。行为契约(滚动/悬停出现 · overlay 零占位 · hover/拖拽只变色 · 不扰动输入态 · 缩放安全拖拽)全部内建在组件里,细节见 [docs/ARCHITECTURE.md#key-conventions](../../docs/ARCHITECTURE.md#frontend)。`breatic/no-inline-scrollbar` CI 强制。**布局陷阱**:Radix viewport 内层是自动高度 `display:table` 包裹层,`h-full` 垂直居中在里面会塌陷 —— 居中空态/加载态放 ScrollArea **外面**(StudioRecentPage 模式);内容 padding / 高度上限放 `viewportClassName`(真正滚动的元素)。

## 产品术语「不翻译表」(DNT glossary,MANDATORY)
8 个产品实体 / 类型名 + 角色名 + `Slug` 是**品牌词汇,全语言永远英文**(含非英文 locale 的句子内嵌),不本地化。这是工业界 DNT(do-not-translate)惯例(Figma "Frame" / GitHub "Repository" / Notion "Database"):一份术语表 + 一个固定写法 + CI 机器守,保证全站一个名字。

| 类 | 词(永远英文) |
|---|---|
| 实体 / 类型名 | `Studio` · `Project` · `Collection` · `Space` · `Work` · `Canvas` · `Document` · `Timeline` |
| 角色名 | `Owner` · `Editor` · `Viewer` · `Admin` · `Maintainer` · `Guest` |
| 字段名 | `Slug`(2026-07-29 收编)—— 界面上首字母大写写作 `Slug`(含句中),**但 slug 的值一律原样小写**(它是真实 URL 的一部分,显示成 `Orime-studio` 会跟地址栏的 `orime-studio` 对不上)|

**三条规则**:

1. **跟英文源走形态**:句中嵌的名词,单复数 = 它对应英文源那条 key 的形态(EN `New project` → `Project`;EN `Recent projects` → `Projects`)。DNT 的标准机制是把英文源里的词原样锁住,不强制单数。
2. **只冻"指实体/类型"的引用**:`新建项目` → `新建 Project`、通知里指 Studio 实体的 `工作室` 也冻(含小写英文 `studio`,但 ICU 占位 `{studio}`/`{project}` 是变量、**绝不动**,URL `/studio/{slug}` 也不动)。
3. **同名普通词保持翻译**(不是产品实体,别冻):绘图面 canvas(`拖入素材到画布` / `画布是空的` / `无限画布`)。**规则照旧,但只剩这一个例子** —— Workspace 壳、视频编辑器时间轴、"上传文件" 的 document 这三个原例的文案都在 2026-08-01 的死文案清理里删了(产品里没有任何地方读它们),`git log locales/` 可查。这里不再写出那几个 key 名:它们已经不存在,写着只会让人以为还能去 catalog 里找。下次再出现「同名普通词」照这条判。

**强制(CI 双层)**:① repo-lint 的 `no-translated-product-noun` —— 黑名单扫 4 非英文 locale,无歧义的词(Project / Collection / Work / Studio / Space 的 `工作面`·`作業面` 形)译法残留即 fail(未来新文案自动管住);② `frozen-product-terms.test` —— 点名断言冻结 key 是英文,管角色 + 撞车词(Canvas / Timeline / Document / Space 的 `スペース`·`스페이스` 形,因译法跟绘图面 / 视频轴 / 文件 / Workspace 撞车不能全局禁)。

## 键盘快捷键(MANDATORY)
**所有键盘操作必须同时支持 mac 和 windows 两套快捷键** —— mac 用 `Cmd`(⌘)、windows 用 `Ctrl`;实现用 `event.metaKey || event.ctrlKey` **同认**两个修饰键,别只判一个;测试两路都覆盖。**两平台习惯不同,别照搬一套**:撤销 `Cmd+Z` / `Ctrl+Z`;重做 `Cmd+Shift+Z`(mac)/ `Ctrl+Y` + `Ctrl+Shift+Z`(win,mac 无 `Cmd+Y` redo 习惯)。

## Toast 单一入口约定(MANDATORY,CI 强制)
**全站 toast 只走一个 wrapper `@web/lib/toast`,禁从 `sonner` 直接 import `toast`**(user 2026-07-18)。这一个入口同时锁住两条不变量,别处无法绕过:

1. **带类型**:wrapper 只暴露 `toast.error()`(失败/出错,红)· `toast.warning()`(被守卫拦下 / 暂不可用,橙)· `toast.success()`(确认成功,绿)· `toast.info()`(中性/信息通知,蓝)+ 透传 `loading` / `promise` / `dismiss` / `custom`。**没有裸 `toast()` / `toast.message()`**——它们在 wrapper 上不可调(TS 直接报错),这就把旧的「toast 必带类型」规则**吸收进类型系统**了。Toaster 按 sonner 的 `data-type` 在 `index.css` 上色(3px 彩色左边框 + 彩色图标,走 `--color-status-*` token);无 `data-type` = 中性、丢严重度信号(2026-07-15 bug 的根)。
2. **内容去重**:wrapper 给每条自动加 `id = type:message`,sonner 按 id 去重 → **同内容快速重复只刷新那一条**(重置计时),不堆成一摞空条(user 2026-07-18「新刷新旧」);**不同内容仍各自堆叠**,不吞信息。要固定 id(如 `warnNodeGate` 的 `canvas-node-gate`)传 `opts.id` 覆盖即可。非字符串 message(ReactNode)无内容 key、不自动加 id。

判定题:**要弹 toast?`import { toast } from '@web/lib/toast'`,选 error/warning/success/info —— 永远别 import 'sonner'**。**error/warning 之分**:系统/操作真失败(`clipboardError` / `reportFailed`)→ error;守卫主动拦下、暂不能做(`canvas.gate.locked` / `tooLarge` / `operationInProgress`)→ warning。**豁免**:wrapper 自己(`lib/toast.ts`)+ Toaster(`components/ui/sonner.tsx`)+ 测试(mock/spy sonner,wrapper 委托 sonner、sonner 级 spy 仍捕获)+ `pages/_dev/`。`breatic/single-toast-entry` ESLint 规则强制(禁 `src` 里非豁免文件从 `sonner` import;单双引号都抓 —— 旧的文本守卫只认单引号)。

## Tooltip 单一 provider(MANDATORY,CI 强制)
**全站只有一个 `<TooltipProvider>`,挂在 `App.tsx`**。它的 `delayDuration`(100ms)是全站校正过的统一时机,Radix 的 skip-delay 分组(扫过一串 trigger 时后续 tooltip 立即弹、不重等 delay)**只在同一个 provider 实例内生效**。组件里**再嵌套一个 `TooltipProvider` = 覆盖那一片子树的时机 + 把它拆成独立 skip-delay 组** —— 这正是 shipped 过两次的 bug(GenerateToolbar `delayDuration=300` 让 user 报「tip 出现时间不对」#337;ThumbnailHoverPreview `delayDuration=200`)。判定题:**要给某处加 tooltip?直接用 `Tooltip`/`TooltipTrigger`/`TooltipContent`,它天然继承 App 的 provider —— 永远别自建 `TooltipProvider`**。**TipTap NodeView 也继承**:`@tiptap/react` 用 `ReactDOM.createPortal` 把 NodeView 挂进 editor 的 contentComponent(在 App.tsx 之下),portal 继承 React context,所以 `@` chip 这类 NodeView 子树照样看得到 App 的 provider(2026-07-17 源码 + 真机双证,推翻「NodeView 脱离 provider」的旧假设)。豁免:`pages/_dev/`(独立 gallery)· 测试(自己包 provider 模拟 App)。`breatic/single-tooltip-provider` ESLint 规则强制(抓 `App.tsx` 外的 JSX `<TooltipProvider>`)。**primitive 定义文件不再需要豁免** —— `components/ui/tooltip.tsx` 里那几个 `<TooltipProvider>` 全在 JSDoc 示例里,AST 不看注释,旧的文本守卫才需要为它开口子。这条是「看似合理的造轮子」的活教材:嵌套 provider 有个听着对的理由(统一时机 / NodeView 边界),但一实证就站不住 —— **加 provider 前先问「App 那个不够用吗?为什么?」并实证,别照假设造**。

## 画布内浮层必须跟随视口(MANDATORY)
生成面板 —— **以及未来所有画布内的生成 / mini-tool 面板(视频 / 音频 / 文本生成、mini-tool 编辑面板等)** —— 里**任何锚在节点上的 Radix 浮层**(Popover / Tooltip / DropdownMenu…)打开时必须**跟随画布 pan / zoom**、相对触发它的节点固定,**不是固定在屏幕**。原因:Radix 的 Floating-UI autoUpdate 只认 scroll / resize、**不认祖先 CSS-transform**,而 ReactFlow 靠 transform 做 pan/zoom → 不接跟随的浮层会漂离节点(user 2026-07-19 报 model picker / mode 下拉 / hover 预览都漂,#1796)。做法二选一:① Radix 浮层(picker / tooltip)= `useFollowCanvasViewport(open)`(`spaces/canvas/generate/use-follow-canvas-viewport.ts`,盯 `.react-flow__viewport` 的 transform 变化→每帧 nudge 重定位)**+ `avoidCollisions={false}`**(碰视口边直接裁、不 flip/shift —— flip 会和跟随打架跳来跳去,user 拍板 clip-not-jump);② caret 锚定的 `@` suggestion 浮层 = floating-ui `autoUpdate({ animationFrame: true })`(每帧从 live caret rect 重算)。判定题:**这个浮层开在画布里、锚在某个节点 / caret 上吗?是 → 上面二选一,别只靠 Radix 默认定位**。参照实现:`RatioResolutionPicker` / `CameraPicker` / `ModelPicker` / `ImageModeToggle` / `HoverPreview`(节点历史 + 生成面板 chip 的统一 hover 预览,`followCanvas` prop 切跟随 / 屏幕两套)。

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
