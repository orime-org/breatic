# Roadmap

## Alpha — Core Flow（让整个链路跑通）

**目标**：一个用户能打开画布 → 和 Agent 对话 → 生成 AIGC 内容 → 看到结果。

### API + Worker

- [x] 前后端 API 对接：shared Zod schemas，8 个前端 API 文件，类型共享
- [x] API key 配置 + Agent 聊天验证：OpenRouter + WaveSpeed 实测通过
- [x] AIGC 图片生成全链路：canvas/tasks → Worker → WaveSpeed → 下载 → 本地存储
- [x] Storage 统一重构：Transport 返回 raw bytes，Worker 统一 persist（buffer 上传 + CDN 下载）
- [x] 模型目录精简：~102 → 50 个模型，只保留顶尖模型
- [x] AIGC 调用耗时记录：tasks 表 duration_ms 列，performance.now() 计时
- [x] 阿里云 OSS 存储：AIGC 结果上传 OSS，CDN 前缀 resource.visiony.cc
- [x] WaveSpeed 参数修复：null 值过滤 + MiniMax lyrics fallback
- [x] Image + Audio 模态验证：nano-banana-pro (54s) + minimax-music-2.5 (119s) 全链路通过
- [x] 全模态 AIGC 验证：Video/TTS/3D 全部通过，含 OSS 存储 + durationMs
- [x] 视频封面提取：生成视频用 worker ffmpeg 抽首帧、上传视频用前端 canvas 抽首帧（#1816，视频+封面原子一体上传），统一存节点 `coverUrl`
- [x] 视频封面消费点统一显示（#1824，吸收 #1822）：上传视频封面在全部消费点显示——node-history 行 / 活动流行（server 从 `cover_key`/`cover_hash` 派生 URL 存进记录，客户端 URL 不可信）/ 生成面板参考列表 / @ chip / @ 下拉候选 / 视频节点自身；封面 + 裁剪图带 `derived` flag 归 ledger、不占独立活动流行（产品模型 A）
- [x] Drizzle migration：last_consolidated_turn、tokens_used、model、provider 已就位
- [ ] 集成测试：testcontainers 真实 PG + Redis，覆盖核心链路

### Collab

- [x] Yjs 文档结构规范：canvas Map-of-Maps schema、状态机、事件流、锁语义已落地；CanvasNodeFields + AttachRef 共享类型在 @breatic/shared
- [x] Canvas 节点同步：Redis Streams + 节点锁，API/Worker/Collab 三方事件驱动写入 canvas.nodesMap
- [x] Canvas Yjs-first 同步架构：前端写操作直接写 Yjs nodesMap/edgesMap，observe 回调同步 Redux（只读缓存），删除旧的 Redux↔Yjs 双向桥
- [x] Canvas 嵌套 data Y.Map：节点结构镜像 ReactFlow `{ id, type, position, data }`，增量 observe 只重建变更节点
- [ ] Awareness 集成：光标位置、在线用户列表、正在编辑的节点高亮

### Frontend

- [x] 前端组件迁移：27 组件从 useProjectStore 迁移到 useCanvasData/Actions/UI
- [x] 安全加固：Auth 限速、FK restrict、锁 CAS 验证、presign 安全、prompt 提取（XSS 清洗一项已撤：产品代码现在不渲染任何用户提供的 HTML，也就没有 sanitize 环节 —— 见 CLAUDE.md「XSS / Prompt」）
- [x] 测试覆盖恢复：17 文件 65 测试（从 5 文件 21 测试）
- [ ] 前后端联调：SSE 流式聊天跑通，AIGC 任务状态同步
- [ ] 模型参数动态表单：根据 `GET /api/v1/models` 返回的 params 动态渲染 UI（模态模板 + tier 过滤）
- [ ] 认证页面：登录 / 注册 / Google OAuth 对接后端 auth 路由
- [ ] Agent 聊天界面：SSE 流式输出 + plan 确认交互

### DevOps

- [x] Docker build 验证通过（CI + 本地）
- [x] 日志系统：主线程 `pino.multistream`（无 worker 线程 / 无 pino-roll），per-service 子目录（server/worker/collab/nginx），双时间戳（ISO + epoch）
- [x] Logger 改为 initLogger(serviceName) 模式，Worker 显式调用 initLogger("worker")
- [x] Nginx 日志轮转：logrotate，30 天保留，日志写到 logs/nginx/
- [x] Pre-commit hook：拦截 .env 和密钥文件
- [x] Docker 镜像优化：pnpm deploy --filter，1.12GB → 357MB（-68%）
- [x] DB auto-migrate：API + Worker 启动时自动运行 Drizzle migration
- [x] Nginx 反向代理：前端容器 73MB，统一入口 port 80，SSE + WebSocket proxy
- [x] Nginx SSL auto-detect：entrypoint.sh 检测证书，自动选择 HTTP/HTTPS
- [x] VITE_* build-arg：Docker build 时从 .env 传入前端环境变量
- [x] Redis 拆分为 3 个逻辑 DB（REDIS_URL/REDIS_QUEUE_URL/REDIS_STREAM_URL）
- [x] Package exports → dist/，turbo dev dependsOn ^build，消除 import.meta.dirname 脆弱性
- [x] .env.dev + .env.docker 双模板，替代 .env.example
- [x] 登录页完整修复：response parsing、用户信息显示、Google OAuth 头像同步、401 循环修复
- [x] 共享依赖版本单一来源（第一批）：`pnpm-workspace.yaml` 的 catalog 收编 9 个包的 Node 类型库 + web 的 32 个 tiptap 包，包内一律写 `catalog:`；tiptap 全线对齐 3.29.2（含 y-tiptap 3.0.8）
- [ ] 共享依赖版本单一来源（剩余）：catalog 外仍有 6 个包版本声明分叉（`eslint` / `@eslint/js` 跨大版本且**实际装了两份**，`typescript` / `typescript-eslint` / `yjs` / `y-protocols` 声明分叉但当前被 pnpm dedupe 成一份）；另需 CI 守卫拦「绕过 catalog 直接写版本号」，否则这次收编是一次性的、会重新漂
- [ ] CD pipeline：GitHub Actions → Docker build → 自动部署

---

## Beta — User Ready（用户可以日常使用）

**目标**：创作者能注册、充值、创作完整的多模态项目。

### 产品功能

- [ ] 积分购买页面：Stripe Checkout 跳转 + 余额显示 + 购买历史
- [ ] 项目管理：创建/删除/重命名项目、项目列表、缩略图
- [x] **Studio 设置(#10, 2026-07-29)**:头像(前端裁剪成 512×512 PNG;后端不读图像内容,只判字节大小 + 按签名认类型决定存成什么,然后原样存 —— 头像是纯 URL、不是资产)· 改名 · 改 slug(旧 slug 立即释放、无跳转,确认框写明四条后果)· 简介 · 成员自助退出(名下 project 转给 admin)。配套:全站头像统一成一个组件(形状随 `studios.type` 定圆/方)· 通知跳转改存 ID 读时反查 · `slug` 收进不翻译产品术语表。**Studio 删除仍未接线**(#26 单独做)
- [ ] 节点交互（canvas-native，PR-C 起）：
  - text 富文本：✅ TipTap 富文本编辑器（左侧全屏面板，绑定 `data.prompt` Y.XmlFragment）
  - canvas-native mini-tools：image.crop / image.adjust / image.remove-bg / video tools / audio tools 逐条接入（前端 `new/` 分支开发中）
  - 节点悬浮菜单（selected 节点上方）+ 底部工具栏：PR-C 范畴
  - text mini-tools UI：10 个 text mini-tool 的 slash-menu 接入待确认
- [x] **i18n 前端接入（PR #117, 2026-05-22）**：前后端共享 `@breatic/shared/i18n`（`intl-messageformat` / ICU 引擎），web 通过 `useTranslation` hook + `locale-bootstrap` (`localStorage` → `navigator.languages` → `en`)；TopBar `LangSwitcher` 切换语言；repo-lint 的 `no-cjk` CI gate 防 hardcoded CJK 回潮

### 画布协作

- [x] 节点编辑器文档（Phase 1）：per-node Yjs 文档 `project-{id}/node/{nodeId}` 支持文本/混合编辑器 —— PR #138 + #140。已在 Phase 2 替换为 canvas-native 模型（见下方 Phase 2）
- [x] **Phase 2: canvas-native 架构前向修复（PR #13 后端 + PR #14 前端）**：单项目 Yjs 文档（`project-{id}`），取消 per-node 编辑器子文档；NodeStateUpdateEvent 统一事件形态（替代 handling/completed/failed 三事件）；节点状态机 idle/handling（Yjs）+ localPending（本地）；后端不再持有 per-node Redis 锁；操作产生新兄弟节点；1:N 支持（targetNodeIds）
- [x] **画布撤销/重做（PR #243）**：per-space `Y.UndoManager`（每个 space 一个），追踪本客户端的结构 / 元数据 / 名称写入（建/删/移动/锁/改名节点 + 建/删边），后端内容写（`node-state-update` origin）与视口操作不进栈；per-client 隔离、深度 50、刷新清栈；工具栏按钮 + 键盘双平台（Cmd/Ctrl+Z、Cmd+Shift+Z、Ctrl+Y）
- [x] **画布边剪刀删除 + canvas 撤销/边/锁 bug 修复（PR #245）**：选中边 → 边中点浮剪刀（不随缩放变大小）→ 点击删边（走 `removeEdge`，进撤销栈）；边改本地 buffer + `onEdgesChange` 让边可选中。附带四修：节点锁定不再锁名称（lock 仅约束内容）· 删带边节点的撤销原子还原节点+边（`removeElements` 单事务）· 选中边 `Delete` 键可删 · 协作者删本地撤销栈中节点后撤销按钮不再卡死（undo/redo 后重读 `canUndo`）
- [x] **画布空间地基（PR #234）**：前端契约对齐 shared 权威 `CanvasNodeFields`（`cover_url→coverUrl` 全栈 + 派生视图层 `node-view.ts`〔`toNodeView`/`deriveStatus`〕）；Yjs binding 改 `nodesMap`/`edgesMap` + 节点 data 嵌套 Y.Map；画布渲染接 ReactFlow（三事件桥：拖动持久化位置 / 删除 / 连边）
- [x] **节点模型契约修订（PR #235）**：删 `generative`/`outputType`/`isPrimary`，把 Generate 输入（`prompt`/`model`/`references`/`params`/`kind`）relocate 进节点 data；group 节点加 `backgroundColor`；生成子模式 = `kind` 字段〔后 2026-07-09 #1682 清理：`kind` + 死的 view `generateMode` 映射均删，生成子模式改由**模态无关的通用 `mode` 字段**承载（image t2i/i2i，音频/视频复用同字段）〕
- [x] **节点创建入口（PR #236）+ 剪贴板（PR #238）**：左节点库下拉 + 画布右键菜单建 4 模态空节点（视口中心 / 光标落点 + 阶梯防重叠 + 建后选中）· 节点名字头双击改名 · viewer 只读拦截 · 复制/粘贴节点（系统剪贴板单一真相源，marker JSON）+ 纯文本粘贴建文本节点
- [x] **画布分组（PR #257）**：框选/Cmd·Ctrl+G 打组 → 容器由成员 bbox+padding 派生几何（不用 ReactFlow `parentId`，绝对坐标 + 拖组自定义位移带子节点）· 4 status 底色 + 无色 · 双击组名改名（共用 `useInlineRename` hook）· 拖单节点进/出组（drag-end 碰撞判定）· 删组放回子节点 · 不嵌套、组无 lock
- [x] **画布级文件上传（PR #258）**：三入口（左「上传素材」按钮 / 拖拽落画布 / 图片·文件粘贴）→ 按 MIME 分流，统一走「即刻建 `handling` 节点写 Yjs → 填内容 / 失败写 `errorMessage`〔含文件名、固定英文进 Yjs 协作端可见〕」一条状态机（全程前端独占写、复用已有节点状态机）。**媒体**（image/video/audio）走 presign 直传建对应媒体节点（content = URL）；**非媒体一律文本节点 + 前端提取文字**（`text/*` 本地直接读 · pdf 用 pdf.js · docx 用 mammoth · xlsx 用 SheetJS，均浏览器内提取、按需动态 import；无提取器/畸形 → 节点显示「Extraction failed」）—— 删掉旧的「不支持类型 toast」，错误一律在节点上。后端零改动
- [x] **文档权限控制（PR #251）**：collab `onAuthenticate` 按 project 成员关系定 `connectionConfig.readOnly`（viewer 只读连接拒写 Yjs sync），前端 `nodesDraggable`/chrome 角色 gate 双层
- [x] **画布锁语义（PR #263 组锁 C + PR #264 完整锁）**：统一 `data.locked` 一个标记，节点锁 + 组锁同一套。**组锁 C（#263）**＝冻结组结构（成员关系 + 成员相对位置 + 禁解组，组能整体拖）+ 右键菜单按 group / node 分流。**完整锁（#264）**＝节点锁也拦删除（`filterLockedDeletion` 保护任何 `data.locked` 节点 + 触及的边）· 节点 + 组锁拦改名（`useInlineRename` 的 `locked` 闸，节点头与组名同一套）· 删除守卫从 `onDelete` 挪到 `onBeforeDelete` pre-veto 层（修掉 #263 旧守卫拦不住删除的 bug）· **锁定也冻结移动**（节点和组都渲染 `draggable=false`、拖不动；`lockedNodeIds` 删除保护与移动冻结复用同一集合；反转组锁 C「组整体可拖」）。**撤销不被锁挡**——per-user `Y.UndoManager` 在锁守卫之下，创建者能撤销自己的创建（哪怕别人锁了）；后端不检测（前端 gating）。反转 PR #245 的「锁不锁名称」（名字画在节点上＝内容，按画布品类 norm 该锁；两轮工业级调研对比 tldraw/Miro/FigJam 源码 + 文档定）
- [x] **画布锁语义重定义为两作用域（PR #350 / #1786，2026-07-20 supersede 上一条的「完整锁」）**：user 重定义 —— **① 节点自身锁**（`data.locked`）冻该节点一切（内容/名字/编辑/上传/生成/移动/删除）；**② 组锁**只冻成员**几何**（移动）+ **结构**（增删成员、组自身移/删）+ **组身份**（组名/位置/缩放），**不冻**成员内容/名字/编辑/生成/上传/连线（那些各走成员自己的 `data.locked`）。**边永不锁门控**（节点锁 + 组锁都不锁边，`onConnect` 与删边皆 ungated，删边只跟随端点是否真删防悬空 —— 反转上一条「触及的边」保护）。删除守卫 `filterLockedDeletion`→`filterGatedDeletion`、`onBeforeDelete` 入口 `gateBlockedDeletion`。剪刀点不动 bug（#1787）根因 = `.react-flow__edgelabel-renderer` 层无 z-index 被组背景盖住（非锁），修 `{z-index:10}`。前端 gating，后端不检测。web/CLAUDE.md node-gate 段 + `docs/ARCHITECTURE.md` 画布锁语义段同步。
- [x] **image 节点生成面板 + 文生图/图生图模式切换（PR #313 slice-1 + #315 mode-toggle）**：image 节点右键「生成」→ 协同参数面板（TipTap prompt + 模型选择器 + 比率/分辨率）→ 执行 → 节点进 handling → worker 生成 → 回写节点自身；`GET /models` 边界 sanitize（`modelCatalogSchema`，malformed 丢字段不丢模型）+ 选择器按 `mode` 过滤（`IMAGE_GENERATION_MODES={t2i,i2i}` 单一真相源，排工具类 remove_bg/upscale）。**模式切换（#1681）**：ModelPicker 左侧「文生图/图生图」segmented 控件（切换过滤模型 + per-mode 记忆，默认取该模式 `recommended` 层的模型）· 模型名前品牌 SVG 图标（帆船 Midjourney / 香蕉 Nano Banana / 竖条 Seedream）· t2i 时参考置灰（从零生成不吃源图）· 后端零改动。取代被推翻的「家族折叠 + 自动路由」（藏 i2i 变体 + 碰后端强制扣费关键路径）
- [x] **`@` 引用子集 + i2i 执行门（#1664 后续切片 + #1675 并进）**：prompt 编辑器里输 `@` 从「连线参考池」挑源图子集（TipTap v3 mention + 缩略图 chip），执行时 i2i 只发被 `@` 的**图片**源（`imageUrlOf` 只收 `kind==='image'`，非图片源丢弃）→ `params.images` 子集；没 `@` = 空（design B）；删边级联清对应 `@` chip（`planMentionDeletions` 单事务、Collaboration 同步）；t2i 模式 `@` chip CSS 置灰 + 执行自动滤除。**#1675 双层执行门**：i2i/edit 模型无源图 → 前端点执行 toast 拒绝（按钮保持可点、不 disabled）+ 后端 `POST /canvas/tasks` 扣费/入队前 `ValidationError(422)` 拒绝（`violatesSourceImageRequirement`，规则单一真相源 = shared `requiresSourceImage(mode)`，前后端共用、config 不加冗余约束）。4 轮对抗验证（末 2 轮 clean）。
- [x] **生成面板 15 项 UX 批次 + 节点连接规则 + 面板⇄选中绑定（PR #318 + #319，#1664）**：@ chip 打磨（4px 缩略图/节点类型图标/Gapcursor/点参考插入）· 三选择器 popover 化（对齐语言/主题切换器条目模式 + a11y）· hover 预览（图片缩略图 + 文本内容）· 参考选择模式重做（已连/不合规 dim、可选发光、连续选择、定位源）。**节点连接规则（`canConnect` 白名单）**：image ← {image, text} · video/text ← {text, video, audio, image} · audio ← {text}，四处落点（拖连实时 + 兜底 + pick 守卫 + @ 过滤/rail 门），拒绝弹「X 无法接入 Y」toast（拖连/点击式/pick 三路径）；文本 chip 发后端替换成源节点文本内容。**面板⇄选中绑定状态机**：打开面板宿主自动成唯一选中，宿主失去选中面板自动关（任何路径——菜单加节点/粘贴/点其他节点/点空白），重绑定帧（开/换宿主/pick 退出）无条件断言，pick 模式挂起（Exit 唯一出路）。新 CI 守卫 `breatic/active-border`（中性激活边框单一真相源）。合计 6 轮对抗验证（批次 3 轮 + 绑定 3 轮），键位 prop 恒定 + 渲染层 CSS 中和框选死区（xyflow useKeyPress latch 陷阱）
- [x] **生成面板批次 2（13 项 UX + 磁吸桩，PR #320，#1664）**：模型默认改两级（`recommended` = 徽标非默认规则，删「recommended 优先」）+ 面板 600px + 光晕圆角对齐 + banner 七彩 · **激活 tab 去 Yjs 化**（跨机器互踩治本：`activeSpaceId` 停写停读、激活 tab 转纯本地 state；关键路径 100% 测）· chip 间光标真修（Gapcursor `valid()` 拒 textblock → 自绘 widget 假光标 + `handleClick` gap→TextSelection）+ 参考插入顺序按 `CanvasEdge.createdAt` 稳定排（新增稳定在最后）· 拖线到空白弹创建菜单 + 桩热区扩大 + pick 双击 gate · pick 模式隐藏左侧菜单+右下工具条（滑出动画）· prompt 协作光标 awareness（关键路径）。对抗多轮收敛。
- [x] **风格参考图（#1664 切 3）**：生成面板「风格」槽位落地——点「风格」进画布选择模式（同参考 pick 交互，仅非空 image 节点可选）选**一张**风格图，选中即**拷贝其资产 URL** 存节点 `data.styleImageUrl`（副本语义、与上游节点零关系，源删除/重生成不影响）+ 自动退出 pick；缩略图占据「风格」按钮位 + 角标 ✕ 清除、点缩略图重选替换。**能力门非模式门**：按钮/发送 gate 在当前模型是否声明 `style_images` param（config 决定，前端零硬编码）——支持 = seedream-5.0-lite · nano-banana-pro · nano-banana-pro-edit（i2i 也可用）· midjourney-v7（→`sref`）；nano-banana-2 无（Google Flash 档无风格类，官方文档核实）。执行发 `params.style_images`（单元素列表，t2i/i2i 都发）。**机制调研定案（5 agent 一手文档）**：业界风格参考全部 one-shot（风格图与生成同一次 API 调用条件化），无独立转绘步。**Worker 治根**：BytePlus 官方字段 = `image`（`image_urls` 官方零出现——修掉静默丢图的潜伏 bug）；nano-banana/seedream 合并式 remap（内容图在前、风格图在后 + 序号化 prompt 脚手架,取代覆盖式 rename 的 clobber 雷）；wavespeed prompt-only fallback strip + `logger.warn` 不静默丢。真机 smoke：t2i+风格 / i2i+风格（双通道 payload）/ 能力门负例 / ✕ 清除重选 全过、真图风格影响可见
- [x] **聚焦（Focus）工具（#1782 聚焦切片）**：生成面板「聚焦」占位落地——点「聚焦」进画布选择模式（仅非空 image 节点可选），点图在其上拉**裁剪框**（拖画/整框拖动/八柄 resize + 7 比例预设 16:9…9:16 + 取消/确认），确认即前端按**原图天然分辨率**裁剪 → presign 直传成**独立新资产** → 存节点 `data.focusImages`（副本语义、与源节点零关系，删源/改名不影响；名字 = 创建时快照）。**连续模式手动退出**（同图可框多张、可跨图；Esc 两段 = 先清框再退出）。聚焦图进参考列表（裁剪角标区分节点参考）+ 进 `@` 池（`focus:<id>` 命名空间复用全部 mention 管线：suggestion/chip/级联/t2i 置灰），**必须被 `@` 才进 payload**（与节点参考同规则）。**池级总上限**：节点参考 + 聚焦图合计 50/节点（`config/limits.yaml` 旋钮 → `GET /canvas/limits` 下发，前端三站点 gate：拖连/pick 点选/聚焦确认，超限 toast.warning）。上传中 rail 显 pending 占位（本地态不入 Yjs），失败 toast 无残留。真机 smoke：真裁剪真上传真生成（1024×1024 结果落节点）+ 删源存活 + ✕ 级联清 chip 全过。**收尾批次（#337）**：标记（Mark）占位裁撤（2026-07-17 拍板 C，其意图已被聚焦覆盖）+ 统一三模式 pick Esc（聚焦三剥 / 参考·风格一段退）+ 取消回选图态 + 裁剪角标三处前缀化 + 控制条跟随节点可出屏 + 工具栏 tooltip（继承 App 级 100ms provider）+ chip 2px 圆角
- [x] **摄像机（Camera）控件 + 生成面板打磨 + 统一 toast（#1788/#1793/#1794，PR #341/#342/#343）**：生成面板新增「摄像机」参数 picker——按当前模型是否声明镜头能力（`camera`/`lens`/`focal_length`/`aperture` ParamDescriptor）门控显隐（view-model `cameraSupported`，前端零硬编码），4 段 chip popover（相机/镜头/焦距/光圈）→ 注入 JSON prompt `technical` 块（后端 worker 早已 pop 注入，本次只补前端编辑 UI + 门控）。**参数持久化**：相机参数进节点 Yjs、独立于模型永久保留（切模型不丢未声明参数，只声明相机的模型读取）。**三批 review 收敛**：cap 对齐（glyph 统一 `h-14` 盒）· popover 跟随节点随画布动（`use-follow-canvas-viewport`，MutationObserver 观察 viewport transform → rAF throttle）· 6px 圆角 · 焦距灰色对齐相机 glyph · 去转盘 wheel 只留 chevron · SVG glyph → `currentColor` theme-aware（对齐 ModelIcon，修掉静态深灰 hex 只暗色对的潜伏 bug，CI `breatic/no-raw-design-values` 咬）。**t2i 参考语义**：t2i 下参考可用但只文本节点可 pick（image 源 dimmed 不可选，`referenceKindAllowedInMode` 单一真相源），i2i→t2i 不误杀已选参考。**统一 toast 单一入口（#1793，PR #342）**：新建 `@web/lib/toast.ts` wrapper——只暴露带类型方法（error/warning/success/info）+ 内容去重（`id=type:message`，同内容快速重复刷新不堆空条，`opts.id` 可覆盖留固定 id 场景）；20 源文件 sweep 走 wrapper（含 `node-gate-toast.ts`），`breatic/single-toast-entry` CI 强制、合并原「toast 必带类型」ESLint 规则。**拖动锁定节点 toast（#1794，PR #343，A.1）**：锁定节点/组 `draggable:false` 静默拦 → 画布层拖动手势探测（pointerdown 命中 frozen 集合 + 移动超阈值 ~4px）弹 `canvas.gate.locked` 一次，单击无位移不弹（区分选中 vs 拖动）；不碰已跑稳的 `draggable` 移动门
- [ ] 多实例负载均衡验证：Redis extension 跨实例同步测试

### AI 能力

- [ ] Canvas Skill：各模态智能模式 Skill（scope: canvas，单次执行，直接生成）
- [ ] 模型推荐引擎：Agent 根据用户意图自动选择最佳模型，不需要用户手动选

### 安全

- [ ] Skill 安全分级：内置 Skill 可用 run_script，第三方禁止；未来按需开放 isolated-vm / Docker 沙箱 / Webhook
- [x] 上传改为 presigned URL：`GET /assets/presign` → 直传 S3/OSS/本地，前端不持有 credentials
- [x] **资产归属统一到 studio 级（#1839）**：推翻 2026-07-04 定为 final 的「个人 studio 项目按操作者分流」规则。归属与去重范围一律看 **project 所属的 studio**，个人与团队一条路径、谁操作不进入判定——旧规则下 A 邀请 B 进自己项目协作，B 的产出落在 B 的 studio 下：A 在自己项目里看不到它，去重也形同虚设（一人一个域，同样的字节按人各存一份），没有个人 studio 的协作者更是直接传不了。同批新增 `studio_assets.produced_by_user_id` 把「归属」和「产出人」拆成两列（旧规则把产出人隐式压在 `studio_id` 里，删分支会连带丢失），去重命中保留**第一个**产出者。migration 0044 三步走（加 nullable → 从 `studios.created_by_user_id` 回填 → 置 NOT NULL），回填对个人 studio 行精确、对团队 studio 行是**近似值**且在 SQL 里明确标注。**安全模型是产品决策**：一个 studio 一个去重域 ⇒ 该 studio 下任意项目的 editor 共享其 hash 命名空间，内容存在性探测 / 跨用户 dedup 投毒 / 配额消耗 / 拿同 studio 他人的任意资产当自己视频节点的封面（`cover_hash` 残余）四条风险，由**发出邀请的用户承担**（邀请即信任），不做技术收口。**注意：告知面尚未建立**——用户手册与服务协议都还不存在，这条 `[x]` 只覆盖代码侧，告知本身是未完成的待办（归 operations）
- [x] **存储层重构（#1826）**：承接上一条把归属从 key 里拆出来。**key 租户中立**（`{taskType}/{date}/{时间戳}_{uuid}{ext}`，不再把 `{userId}/{projectId}/` 焊进每个公开 URL、泄漏账号拓扑）；**新增 `upload_grants` 下发记录表**接管"这 key 是不是你的"（presign 每铸一个 key 写一行：user + 服务端解析的 owner studio + 声明 hash），取代靠前缀判定的 `isOwnedKey`——它同时提供**权威 owner studio**（不信客户端报的 project_id，否则跨 studio 成员能把个人存储成本转嫁给团队）并把报告**绑定到当初申请的那份内容**（否则并发两个报告能在一个 key 上登记两个 hash，把一个还活着的对象送进回收队列 → 404）。**新增 `storage_reclaim_queue`** 待回收清单：去重命中时多出来的物理份只**登记**、不删，交离线回收（runtime 零删除攻击面 + 离线有明确工单）。**四条铁律**：runtime 只插不删 · 消费方 URL 一律取自登记记录（绝不钉刚上传、可能成孤儿的 key）· 登记失败即上传失败**零例外**（封面是视频上传的一半，#1816 原子契约）· **没 hash 不许传**（前端算不出就不发起，后端 presign + `/uploaded` 都必填）。**类型 / 大小 / 上限全部后端从"存下来的东西"读**（cloud `head()`、local magic-bytes 嗅探 + SVG/文本内容感知回落）——这是 local 上传 kind 全成 `'file'` 那个老 bug 的真修；权威 size 拿到后回头复核上限，"声明 1KB 传 50GB"绕不过去。另含：账号存储用量 = 该账号管理的每个 studio 相加、视频封面登记为一等资产行、local 流式写入走临时文件 + 原子改名（半成品不会被当成已完成对象注册）、画布拒收 0 字节文件

- [x] **守卫套件迁到 TypeScript（#1842 + #1835）**:41 个 bash 守卫脚本换成两层,**bash 守卫一条不剩** —— **ESLint 规则**(`eslint-rules/`,30 条)管每个源文件内部的语法问题,**`repo-lint/`**(新 workspace 包,17 项检查)管其余一切:ESLint 从不解析的文件(sql / yaml / sh / css / html)、构建产物、文件存在性。迁移过程用"种一个真违规、看旧守卫报不报"逐条实证,量出 8 个真实缺陷:`upload_grants` 被行号状态机遮住 · `service-logging` 一个 import 就能满足 · dist 别名扫描漏了 `@locales` 和 `require()` · `no-brand-usage` 把注释当违规、白名单只存在于注释里 · `no-cjk` 扫描根够不着仓库根与 `scripts/` 下的非 `.sh` · `no-private-repo-path` 只扫 5 个目录 · secretlint 包装脚本 fail-open · 15 条已失效的豁免。**统一 fail-closed**:选不到文件即失败(选空 = 检查了零个文件,不是"干净")、构建目录缺失即失败、未知检查名 exit 2、豁免条目指向不存在的文件即失败。文件清单取自 `git ls-files --cached --others`,新写但未提交的文件同样纳入(否则新文件在落地前一直"干净")。CI 从每条守卫一个步骤收敛成两条命令。**五轮对抗复攻**逐轮咬出同一个根因 —— 手写的解析器冒充真解析器 —— 于是逐个换成真的:workspace 声明交给 YAML 解析器、glob 交给 `minimatch`(拿 pnpm 本人实测对齐)、SQL 交给 PostgreSQL 自己的解析器(`plpgsql-parser`,能读进 `DO $$` 块所以里面的外键不再隐形)、ESLint 配置直接问 ESLint(而不是扫它的文本,后者看不见从别处 spread 进来的 glob)、迁移目录靠 drizzle 自己的 `meta/_journal.json` 发现(而不是写死路径)。同时**退掉两个不该是守卫的守卫**:`doc-links`(起 7 个 typedoc 进程问「链接解析得了吗」,而 `breatic/doc-link-resolves` 这条 ESLint 规则问的是同一个问题、问得更全 —— 文档生成器只看得见导出面,而这里每个命名函数都写注释、绝大多数注释根本不在它视野里)· `no-notification-name-keys`(拿文本扫描去管一条数据模型的业务规则,而文本分不开「存进记录的 key」和「同名的局部字段」)。**包根也纳入 lint 与 typecheck**:此前每个包只跑 `eslint src/`,于是各包根的 `vitest.config.ts` / `drizzle.config.ts` / `eslint.config.ts` 落在所有规则之外,而 `lint-coverage` 照样报绿 —— 因为它问的是「这个包跑没跑 linter」,从没问过「linter 看不看得见这个包」
- [x] **测试改成一个包一个进程（#1854 + #1855）**：每个测试**文件**一个进程在 12 核机器上峰值 37 个进程、负载 26，且每个进程把同一份固定开销重付一遍。换成每个**包**一个进程后（`pool: forks` + `singleFork`，模块隔离保持开启），web 包 56s → 30s，setup 110s → 2.0s、建 jsdom 环境 260s → 0.4s、收集文件 63s → 3.9s（两种模式各跑两遍实测）。对照组 `--no-isolate` 是 58.77s + 104 个失败，所以隔离是承重的、不能一起关。**真正的收获是它掀开的东西**：同一个包的测试从此共用一个 jsdom document，而 `isolate` 只重置 mock 和 vite-node 缓存、够不着 `node_modules`，于是四类状态一直在跨文件活着、被昂贵的老机制掩盖着——外部依赖的模块级计数器（ProseMirror 的 PluginKey 第二次变 `x$1`）· 进程级单例（React Query 的在线态被关掉后没恢复，之后所有文件的查询永久 pending）· `vi.stubGlobal`（vitest 默认不还原，`{...URL}` 展开出的对象不能 `new`）· 手工挂进 body 的 DOM（`cleanup()` 只收 testing-library 自己建的容器）。逐个修完并把复位收口到全局 setup。**a11y 断言原来把 `aria-hidden-focus` 整条关掉**，变异测试证明它连我们自己 markup 的违规也一起盖住了（给真实对话框底栏加 `aria-hidden` 仍然绿）→ 改成只把 Radix 的两个 focus guard 节点排除出 axe 的扫描范围，同一个变异就红了。顺带删掉 7 条依赖图禁止的死路径别名（core/shared 配着 `@collab` `@worker`、collab 配 `@worker`、worker 配 `@collab`、shared 配 `@core`），并把「判定别名死没死不能只看本包 grep」这条传递规则写进 CLAUDE.md 第 15 条。两轮对抗共 37 个 agent；**有一个根因没查出来**（单进程时 axe 为什么不再把对话框当打开的模态框，六个候选实测排除），如实写进代码注释而不是编一个机制。
- [x] **等人答复的期限统一到一个配置项（#33）**：五件「有人在等你答复」的事——studio 邀请 · project 邀请 · studio 转让 · project 转让 · 角色升级请求——原本各自把 7 天写死在自己那处，而同一个数其实要在四个地方同时成立：落库的 `expires_at`、邮件链接令牌的 Redis TTL、邀请与转让邮件正文里的那句话、邀请落地页过期卡片上的天数。四处各写各的，改一处就悄悄不一致。现在全部读 `config/limits.yaml` 的 `decision_window_days`，任何一处都不许再写自己的数字；改这个值只影响此后新建的行，老行按当初盖上去的截止时间走。同批**把过期语义补全**：此前只有「接受」那条路查过期、「拒绝」不查，于是一个早就过期的请求仍然拒得掉——等于过期只关了一半门。现在过期即对**两个答案都关闭**（两个邀请流把过期判定折进 accept/decline 的同一条 CAS 谓词里，答 404；两个转让流在事务内读后判定，答 409）。**真正的收获是变异测试逮出的假绿**：两个转让流原有的「期限跟着配置走」测试，期望值调的是被测代码同一个 getter，等于自己跟自己比——把写死的 7 天放回服务里，37 条集成测试加 299 条单测照样全绿。改成把配置 mock 成一个仓库不会 ship 的值，才真的钉得住。

---

## GA — Public Launch（公开发布 + 开源社区）

**目标**：稳定运行、全球可用、社区可贡献。

### 平台

- [ ] MCP Server 层：暴露 breatic_chat / breatic_create_task / breatic_list_skills 给外部 AI 调用
- [ ] Skill 市场基础：Skill 提交 / 审核 / 安装流程
- [ ] 文档 GC 策略：定期清理孤立 Yjs 文档（项目已删除但 yjs_documents 还在）

### 运营

- [ ] 前端部署到 CDN（Vercel / Cloudflare Pages）
- [ ] CD Pipeline：GitHub Actions → Docker build → 自动部署
- [ ] 监控：Sentry 错误追踪 + 基础性能指标
- [ ] CONTRIBUTING.md：贡献指南、Code of Conduct、PR 模板

---

## Post-GA — v2 Features（产品升级，下个大版本）

**目标**：在 GA 稳定基础上加入团队 / 组织 / 跨项目协作能力,把 breatic 从「个人 + 项目级协作」扩展到「团队 + 组织级协作」。

### Team / Organization

- [ ] **Team / Organization 概念**：引入 team / org 中间层(user 属于 team,team 拥有项目)
  - 数据库:加 `teams` / `team_members` 表 + `projects.team_id`
  - 角色:team admin / team member 跨项目权限继承
  - 邀请:team 邀请代替单项目邀请;邀请到 team 自动获得 team 所有项目访问
  - share link 扩展:「team 内任何人可凭 link 进」选项(类似 Figma 的 organization-level 链接)
  - 计费:积分包绑 team 共享 / 转移 / 配额管理
  - 跨项目搜索 / dashboard:team 维度看所有项目
- [ ] **Owner 转让流程**:team 模式下 project owner 可转给 team 内其他 member(当前 owner 永久绑定创建者)

---

## 待跟进（已识别但不在当前 PR scope）

这里记单 commit 不修但已经定位/部分定位的 dev 体验和 runtime 韧性问题。每条都对应一个独立 PR，开启时需要完整 DD + 复现验证。

### dev:collab 长跑 connection drift —— 治根 PR

**触发现象**：dev:collab 单进程跑 ≥ 几小时后，`onAuthenticate` 在 postgres-js 连接池里拿到 stale connection（Postgres 默认 30 min 关 idle conn，client 不感知），所有新 WS 握手都报 `authenticationFailed`，前端 banner `登录已失效` 永远不消。重启 collab 立即恢复。`docs/DEPLOY.md` 已加 dev runbook 教 user 出现就 restart。

**真治根工作（独立 PR）**：

- `packages/collab/src/auth.ts` — `onAuthenticate` 包 `try { ... } catch (err) { logger.error({ err, userId, documentName }, "onAuthenticate fail"); throw err; }`，让 server-side 错误链不再静默
- `packages/collab/src/auth.ts` — `postgres(databaseUrl, { max: 5, idle_timeout: 60, max_lifetime: 30 * 60 })`，让 client 主动 recycle 比 PG 默认 idle timeout 短的 connection
- `packages/core/src/infra/redis.ts` + collab 各 ioredis 实例 — 评估 `keepAlive` / `connectTimeout` / `reconnectOnError` 是否需调
- `packages/collab/src/index.ts` — 加 `GET /healthz` endpoint ping PG + Redis + Hocuspocus 就绪，LB / docker healthcheck 看 N 次 fail 后 kill instance
- 复现验证：本地起 collab，手动 `psql` 关掉 dev:collab 持有的 connection（或等 idle_in_transaction_session_timeout 触发），观察 onAuthenticate 是否 throw、新 query 是否能自动复活
- 上游参考：[Hocuspocus #716](https://github.com/ueberdosis/hocuspocus/issues/716) Firefox/Safari 30s "Unauthorized" close、[#566](https://github.com/ueberdosis/hocuspocus/issues/566) v2 重连不重发 auth token

**Why 不挤进当前 PR**：postgres-js 配置 + healthz endpoint + error logging 三处改动都是治根但**没有真的 23 小时复现验证就 ship 等于猜根因**。memory `feedback_existing_infra_verify_before_dd` 强 mandate：关键路径（鉴权 + Yjs 协作）fix 必须真复现 + 验证，不能配置猜。独立 PR 单独走 DD + 复现 + 验证。

**状态更新（2026-05-27 PR #155 + 2026-05-28 PR）**：上面五个治根 bullet 已全部 ship：

- ✅ collab `onAuthenticate` try/catch + 5 reason logger.warn（PR #155 commit `4a79f6f`）
- ✅ `createPgClient` factory `idle_timeout: 30` + `max_lifetime: 1800`（PR #155 commit `f078289`，collab 所有 raw `postgres()` 调用走 factory）
- ✅ `createRedisClient` factory `keepAlive: 30000` + `commandTimeout: 5000` + `connectTimeout: 10000` + `reconnectOnError` READONLY（PR #155 commit `7916358`，collab 所有 raw `new IoRedis()` 走 factory）
- ✅ `/healthz` 三 service 都 expose（PR #155 commit `2b4fb95` worker + collab；2026-05-28 PR server 也加了，全 `主+1` port）
- ✅ docker-compose `healthcheck:` 接线（2026-05-28 PR）— 自愈链路闭环

**2026-06-02 DB 统一后续**：collab 不再自建 postgres 池——`packages/collab/src/auth.ts` 已不存在（现为 `hooks/auth.ts`），PG 访问改走 core 的 `db` / `yjsDb` 延迟单例，连接回收配置（`idle_timeout` / `max_lifetime`）集中到 core 的 `createPgClient` 池工厂。上面计划 bullet 里的 `collab/src/auth.ts` 路径是当时旧落点、已失效。注：这条记的是 2026-05 的连接 drift 事件（已闭环）；`登录已失效` banner 若后续复发，根因未必是连接 drift，按当时实证另查、别直接套这条。

### Observability —— Prometheus `/metrics` + Grafana dashboard 待办

**Why 现在不做**：CLAUDE.md "服务器端工业级标准" 7 件套中的「安全监控（生产 metrics 看 trend 提前预警）」当前只落地了结构化 log，没有 metrics 时序数值。endpoint 在 (`/healthz` 200/503 + `breatic/no-library-logger` clean) 后已经是工业级最小集，但 metrics 上报 + dashboard 需要 backend monitoring sprint 单独规划（Prometheus 自托管 vs Grafana Cloud / managed Mimir 选型 + docker-compose 加 prometheus + grafana service + 各 service 加 `prom-client` 暴露 `/metrics`）。

**真治根工作（独立 PR / sprint）**：

- `packages/server/src/index.ts` + worker + collab —— 加 `prom-client` 暴露 `GET /metrics`（建议放在 health server 同一 port，例如 api 3001/metrics）
- `packages/core/src/infra/` 加 metric 工具（counter / histogram / gauge wrapper），让 service 调用方一行声明指标
- `packages/server/src/middleware/` 加 HTTP request count / latency / 5xx rate metric collector
- `packages/worker/src/` 加 BullMQ queue depth / job latency / failure rate metric collector
- `packages/collab/src/` 加 active connections / messages per second / awareness peers metric collector
- `docker-compose.yml` 加 `prometheus` + `grafana` service + volume + 基础 dashboard JSON
- `docs/DEPLOY.md` 加 metrics 维度说明

**Why 不挤进当前 PR**：metrics 工程量大（每个 service 接 prom-client + 选 metric 维度 + Prometheus / Grafana 部署 + dashboard 设计），跟 healthz binary check 是正交主题；先把 healthz 自愈链路彻底闭环再走 metrics 上报，避免一锅塞两个独立工程主题让 reviewer 难审。等 backend monitoring sprint 启动时单独 PR。

### BellMenu 在 Studio 页 —— 跨页通知统一待办

**Why 现在不做**：BellMenu 通知组件（待审批的角色升级请求 / studio·project 邀请确认 / 管理员转让 等）在 Project 页右上角已经落地，但 Studio 页右上角同样应该出现（项目列表视角下，user 也需要看跨项目的待办 / 通知）。Project 页 BellMenu 已闭环；Studio 页要单独做，避免让一个 PR 同时碰 chrome layout 在两个页面的差异（Studio chrome 跟 Project chrome 是不同的 IA layer）。

**真治根工作（独立 PR）**：

- `packages/web/src/pages/studio/shell/` —— Studio chrome 加 BellMenu 渲染（复用 Project 页 `packages/web/src/pages/project/chrome/top-bar/BellMenu.tsx` 组件 或抽到 `web/src/features/notifications/`）
- 跨页 notifications data hook：根据当前用户身份 fetch 所有 project（owner role）的 pending 通知（角色升级请求等）聚合
- Studio 页 BellMenu popover：列出按 project 分组的待办项 + 点击跳到对应 project 的 BellMenu 流
- 跨 chrome 共享样式 token + i18n key

**Why 单独 PR**：Studio chrome 自身还在 v14 重启过程中（参考 memory `project_web_v14_rewrite`），改动节奏跟 Project chrome 不一致；叠 Studio chrome layout 改动会让 PR 难审。先在 Project 页把通知链路彻底闭环，Studio 页等 Studio chrome v14 stabilize 后单独 PR。
