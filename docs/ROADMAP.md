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
- [x] **取消 Project 的可见性(#407, 2026-08-07)**:建 Project 时不再问「studio 内可见还是仅邀请可见」,每个 Project 一律对它所属 studio 的全体成员可见;卡片上那个恒定不变的可见性徽章一并去掉。数据库那一列、请求契约里的那个字段、以及前后端两层过滤**全部保留** —— 这是刻意的边界:以后要把这个概念加回来,只需把选择器放回界面,不用重建读取侧。已知代价也写在明处:接口仍然接受显式的 `private`,所以绕过界面的调用方仍然能造出一个隐藏的 Project,那正是过滤逻辑留着的原因。存量数据由 migration `0049` 统一抬成「studio 内可见」。资产集(Collection)保留它自己的可见性,不受影响
- [x] **Studio 设置(#10, 2026-07-29;改 slug 挪进危险区 #58, 2026-08-07)**:头像(前端裁剪成 512×512 PNG;后端不读图像内容,只判字节大小 + 按签名认类型决定存成什么,然后原样存 —— 头像是纯 URL、不是资产)· 改名 · 简介 · 成员自助退出(名下 project 转给 admin)。**改 slug 不跟改名并列,它在危险区** —— 旧 slug 立即释放、无跳转、不可撤销,分量跟删除同级;危险区上是一个按钮,点开的弹窗里才是输入框 + 实时查重 + 逐条写明后果,确认按钮出转圈而弹窗始终可关(Ant Design / Bootstrap / Chakra / Radix 四家都把「正在跑」和「能不能关」分开)。**个人 Studio 也有危险区**,里面只有改 slug 一个动作(它的 slug 就是这个人的 @handle);团队 Studio 的 admin 是转让 / 删除 / 改 slug 三个,非 admin 只有退出 —— 三格各写死一条显示条件,不靠一条总条件(靠总条件会让个人 Studio 的主人看到删除按钮)。配套:全站头像统一成一个组件(形状随 `studios.type` 定圆/方)· 通知跳转改存 ID 读时反查 · `slug` 收进不翻译产品术语表 · 独立文字按钮一律有边框(无边框读不出是按钮,规则写进 `packages/web/CLAUDE.md`)。**Studio 删除仍未接线**(#26 单独做)
- [x] **等答复的请求统一到一个落地页(#25, 2026-08-03)**:五个流(studio 邀请 · project 邀请 · studio 转让 · project 转让 · 角色升级)各有一条 `share_token`,邮件 / 铃铛 / 发起人可复制的链接三条通道带同一个 token 到同一个 `/decision?token=`,一套 `GET /decisions/:token` + `POST /decisions/respond` 答五种请求。**「链接失效」这一句话原本压着四件事**(已答过 / 超时 / 被撤回 / token 是假的),现在各说各的,另加「关联内容已删」和「你已经在里面了」。token 是路牌不是钥匙 —— 闸门是登录 + 收件人校验,链接本身永不失效,过期的是请求。配套:两个互为镜像的旧落地页与其 API 删净;铃铛不再内联决策、只指路,没有 token 就不画按钮;角色升级补上它一直缺的邮件通路。**落地页上「你已经在里面了」的判据是角色不是行** —— 看的是收件人当前角色有没有到邀请要给的那一级,否则光是打开过那个 project(会当场把人物化成 viewer)就会让一条待答的 editor 邀请永久卡死。**这条只管落地页那一问**:发邀请那一刻问的是另一件事(这个人在外面吗),它按「成员表里有没有这一行」判是对的 —— 「邀请」的前提就是对方在外面,在里面就该直接告诉他已经是成员、让他走成员列表改角色
- [x] **Document Space 协作地基(PR #382, 2026-08-02)**:document Space 接上共享 Yjs 文档,多人同时编辑同一份文稿;撤销 / 重做走共享的 undo 管理器。**这个切片治的根因是「撤销会销毁协作者的文字」** —— 两个人写进同一个块就共享一个容器,撤销我插入那个容器的动作会把他的字一起带走、同步给所有人,而且不在他的撤销栈里、谁都拿不回来。以「受保护节点集」为唯一变量实测:段落里对方的字能留下,标题 / 引用块 / 代码块**全部清空**。修法两层:① 受保护节点集**从 schema 推导**(上游默认只保护 `paragraph`,那是为「文档里只有段落」的编辑器写的),以后新增块类型自动拿到保护;② 容器活下来时它的**属性**也活下来(属性在 Yjs 里是 map 条目,上游过滤器不保护它 → 活下来的标题会丢层级、渲染成 h1)。变异验证过:两处任改一处都有测试变红。**编辑功能集不在本切片**:工具栏除新增撤销 / 重做外,其余按钮做什么一个字没动;StarterKit 只改两个开关(关掉它自带的第二套撤销栈 · 关掉尾随空段落 —— 在共享文档里那是一次写入),并有测试断言我们的 schema 与原版逐节点逐属性完全相同。顺带:断线和会话过期改用同一块遮罩告知(此前只覆盖后者),且不往编辑区里伸手(`inert` / `aria-hidden` 会打断正在输入的中文)
- [x] **Space 目录只有服务器能改(PR #397, 2026-08-05)**:项目的 Space 目录此前客户端也写得动 —— 那道本该拦住它的守卫,要靠精确列举协作库内部的消息类型才能认出一次写入,而它连消息开头是文档名都没算对,**整个生命周期一次都没执行过**。改成协作库自己的连接级只读:目录文档对**所有角色**无条件只读,框架在每个写入口自己判,不存在「名单」也就不存在漏。客户端最后一处直接写目录的东西(每个人开着哪些标签)改成两条 RPC,例外去掉之后规则才能是「一个字都不许写」。同时 Space 编号改由服务器生成(契约直接拒绝请求里夹带的编号),前端每次点击带一个认领 token、服务器盖在条目上、广播带回来,**谁的 token 谁打开** —— 此前靠「广播里多出来的那个就是我建的」认领,三台机器同时建就串。五个 Space 操作(建 / 删 / 恢复 / 锁 / 改名)统一成一套顺序,广播是分界线:之前失败就当没发生过、回滚干净,之后失败记一行完整日志、照样告诉用户成功。**做到一半发现方向不对、返工过一次**:判断阶段原本走的是「读完顺手存一次盘」的调用,于是一次纯粹的「看一眼」会带回两个毫不相干的答案(看到什么 / 数据库健不健康),而三轮对抗各漏一批之后才看清 —— 该做的不是给两个答案排序,是让判断根本不碰存盘(协作库本来就有不捆绑的入口)。**六轮对抗**,最后两轮咬出的都不是运行时会给用户错结果的东西,而是我自己判错的两处:一处新加的分支零测试保护(变异实证:对调两个分支 255 条测试全绿),一处我当时判成「等价变异测不出」、实际是我只在错的层级测。真浏览器 smoke 跑了两遍(第一遍在返工之前,作废重跑)
- [ ] 节点交互（canvas-native，PR-C 起）：
  - text 富文本：✅ TipTap 富文本编辑器（左侧全屏面板，绑定 `data.prompt` Y.XmlFragment）
  - canvas-native mini-tools：image.crop / image.adjust / image.remove-bg / video tools / audio tools 逐条接入（前端 `new/` 分支开发中）
  - 节点悬浮菜单（selected 节点上方）+ 底部工具栏：PR-C 范畴
  - text mini-tools UI：10 个 text mini-tool 的 slash-menu 接入待确认
- [x] **i18n 前端接入（PR #117, 2026-05-22）**：前后端共享 `@breatic/shared/i18n`（`intl-messageformat` / ICU 引擎），web 通过 `useTranslation` hook + `locale-bootstrap` (`localStorage` → `navigator.languages` → `en`)；TopBar `LangSwitcher` 切换语言；repo-lint 的 `no-cjk` CI gate 防 hardcoded CJK 回潮

### 画布协作

- [x] **collab 存盘跟编辑彻底解耦(PR 待填, 2026-08-07)**:此前存盘挂在「有人改了东西」上,而库对一次失败的存盘什么都不做 —— 不重试,最后一个连接关掉时连最后一次尝试都不做,实测「数据库抖一下 + 用户关页面」= 那段内容永久消失。改成两个时刻、一种顺序:**定时循环**每 10 秒扫一遍内存里的文档,有没写进库的就存一次,失败只记一行日志、下一轮重来(整份文档整行覆盖,所以失败那次的内容会被后面任何一次成功带进去);**文档要离开内存那一次**是它最后的机会,先写库,写不进去才把内容写进本地救援文件、记日志、通知运维,救援文件永不自动清理。判断「有没有没存下的」自建计数器,**不用 Yjs 状态向量** —— 向量看不见删除,实测会把「删一段 + 存盘失败 + 关页面」判成干净、删除永久丢失。**存盘路径上一个超时都没有**:存盘是一件有两个结果的事,掐表取消不了正在飞的写、只会凭空造出第三种「说不清」,而那第三种会让健康数据库上的文档被写进救援文件、惊动运维(smoke 里真发生过三次,当时库 250 毫秒就应答)。**过程中返工两次**:一次是我拿一个跟存盘无关的 4 秒关闭预算当依据,给存盘加了 3 秒秒表;一次是同一个错误依据让我造出第二种存盘顺序(关闭时先写盘),连着三轮对抗咬的都是这条不该存在的分叉,最后整个撤掉。「整个实例要退出时内存里的文档怎么办」是运维层的事,单独立项

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
- [x] **文本节点正文改成协作编辑（#1774，PR #390）**：正文原本是 `data.content` 一个纯字符串，两人同时在一个节点里打字后写覆盖先写 = **丢字**。改成 `data.body`（`Y.XmlFragment`，建节点时就种下）+ TipTap 的 `Collaboration`，**字符级合并**、互不覆盖；远端光标经 `CollaborationCaret` 显示对方名字，`useCollabCaretPresence` 另发 `focused` 标记让失焦的光标变暗。**打字不引起别的节点重渲**：视图投影（`toNodeView`）**刻意不含 `body`**，正文订阅（`use-text-body.ts`）只在真需要正文的地方（节点自身 + 复制 / 副本 / 生成面板参考列表）按 id 单独订阅。进编辑态三个入口（双击 / 选中按 Enter / 空节点占位符按空格）统一走 `startEdit`，它一处判全部前提（节点锁 · handling · viewer 只读 · 引用拾取会话进行中）。**类型在 `@breatic/shared` 只有注释没有字段**——shared 零 yjs 依赖（浏览器安全 + 单入口 bundle），活的协作对象不是 wire 数据，同 `prompt` 的处理；`content` 对 text 就此退役（不写也不读）。**七轮 Gate-2 对抗**（后两轮是突破轮数上限加跑的）咬出 12 条行为洞，其中 6 条是**变异测试**逼出来的——剪断线路后测试照绿：复制 / Cmd+D 出空卡、光标在场信号零覆盖、正文表参数可省、盒模型手抄两份、提示文案守卫只抓半类错、等待条件读的是等待前的快照。真机 smoke：双客户端同节点并发打字不丢字 + 远端光标带名字且失焦变暗 + 拾取会话中键盘进不了编辑态、退出后恢复；rAF 逐帧采样 1109 帧，有字节点零次首帧闪空态。**比这个功能老的节点正文不迁移**（pre-launch 老数据不服务），打开得到干净空白起点；`annotation` 便签正文仍是纯字符串、有同样问题，单独排期
- [x] **图片节点的提示词容器改成建节点时就有（#1880，PR #392）**：承接上一条同一套解法的第三次应用。生成面板里那段提示词存在 `data.prompt`（`Y.XmlFragment`），**原本是等谁第一次打开面板才现场创建** —— 两人同时打开同一个节点，各自建一个往同一个键上放，后写覆盖先写，**被盖掉那人写的提示词连同容器一起消失**。拿改动前的代码走真实公开接口跑两客户端离线分叉再合并，实证复现：只剩后写那句、先写的整段没了。改成 `buildDataMap` 建节点时就种下（跟裁剪图容器、文本正文并列，那段注释描述的就是这条竞态、只是当时只应用到裁剪图），`getOrCreatePromptFragment` 改名 `getPromptFragment` 变成**纯读**。**给谁种由 `shared` 的 `canGenerate(type)` 决定** —— 这条规则原本只写死在画布右键菜单一处，建节点这边再抄一份就是同一规则两处各写，等做文字节点生成（#1778）时必漏一处；`data` 层不能 import `spaces` 层，两处的共同下游只有 `shared`。**老节点一个字兼容代码都不写**（pre-launch 老数据不服务），它们的面板照常打开、只是不渲染提示词输入框。真机双标签页各打一句，合并结果两句都在。**两轮 Gate-2 对抗**：第一轮因为一个视角接口报错整个没跑成、而「零发现」跟「零执行」长得一模一样，那轮作废重跑；补跑 17 条攻击存活 1 条（`buildDataMap` 函数头还把种下的容器列成穷举的两项、而这次改动让它成了三项 —— 按只读契约建立的心智模型是错的，正是当初惰性创建那个竞态的来源），修完复攻 15 条零存活
- [x] **协作身份统一：在线态只传 id，名字头像各自查名册（#1882）**：光标上的名字**一出生就是错的** —— 登录接口压根不返回个人 studio，前端只好退回邮箱前缀，跟用户在 studio 里设的名字对不上；而协作那一路又各存各的快照（每个标签页加载时填一次、永不重取），改了名的人对别人永远是旧的。两个根因一起修：**五个身份出口**（注册 / 登录 / Google / me / 建 studio）统一经一个投影函数返回 `personalStudio: { name, slug, avatarUrl }`，前端一个 `toCurrentUser` 收口全部写入点；**协作在线态只发一个 user id**，名字由每个前端自己从项目成员名册解析，颜色也由 id 本地推导（线上再没有可伪造的字符串）。服务端那份身份副本整个撤掉 —— `awareness-meta-users` 钩子、`meta.users` 映射、建 project 时种创建者名字，全删；`meta.users` 这个根仍被守卫挡着防恶意客户端复活。名册**无条件**重拉：进项目一次，之后任何人上线再一次。**名册改走 React context** —— 原本它要从项目页经外壳、空间主体、节点、编辑器一路手工传六跳，每跳都是可选参数、剪断任何一跳编译器和测试全不吭声（对抗四次咬出四处这样的断点）；改成项目页发布一次、光标机制自己取用，中间层不再知道有这个值。**五轮 Gate-2 对抗**共咬出 16 个行为洞：前两轮是真的产品问题（正在打字的人编辑器被销毁重建、有人加入时所有已显示的名字一起消失一个往返、光标标签改文字后不重新测量），后三轮全是测试覆盖（我补的测试每次都在某条边界上把真生产者换成了替身，于是只证明了自己那一侧）。每条修复都做变异验证（把修的那行改坏，确认测试真的红）。顺带修掉一个既有崩溃：生成面板四处守卫只判 `!editor` 而销毁的编辑器不是 null，**切换语言就会抛异常**。真机双账号 smoke：两个账号进同一个 project 同一个文字节点，B 看到 A 的光标标签是 `smoke-a-1812`（studio 名字）而不是邮箱前缀，且 A 那边已登出、没推送任何名字，名字完全是 B 自己从名册查出来的
- [x] **协作身份改由连接权威确定（#1886）**：承接上一条，但方向反过来。上一条把浏览器上报的东西**减到只剩一个 user id**，然后在服务端设了道守卫查那个 id 是不是本人 —— 守卫在那一层根本做不成：协作通道里每个客户端都会把**它知道的别人的状态**一起转发回来（上游库的疏忽，另记 #1887 —— 那条已随 2026-08-06 的依赖升级消失，见下面 #1887 那条），所以「这一帧里出现了别人的 id」既可能是转发也可能是伪造，两者在帧里长得一模一样。守卫按这个判据拒帧，把**真实用户踢下线**了；真机实测拒绝计数从 13 涨到 15 的那两次，就是两个正常协作者。**根因不在守卫，在「让浏览器自报」这个前提** —— 服务端在握手校验凭证那一刻就已经知道这条连接是谁，上一版把这个事实丢掉、转而问浏览器，才凭空造出一个需要验证的问题。所以不再验证，改成**服务端写**：① **在场名单**回到 meta 文档的 `users`（上一条曾把它整个删掉），但形状变了 —— 只有 `id` / `online` / `lastSeenAt` 三个字段，**没有名字头像**（那些仍是各端自己查名册），且**只有服务端写得进去**；**在场状态只被断言、从不被否认**：写「在线」只有连接建立和心跳两处，**socket 关闭时什么都不写** —— 一条 socket 结束不等于它的主人走了（一个人同时握着好几条连接，多实例下有些还在这台机器看不见的地方），所以「不在」由清扫从「没有任何人在刷新这条记录」推断出来。这一步让它跨实例正确而不需要任何协调：记录在共享的 meta 文档里，握着连接的那台机器负责刷时间戳、刷新同步给所有实例。**清扫搭在心跳上** —— 第一版搭在文档载入上，而那一刻恰恰是记录最新的时候（崩溃后客户端几十秒就自动重连，幽灵看起来全是活的），且只要还有人在文档就永不卸载、载入钩子再不会触发，于是「同一个时间差判据」在错的位置上等于永远扫不到。同理**心跳会把已离线的记录写回在线**：清扫持续在跑、可能翻掉还连着的人（隐藏的浏览器标签页定时器被节流到每分钟一次而 socket 一直开着），错误复活下一轮自愈、错误离线却是永久的。门槛 **90 秒**是算出来的不是拍的：它必须盖过「一个还连着的人两次刷新之间最长的间隔」，而那个间隔是浏览器隐藏标签页的**每分钟一次**、不是前台那一档（实测 18 秒），所以 60 秒正好压在周期上会让人每分钟闪一次。**中途还删掉了一样我自己发明的东西**：给这条写入加的 30 秒节流。meta 文档的 awareness 通道上只有心跳、不传光标（光标在 canvas / document 这类空间文档上），根本没有流量要拦；而那道门的计时在连接建立时被重置、跟浏览器的心跳节奏不对齐，相位最差时两次写能隔到 89999 毫秒 —— 门槛 90000，真实余量 1 毫秒，**而 Gate 2 前三轮反复咬的正是这道守卫的算术**，三轮都在修一个不该存在的东西。拿掉之后每个心跳都写，余量是干净的 30 秒。同批还删了 `useProjectMeta` 对外给的 `onlineUserIds` —— 它只是把 `users` 按 `online` 过滤一遍、同一份数据发布两次，2026-05 为一个没做成的界面预铺的；唯一的消费者改成直接看 `users` 里谁的 `online` 从非 true 翻成 true，顺带修好「离开又回来的人」（服务器只翻字段不删记录，旧的「只认没见过的 id」漏掉他每一次回来）。这条定性是**二类问题** —— 保障「他离线了一定能确认到」，不保障「精确在什么时刻通知别人」。② **光标身份**在服务端逐条盖章：按 Yjs client id 判归属，自己的和还没登记的（连接第一帧）盖上，登记在别人名下的原样放行（**「判归属」这一半后来整个删掉了，见下面 #1887 那条** —— 那一支正是「A 用 B 的名字画光标」能成立的原因）；服务端整个 `user` 字段说了算，**只保留客户端的 `focused`**（窗口有没有焦点只有浏览器知道）。前端三处上报点全部撤除：光标扩展的身份、在线态的名字头像投影、以及最后那个连插件都在替我们发的 `user` 选项 —— 顺带解开一个耦合，光标以前要等本地账号解析出来才挂载，等的是一个它不再需要的东西。**新守卫做了变异验证**：把自报身份塞回去，「只看稳定后的状态」那条断言照样绿（种下的 id 一瞬间就被焦点上报覆盖了），只有新加的「逐帧看所有发布过的状态」咬得住 —— 假绿的守卫和没有守卫是一回事
- [x] **在场名单的写入拦截，验过了（#1888，PR #408）**：上一条把协作在场名单放进 meta 文档的 `users`，而它的**全部**保证只有一句话——只有服务端写得进去。那句话此前没人验过：拦截职责是 #397 从我们自己写的守卫交还给协作库只读机制的，交接成不成立，能看到的只有一段注释。**验的结果是拦截为真**：把「meta 文档一律只读」那一句删掉，原有 10 条用例红 6 条，而绿的 4 条正是不该红的对照（内容文档能写、空间 RPC 照跑、在线状态照转）。真正的缺口只有一个——已有用例覆盖了 `spaces` 和 `perUser`，**没有一条碰 `users`**，也就是在场名单本身。补了两条：伪造别人的在场记录、以及把别人的在场状态改成离线（后者是全文件唯一断言「已存在的值活下来了」的一条——一道只挡新建、不挡覆盖的门会让其余每一条都照常绿）。伪造用的载荷还配了自己的对照，因为一个什么都没写的载荷会让两条拒绝用例一起假绿。**这一轮真正的教训是我补的测试自己就是三种假绿**：断言写成「这个根是空的」（空只是因为测试服务器摘掉了在场接线）· 判据整个寄生在一个没人守的常量上 · 新载荷从没被证明过有写入能力。每条修完都做变异自证，而第一次变异做错了——把字段按必填加回去红了一片，但红的是 fixture 缺字段，**没证明是那条守卫在守**；改成按可选加回去才隔离出来。「测试红了」和「我这条测试红了」是两回事
- [x] **删掉一个再没人写的字段，和唯一读它的那道善后（#1889，PR #410）**：画布节点上有个 `operationLocks`，本该记录「谁正在配置这个节点的哪个 mini-tool」；配套有一道断线善后，客户端断开时按用户 ID 把这个人的记录删掉。它接过一周线（2026-05-11），2026-05-18 的 web 重写把生产者整片抹掉，此后再没人写过一个字。任务立项时记的是另一回事——**善后挂在「一条 socket 断开」上、却按「用户 ID」干活**，同一个人开两个标签页时关掉其中一个会把另一个正握着的记录也删了，横跨了两个不同的概念；这个矛盾在代码上真实存在，但自 2026-05-18 起它伤不到任何人，因为已经没有任何代码会产生记录。**于是那道善后只剩代价没有产出**：每次有人关掉画布标签页，服务端开一条直连、遍历全部节点、一个都匹配不上、关掉连接——而那对开关正是「客户端认证成功却拿不到文档、前端一片空白且无报错」那个竞态的触发源之一。删掉字段、类型、两处导出、模块本体与它的两个测试，以及 15 个测试文件里的 fixture。**没有功能需要接替**：那道善后的另一半（回收前端驱动的 handling）2026-07-02 就已移除，租约清扫器一直在跑、这次一个字没动。删除类改动写不出「先红的新测试」，改用反向证明——删除前全绿、删除后全量仍全绿，**任何一条因删除而红都说明有活的消费方**；再加两条判据：全仓字符串零残留（Yjs 按字符串键读写，typecheck 结构上看不见）、直连生产调用点从 10 降到 9。**三道对抗关咬回的没有一条是行为洞**，全是文案和测试，其中三条是我自己新写的断言反了：说清扫器「不是加速器背后的兜底」（错，还有两个加速器）· 说缺租约的节点「会一直卡着」（反了，是**立刻**被回收，更糟）· 说这个字段「从未接线」（跟我自己的提交说明打架）
- [x] **每个客户端都在把别人的在线状态回传给服务器，这条已经不成立了（#1887，PR #415）**：上一批任务里记下一个洞：浏览器从服务器收到「B 上线了」之后，会把 B 的状态原样再发回服务器一遍，人越多放大越明显。根因当时查得很实：协作库分得清一次状态变化是本地产生的还是刚从网络收到的，而客户端 3.4.4 拿到了这个信号却一次都没读，无条件全部转发。**但这条任务的前提在它被记下来的同一天就失效了** —— 2026-08-06 我们把协作库升到 4.5.0（`50794797`，为别的事做的），新版本第一行就是「刚从网络收到的，不再发回去」，顺手把它带上了。所以这次交付的不是修复，是**把这条不变量钉住**：它整个靠第三方撑着，而仓里没有任何东西会察觉它消失 —— 降级、依赖解析变化、上游回归，三种情况看起来都只是「安静」。测试用真的客户端、真的协议库，把远端状态当成真的一帧喂进去（`onMessage`，跟网络进来的是同一个入口），所以「这一帧算不算远端」是库自己判的、不是测试挑的；再加一条对照断言「自己改状态时确实会发出去」，否则「什么都没发」也可能是观测点本身是死的；每条「没发」旁边还各配一条「这一帧确实落进来了」，不然沉默跟「压根没收到」分不开。**量的是交给 socket 的真字节**（解回「这一帧提到了哪些人」），不是上一层的调用参数——量在上一层的话，一个无视参数、把整个房间塞进帧的编码器会原样重现这次要防的症状而全部照绿。**变异自证**：把旧版那个不读信号的实现换回去（保留真实的发送路径，只把那道闸绕过去），**三条立刻红**——「收到别人的状态不往外发」「连收五轮仍不往外发」「删除只提被删的那个人」，其中第二条红出 5 条消息、放大效应直接显形；而对照那条（自己改状态确实会发出去）保持绿。**顺带记一次差点误判**：我从代码推出「协议库自己的过期清扫会把删除发出去，所以一条消息里仍然会有别人的编号」，写成断言一跑就红。**红的不是这个推论，是我的测法** —— 清扫读的时间来自 lib0 的 `getUnixTime`，那是模块加载时就抓住的原始 `Date.now`，假时钟换掉 `Date` 之后它永远不动，清扫在测试里根本触发不了。改成直接调用清扫自己调的那个函数（仓里 bfcache 那个测试早就是这么做的），推论被证实。差一点我就把一个正确的结论当成错误写进三处文档。**还捡到一个新问题**：服务端每帧都先把 awareness 应用到一份临时副本、再按副本里**还剩下的**客户端重新编码，而删除带的是空状态、根本不会在那份每帧新建的副本里建出条目——于是删除永远不会被重新编码，**客户端发的删除到不了服务端文档**。这条读了代码没真跑，也不在本次范围内，记成 #1893。**而钉不变量的过程里翻出了真正该做的那件事**：#1886 给服务端的盖章规则留了一支，专门认出「这一条登记在别人的连接名下」然后**原样放行** —— 而入站帧是一串按 Yjs client id 编键的条目、那个键是浏览器自己取的数字，所以手工构造一帧就能把条目编到别人的键上，让房间里所有人看到一个顶着别人名字和颜色的光标（实测：甲发出去的帧里，乙那一条原样落地）。**这一支当初没有拍过板，是「A 替 B 说话」能成立的唯一原因，所以整个删掉** —— 不是加一道校验、不是加一张表，是**净删代码**：删掉那一支、跟着没人用的两个参数、调用方为它们遍历全部连接攒集合的那一整段，以及一路传到钩子的 `document` 实参。服务端从此**不问「这一条归谁」，每一条都盖**上握手时认证出来的那个人。**不问是因为问不出可信答案**：协作库的连接名单对**重连**的客户端是空的（连接的 client 集合只从 `added` 长，而文档见过的 id 之后一律归 `updated`，远端客户端的 `meta` 永不清），而 y-protocols 给这件事留的钩子 `modifyAwarenessUpdate` 只把状态交给回调、**故意不传 client id** —— 上游的态度就是这个数字不该拿来做判断。**顺带修好一个既有缺陷**：断线重连时旧的半开连接最长还活约 120 秒，那段窗口里重连者**自己的**条目会落进「登记在别人名下」被放行，而浏览器自 #1886 起一个字都不自报身份，于是那条进文档时**没有用户编号** —— 别人看到一个查不出名字和颜色的光标。这是本次唯一真实的行为变化，两条真服务端用例钉住它（冒充、重连），**都做了变异自证**：换回旧实现两条立刻红、同文件其余八条照常绿。**其中「重连」那条差点是假绿**：第一版没管 awareness 的时钟，两帧时钟相同 → 后一帧被 `currClock < clock` 直接丢弃，而它期望的值跟旧条目上留着的值恰好一样，于是绿的原因是「旧条目还在」而不是「盖章生效」（「冒充」那条期望的是另一个人，帧被丢弃只会让它红——那一条缺时钟是**测不到**、不是假绿）；补上更高的时钟才真正测到，另加哨兵值和光标坐标断言，让「没盖章」「没落地」「盖对了」三种结果互相分得开。**明确不做**（已定案，别再翻）：把 `clock` 顶到极大值让某人光标不动这件事——需要正当成员故意为之、后果只有光标、刷新即恢复，属于人和人之间的关系问题，靠沟通和移除成员收场，不写代码防、也不记 todo；连带不做「`clientID` → 用户」映射表、每人占几个 `clientID` 的封顶、发现伪造就断连
- [x] **视频节点能生成了：右键生成开出独立的视频面板（#1899，PR #419，伞任务 #1896 的第一个）**：画布上早就能建视频节点、能上传、能播放、能看历史，唯独**生成不了**——右键菜单里「生成」那一项一直是灰的，而后端其实全都齐了（模型目录 / 模式定义 / 上游通道 / 任务派发），探针实测 54 秒能出一段真 mp4，已经付出的那部分成本一个用户都碰不到。这次只接**文生视频**，模式选择器、素材槽位、参考轨道归后面五个 PR。**面板是两个不是一个加模态分支**（user 2026-08-08 拍板）：值得共用的零件早就在更下一层共用好了（模型选择器 / 比例选择器 / 提示词编辑器本来就跟模态无关），把面板也合并等于在错的层再共用一次。「能不能生成」和「开哪个面板」拆成两个问题：前者是 `canGenerate(type)`、读一份可生成模态清单，它住在 `@breatic/shared` —— 一个 web 与后端共用的包，**所以它必须跟面板无关**（今天它的两个调用方其实都在 web，位置合不合适另有待办在追）；后者是前端一张模态→面板种类的映射，**查不到就什么都不开**，而不是退回图片面板——那会是一个视频节点的 id 配上图片面板的内容，看起来像功能正常直到有人发现控件不对。**参数三组同形态、可选值全部来自当前模型自己**，模型没声明的那一组整个不显示；**时长有两种写法，只读一种会让整组消失**（四个模型给 `values` 列表、`kling-o3-pro` 给 `min:3/max:15`），范围型按整秒展开。**取值函数返回目录里的原始类型而非显示字符串**——时长是数字，转成字符串会把 `5` 发成 `"5"`、且控件认不出自己的当前值。真浏览器 smoke 端到端：选 16:9 + 5 秒，落地 1920×1080、5.04 秒的 mp4，**证明那个 5 是以数字走完整条链的**。
- [x] **视频面板接上参考轨道和图生视频（#1902，伞任务 #1896 的第二个）**：上一个 PR 的面板只能凭一段文字生成，这次它能**从画布上的素材出发**——模式选择器给出文生视频 / 图生视频两档，工具条最左边永远是「参考」，选到图生视频时右边多出一个「首帧」槽位。**参考和槽位是两种东西，不要混**：参考是**关系**，点一下在两个节点之间**连一条线**，轨道从入边实时派生，改名、重新生成上游它都跟着变；槽位是**挑选那一刻的一份 URL 拷贝**，跟被点的那个节点此后再无关系（照 `styleImageUrl` 既有形态）。**连了线还不算用上**——必须在提示词里打 `@` 把它挑出来，文本节点的内容会在提交那一刻替换进发给上游的提示词（真机实证：请求体里 `params.prompt` 是替换后的完整句子，不是 chip 名字）。**槽位挑选判的是被点节点自己的类型**，不是轨道里那些已连线的——轨道只装连过线的，拿它当过滤器等于谁都选不中；配套一层候选高亮（只有图片节点亮着，其余变暗）。**这里有个静默陷阱**：挑选目的是一个封闭联合但没有穷尽判断，新加一支忘了接就会**悄悄落进「参考」那一支去连一条边**，看起来像功能不全实际是连错了东西 —— 所以真机专门验了「首帧挑选态下点音频节点」：槽位没填、挑选态还在、**边数一条没多**。**槽位的 URL 必须进资产存活账**，两处清单都要（删除时的存活集 + 单个 URL 的存活判定）：不进的后果是双向的 —— 挑了 A 图当首帧再删掉 A 节点，会上报一个仍在被引用的资产已删除；清空槽位后那份只被槽位引用的资产又永远进不了账。真机验了这一条，**并配了对照**：删被首帧引用的图片节点零上报，删一个无人引用的视频节点立刻上报两条（视频 + 封面），证明「没上报」是引用起了作用而不是上报路径本身死了。**首帧只在需要素材的模式里上路**——从文生视频切回去时那份拷贝还留在节点上，但不会跟着请求走（上游读的是这个键在不在，不是它的值）。端到端真机：挑一张红枫叶当首帧、@ 引用一个文本节点，出的 5 秒 mp4 第一帧就是那张图。
- [ ] 多实例负载均衡验证：Redis extension 跨实例同步测试

### AI 能力

- [ ] Canvas Skill：各模态智能模式 Skill（在 config/skill-routing.yaml 的 surfaces 里开 canvas，单次执行，直接生成）
- [ ] 模型推荐引擎：Agent 根据用户意图自动选择最佳模型，不需要用户手动选

### 安全

- [ ] Skill 安全分级：第一版不做脚本执行（skill 只能声明工具、不能带脚本），所以暂无分级可言。将来要让 skill 带脚本时，「在哪跑 / 跑多久 / 能碰什么 / 失败怎么办 / 算不算钱」是一整套要单独设计的东西，届时连同 isolated-vm / 容器沙箱 / Webhook 一起定
- [x] 上传改为 presigned URL：`GET /assets/presign` → 直传 S3/OSS/本地，前端不持有 credentials
- [x] **资产归属统一到 studio 级（#1839）**：推翻 2026-07-04 定为 final 的「个人 studio 项目按操作者分流」规则。归属与去重范围一律看 **project 所属的 studio**，个人与团队一条路径、谁操作不进入判定——旧规则下 A 邀请 B 进自己项目协作，B 的产出落在 B 的 studio 下：A 在自己项目里看不到它，去重也形同虚设（一人一个域，同样的字节按人各存一份），没有个人 studio 的协作者更是直接传不了。同批新增 `studio_assets.produced_by_user_id` 把「归属」和「产出人」拆成两列（旧规则把产出人隐式压在 `studio_id` 里，删分支会连带丢失），去重命中保留**第一个**产出者。migration 0044 三步走（加 nullable → 从 `studios.created_by_user_id` 回填 → 置 NOT NULL），回填对个人 studio 行精确、对团队 studio 行是**近似值**且在 SQL 里明确标注。**安全模型是产品决策**：一个 studio 一个去重域 ⇒ 该 studio 下任意项目的 editor 共享其 hash 命名空间，内容存在性探测 / 跨用户 dedup 投毒 / 配额消耗 / 拿同 studio 他人的任意资产当自己视频节点的封面（`cover_hash` 残余）四条风险，由**发出邀请的用户承担**（邀请即信任），不做技术收口。**注意：告知面尚未建立**——用户手册与服务协议都还不存在，这条 `[x]` 只覆盖代码侧，告知本身是未完成的待办（归 operations）
- [x] **存储层重构（#1826）**：承接上一条把归属从 key 里拆出来。**key 租户中立**（`{taskType}/{date}/{时间戳}_{uuid}{ext}`，不再把 `{userId}/{projectId}/` 焊进每个公开 URL、泄漏账号拓扑）；**新增 `upload_grants` 下发记录表**接管"这 key 是不是你的"（presign 每铸一个 key 写一行：user + 服务端解析的 owner studio + 声明 hash），取代靠前缀判定的 `isOwnedKey`——它同时提供**权威 owner studio**（不信客户端报的 project_id，否则跨 studio 成员能把个人存储成本转嫁给团队）并把报告**绑定到当初申请的那份内容**（否则并发两个报告能在一个 key 上登记两个 hash，把一个还活着的对象送进回收队列 → 404）。**新增 `storage_reclaim_queue`** 待回收清单：去重命中时多出来的物理份只**登记**、不删，交离线回收（runtime 零删除攻击面 + 离线有明确工单）。**四条铁律**：runtime 只插不删 · 消费方 URL 一律取自登记记录（绝不钉刚上传、可能成孤儿的 key）· 登记失败即上传失败**零例外**（封面是视频上传的一半，#1816 原子契约）· **没 hash 不许传**（前端算不出就不发起，后端 presign + `/uploaded` 都必填）。**类型 / 大小 / 上限全部后端从"存下来的东西"读**（cloud `head()`、local magic-bytes 嗅探 + SVG/文本内容感知回落）——这是 local 上传 kind 全成 `'file'` 那个老 bug 的真修；权威 size 拿到后回头复核上限，"声明 1KB 传 50GB"绕不过去。另含：账号存储用量 = 该账号管理的每个 studio 相加、视频封面登记为一等资产行、local 流式写入走临时文件 + 原子改名（半成品不会被当成已完成对象注册）、画布拒收 0 字节文件

- [x] **守卫套件迁到 TypeScript（#1842 + #1835）**:41 个 bash 守卫脚本换成两层,**bash 守卫一条不剩** —— **ESLint 规则**(`eslint-rules/`)管每个源文件内部的语法问题,**`repo-lint/`**(新 workspace 包)管其余一切:ESLint 从不解析的文件(sql / yaml / sh / css / html)、构建产物、文件存在性。迁移过程用"种一个真违规、看旧守卫报不报"逐条实证,量出 8 个真实缺陷:`upload_grants` 被行号状态机遮住 · `service-logging` 一个 import 就能满足 · dist 别名扫描漏了 `@locales` 和 `require()` · `no-brand-usage` 把注释当违规、白名单只存在于注释里 · `no-cjk` 扫描根够不着仓库根与 `scripts/` 下的非 `.sh` · `no-private-repo-path` 只扫 5 个目录 · secretlint 包装脚本 fail-open · 15 条已失效的豁免。**统一 fail-closed**:选不到文件即失败(选空 = 检查了零个文件,不是"干净")、构建目录缺失即失败、未知检查名 exit 2、豁免条目指向不存在的文件即失败。文件清单取自 `git ls-files --cached --others`,新写但未提交的文件同样纳入(否则新文件在落地前一直"干净")。CI 从每条守卫一个步骤收敛成两条命令。**五轮对抗复攻**逐轮咬出同一个根因 —— 手写的解析器冒充真解析器 —— 于是逐个换成真的:workspace 声明交给 YAML 解析器、glob 交给 `minimatch`(拿 pnpm 本人实测对齐)、SQL 交给 PostgreSQL 自己的解析器(`plpgsql-parser`,能读进 `DO $$` 块所以里面的外键不再隐形)、ESLint 配置直接问 ESLint(而不是扫它的文本,后者看不见从别处 spread 进来的 glob)、迁移目录靠 drizzle 自己的 `meta/_journal.json` 发现(而不是写死路径)。同时**退掉两个不该是守卫的守卫**:`doc-links`(起 7 个 typedoc 进程问「链接解析得了吗」,而 `breatic/doc-link-resolves` 这条 ESLint 规则问的是同一个问题、问得更全 —— 文档生成器只看得见导出面,而这里每个命名函数都写注释、绝大多数注释根本不在它视野里)· `no-notification-name-keys`(拿文本扫描去管一条数据模型的业务规则,而文本分不开「存进记录的 key」和「同名的局部字段」)。**包根也纳入 lint 与 typecheck**:此前每个包只跑 `eslint src/`,于是各包根的 `vitest.config.ts` / `drizzle.config.ts` / `eslint.config.ts` 落在所有规则之外,而 `lint-coverage` 照样报绿 —— 因为它问的是「这个包跑没跑 linter」,从没问过「linter 看不看得见这个包」
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

### 共享 HTTP 传输层 —— 调用点接入（五批，各一个 PR）

**传输层本身已合并（#386）**，在 `packages/shared/src/http/`，前后端共用，打**外部**的请求（云存储 / vendor API / 任意网址）走它，打我们自己后端的继续走 web 的 axios 单例。规范见 [`packages/shared/CLAUDE.md`](../packages/shared/CLAUDE.md)，架构位置见 [`ARCHITECTURE.md`](./ARCHITECTURE.md#shared-http-transport)。

五批分别是：

| 批 | 接什么 | 状态 | 附带 |
|---|---|---|---|
| 1 | worker 的 vendor 调用：20 个 transport、43 处调用点 | 已接入（#388）| 轮询也一起收编 |
| 2 | 素材下载两条路：`downloadToTempDir` + `downloadValidated` | 已接入（#389）| 原计划「让重试日志出口穿过适配器」已不适用 —— 适配器里的重试循环整个删了，没有出口可穿；重试的可观测性归传输层统一做，未开始 |
| 3 | 浏览器上传的 PUT（**只这半边**，预签名打自己后端、留在 axios）| 已接入（#395）| 按文件大小算的停滞守卫进 `timeoutMs`，正是这一层要求调用方自己算的那种。顺带删掉 `assetsApi.putFile` 这个已无调用方的裸 `fetch`。**同批补了一道配置守卫**：这一层拒收定时器接不住的截止时间（而不是夹紧），而旧路径把同样的数交给浏览器的 `AbortSignal.timeout` 是收的，所以速率旋钮调得够低时，接近上限的上传从「能传」变成「零字节失败」。判为运维配置问题而不是代码要去兼容的事，`storageConfigSchema` 改为在加载时按 `max_upload_bytes` 判这对旋钮、报错带最低可填值，server 入口改为启动时解析（原本懒加载，第一个碰到它的请求才炸）|
| 4 | agent 的联网工具：`web_fetch`（经 `safe-fetch.ts`）+ `web_search` | 已接入（#400）| 这两个工具此前各自裸 `fetch` 且**零重试**，一次网络抖动就是一次工具失败，也是整条线的起因。两处均声明 `replaySafe: true`（都是纯读，一次投递的唯一效果就是那个响应），原有 30 秒 / 10 秒原样搬进 `timeoutMs`。**同批给 SSRF 守卫补了第一份自动化测试**——这个安全控制此前零覆盖，其中 IPv6 字面量走的是跟 IPv4 不同的那条分支（`URL.hostname` 保留方括号，`ipaddr.isValid("[::1]")` 因此是 false），本批之前没有任何测试保护它。**两个语义变化**：`timeoutMs` 管一次投递而不是一跳（一跳可能被投递多次，每次各拿全额，所以它不再是一跳的上界）；读响应正文这一步不再受它管（传输层在交出响应前就把定时器清了），归「工具级超时」统一处理，不在本批内改 |
| 5 | 加守卫封住裸 `fetch` + 同步文档 | 已接入（#403）| 新规则 `breatic/no-naked-fetch` 按**作用域解析**判「这个名字指向平台那个 `fetch` 吗」，不按调用形状匹配。判据只有一条：**这个标识符解析到平台的 `fetch`，而且它在值位置** —— 所以「不调用只传递」的写法（赋给变量、当简写属性、当实参）一样抓，三个载体（`globalThis` / `window` / `self`）的点号和计算成员两种拼法一样抓；局部同名参数不抓（它压根不是那个 `fetch`），纯类型位置也不抓（`typeof fetch` 编译后就没了、发不出请求，判据抄 ESLint 自己的 `no-restricted-globals`）。**具体几种写法不写在这儿** —— 规则测试文件的用例列表就是那份清单，写个数字在文档里只会过期。**两处声明**：根配置管 6 个后端包，`packages/web/eslint.config.mts` 管 web，因为从 web 启动的 ESLint 读不到根配置。同批删掉三个零消费方的配置键（`http_max_retries` / `http_retry_base_delay` / `download.*`，共六个位置），并把 core 那份逐字节相同的退避副本折进 `shared/backoff.ts` —— core 只留 BullMQ 那个 1 起头转 0 起头的换算 |

**给碰到外部 HTTP 的人**：新写的外部请求直接用 `httpRequest`，别再自己写重试循环 —— 这条线的起因正是同一个判据在三处写了三遍、给出三个不同答案。

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
