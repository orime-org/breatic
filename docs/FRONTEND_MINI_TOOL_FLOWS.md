# 前端 Mini-Tool 实现流程规范

> **状态**:草案,对应 T3 phase4 批量迁移方案。
> **读者**:接手前端批量迁移 PR 的开发者 / Review 者。
> **范围**:mixed editor 里所有 mini-tool 的前端实现契约。不涉及主画布(canvas)与 videoEditor 子应用。

## 0. 背景

T3 phase4a/4b/4c(PR #168/#169/#170)已经把后端 mini-tool 路径处理完毕。前端仍有两类遗留:
1. 7 个 video 工具(speed/cut/adjust/audio-denoise/stabilization/hdr-conversion/scene-extension)**仍在浏览器跑 ffmpeg.wasm**,后端 handler 已就绪但前端没切过去
2. image 前端侧很多工具 UI 已经搭好但保存 handler 是 stub(mark/graffiti/stitch/gridSlice/upscale/multiAngle/relight/remove-bg)

本文档给出**每个 mini-tool 的前端实现模板**,迁移 PR 必须按模板落地。

---

## 1. 核心架构

### 1.1 前后端分界原则

**<100ms 瞬时操作走前端;秒级操作走后端。** 增加一次 HTTP 往返就能把无感操作变成可感延迟。详见 memory `feedback_frontend_backend_boundary`。

### 1.2 两种执行模式

| 模式 | 用途 | Yjs 写入时机 | 崩溃语义 |
|------|------|-------------|---------|
| **Type A(X pattern)** | 前端自主跑(Canvas / Fabric / 前端合成+上传) | 跑完一次性写 `state:'idle'` | tab 死亡 = Yjs 零残留 |
| **Type B(handling)** | 需要后端 worker | 触发立即写 `state:'handling'` | 后端生命周期兜底(BullMQ 重试 + failed 事件) |

**产品规则**:`handling` 状态的节点不可被用户删除。Type A 的 X pattern 正是为规避这条约束而存在——前端 pending 不进 Yjs,不受此规则约束。

### 1.3 state 三态语义

```ts
// packages/web/src/apps/project/components/mixedEditor/types.ts
type state = 'idle' | 'handling' | 'localPending'
```

| state | 谁看得见 | 持久化 | 可删除 |
|-------|---------|--------|--------|
| `idle` | 所有协作者 | Yjs | ✓ |
| `handling` | 所有协作者 | Yjs | ✗(产品规则) |
| `localPending` | **仅发起者**(`pendingTasks` map,tab-scoped) | **不写 Yjs** | 本地 drop 即可 |

### 1.4 失败契约

混编(mixed editor)约定:**失败即终态,无重试 UI**。用户若要重试,手动删失败节点再重新发起。

| 模式 | 失败动作 | Yjs 结果 |
|------|---------|----------|
| Type A | `failLocalPendingNode(id)` + `message.error()` | 无节点(本地 drop) |
| Type B | `updateNodeData(id, { state:'idle', content:'', coverUrl:'', errorInfo })` | 节点存在,content/coverUrl 清空,errorInfo 显示 |

### 1.5 浏览器崩溃 / 断电 / 强杀的处理

| 模式 | 结果 |
|------|------|
| Type A | pendingTasks 随 tab 死亡消失 → Yjs 零残留 → **零清理需求** |
| Type B | handling 节点由后端 BullMQ 重试 / failed 事件兜底 → **零清理需求** |

**无需心跳 / sessionId 自检 / TTL 等额外清理机制。**

### 1.6 X pattern API(`useMixedEditorActions`)

现有 API:

```ts
// Type A 三件套(X pattern)
addLocalPendingNode(node: Node) => nodeId           // 仅本地
resolveLocalPendingNode(nodeId, patch) => void      // 一次性写 Yjs(state:'idle',硬编码)
failLocalPendingNode(nodeId) => void                // 丢本地 entry + 屏幕顶 toast

// Type B 一件套
triggerBackendMiniTool({
  sourceNodeId, category, toolName, nameSuffix,
  expectedSize?, params
}) => Promise<nodeId | null>                         // 立即写 Yjs(handling)
```

迁移需新增的 API:

```ts
// 模板 ② 用:本地占位升级成 Yjs handling 节点(同 id 同位置)
// 语义:先 removePendingTask → flow.set(nodeId, {...node, data:{...patch, state:'handling'}})
// 和 resolveLocalPendingNode 差别:state 写 handling,并保留 handlingBy
promoteLocalPendingToHandling(nodeId, patch) => void

// 多输出(video.cut / gridSlice 用):一次创建 1 个 group + N 个子节点
createGroupWithChildren({
  groupNode: Node,                                   // type:'group' 容器,state:'idle'
  children: Node[],                                  // 每个都 parentId=groupNode.id
  childState: 'localPending' | 'handling',           // 决定子节点走 X pattern 还是 Yjs handling
}) => { groupId: string; childIds: string[] }
```

---

## 2. 流程模板

### 2.1 模板 ① — 纯前端创建新节点

**适用**:crop / adjust / expand / mark / stitch / gridSlice

```
T0  用户触发工具 UI(overlay/toolbar)
     ↓
T1  addLocalPendingNode(placeholder)
     • 发起者自己 ReactFlow 立刻出现占位 + spinner
     • 协作者无感
     • Yjs 未写
     ↓
T2  Canvas / Fabric 处理(<100ms)
     ↓
T3  Blob → presigned URL 上传(秒级)
     ↓
T4  resolveLocalPendingNode(id, { state:'idle', content: 永久URL })
     • 本地占位移除
     • Yjs 首次写入 — 协作者开始看到节点(直接 idle)
     ↓
失败路径(任一步 throw):
     failLocalPendingNode(id) + message.error(...)
     • Yjs 永远没写过 — 协作者无感
```

**关键**:上传失败也走 `failLocalPendingNode`,不走失败占位节点。因为协作者从未见过此节点,失败不需要"展示失败态"。

### 2.2 模板 ①' — 原地更新(flipRotate 专用)

**适用**:flipRotate(无损变换,无需保留原图对比)

```
T0  用户点 flipRotate 菜单
     ↓
T1  Canvas bitmap transform(<10ms)→ 得到新 Blob
     ↓
T2  Blob → presigned URL 上传(秒级)
     • 此期间原节点 content 还是旧 URL,用户看上去 flipRotate 结果未应用
     • ⚠️ 需要一种"原节点上传中"的 UI 反馈(按钮 loading 或节点浮层)
     ↓
T3  updateNodeData(id, { content: 新URL })
     • Yjs 原地更新
     ↓
失败路径:
     message.error(...) + 原节点保持旧 content(用户再试)
```

**⚠️ 开放问题**:当前实现(`handleFlipRotateApply`)直接写 data URL 进 Yjs,等同于把几百 KB 塞协作文档里,会让 Yjs 快照膨胀 + 跨实例同步变重。**迁移时必须改走上传**。

### 2.3 模板 ② — 前端合成 + 后端 AIGC

**适用**:graffiti(前端烧笔画 + 拼 prompt → 后端 nano-banana-2-edit)

**关键特性**:**同一个节点 id 贯穿整个生命周期**,state 从 `localPending`(本地占位)→ `handling`(Yjs)→ `idle`(Yjs)。

```
T0  用户在原图节点上画笔画(overlay,尚未创建新节点)
     ↓
T1  用户点"生成"
     ↓
T2  addLocalPendingNode(placeholder)  ← 新节点 id=X
     • 发起者 ReactFlow 立刻出现占位 + spinner("合成中...")
     • 协作者无感
     • Yjs 未写
     ↓
T3  Canvas 合成(笔画烧进原图)(<100ms)
     ↓
T4  合成图 Blob → presigned URL 上传(秒级)
     ↓
T5  前端拼 prompt("红色区域:X;绿色区域:Y")
     ↓
T6  promoteLocalPendingToHandling(X, { handlingBy, nameSuffix })
     • 本地占位从 pendingTasks 移除
     • Yjs 首次写入 id=X 的 handling 节点
     • 协作者开始看到节点(state:'handling',与其他后端任务一致)
     ↓
T7  triggerBackendMiniTool 的 POST 请求发起(同样使用 id=X,避免新建节点)
     params:{ image: 合成图URL, prompt, host_node_id, node_id: X }
     ↓
T8  后端 worker 调 nano-banana-2-edit(秒级到分钟)
     ↓
T9  Redis stream → Collab observer → Yjs 节点 X 原位置 state:'idle' + content
     ↓
失败路径 A:T3/T4 合成或上传失败
     failLocalPendingNode(X) + 屏幕顶 toast
     • Yjs 永未写过 id=X,协作者无感
     ↓
失败路径 B:T6 升级成功后 POST 失败
     updateNodeData(X, { state:'idle', content:'', coverUrl:'', errorInfo })
     • 节点留在 Yjs(协作者可见),用户手删
```

**⚠️ 要求**:`promoteLocalPendingToHandling` 和 "POST 带 node_id=X"的组合需要 `triggerBackendMiniTool` 支持 `existingNodeId` 参数(不新建 placeholder,用已经 handling 的节点)。现有签名没这个参数,要扩展。

### 2.4 模板 ③ — 纯后端

**适用**:video 单输出本地 FFmpeg(crop 已迁,speed/adjust/audio-denoise/stabilization/hdr-conversion/scene-extension 待迁)+ 所有 AIGC(image/video/audio)

```
T0  用户触发工具 UI
     ↓
T1  triggerBackendMiniTool({ category, toolName, params })
     • 立即写 Yjs handling 节点
     ↓
T2  后端 worker 跑 FFmpeg / AIGC(秒级到分钟)
     ↓
T3  Redis stream → Collab observer → Yjs state:'idle' + content [+ coverUrl]
     ↓
失败路径:
     POST 失败 → handling 节点翻 idle + errorInfo
     Worker 失败 → Redis failed 事件 → 同上
```

### 2.5 模板 ④ — 多输出(group + N 子节点)

**适用**:
- **video.cut**(N segments → N video 节点,后端)
- **image.gridSlice**(1 图 → N 切片,纯前端)

两者都用 ReactFlow `group` 做视觉容器,用户看到"这 N 个节点来自同一次操作"。group 本身 state:'idle',不承载 task 状态;task 状态在每个子节点上。

**用户交互**:子节点**不锁死在 group 内**。用户可以:
- 选中 group 整体移动 / 删除(删除规则见 § 1.4 + 阶段 1 group 守护)
- 解组(工具栏"Ungroup")把所有子节点独立出来
- 选中单个子节点拖出 group(自动触发 `parentId:null`,类似主画布 `canvas/index.tsx:495-503` 逻辑)
- 单独删某个子节点(如果是 idle)

所有上述操作走 `setNodes` / `updateNode` 原子写入,自动 undoable。

#### 2.5.1 纯前端多输出(image.gridSlice)

```
T0  用户选原图 + 网格(e.g. 3x3)
     ↓
T1  createGroupWithChildren({
        groupNode: { type:'group', state:'idle' },
        children: [9 个 image 节点,各自占位尺寸按切片比例],
        childState: 'localPending'
     })
     • 发起者 ReactFlow 看到 1 个 group 框 + 9 个 spinner
     • 协作者无感(X pattern)
     ↓
T2  Canvas 切 9 份(<100ms 各 drawImage 一次)
     ↓
T3  每份 Blob → presigned URL 上传(并发 9 个请求)
     ↓
T4  每份上传完成 → resolveLocalPendingNode(子 id, { content: URL })
     • 上传一个亮一个(渐进式);Yjs 每次 resolve 写一个子节点(state:'idle')
     • 协作者逐个看到子节点出现
     ↓
所有上传完成后,group 节点已有全部 9 个 child,用户看到完整 3x3 组
     ↓
失败路径:某一片上传失败
     failLocalPendingNode(失败子 id)  ← 对应 spinner 消失
     继续等其他片段上传
     屏幕顶 toast "1/9 切片上传失败,请重试"
     • group 保留其他 8 个子节点;用户可手动选中 group 整体删除重试
```

#### 2.5.2 前端 + 后端多输出(video.cut)

```
T0  用户选 N segments,点 Save
     ↓
T1  前端构造 N 个预期 video 节点 + 1 个 group 节点
     (预期尺寸按 segment 时长估算宽度,高度按源视频比例)
     ↓
T2  createGroupWithChildren({
        groupNode: { type:'group', state:'idle' },
        children: N 个 video 节点,
        childState: 'handling'       ← 和 gridSlice 区别:直接 handling
     })
     • Yjs 立即写入:1 个 group + N 个 handling 子节点
     • 发起者和协作者同时看到 group 框 + N 个 spinner
     ↓
T3  triggerBackendMiniTool({
        category:'video', toolName:'cut',
        params:{ video, segments },
        nodeIds: [子节点 1, 子节点 2, ..., 子节点 N]   ← 新增字段
     })
     ↓
T4  后端 worker 对 N segments 调用 ffmpeg 多次(无 concat),得到 N 个 MP4
     ↓
T5  Worker 返回 { urls:[N], cover_urls:[N] }(result schema 扩展)
     ↓
T6  Redis stream publish N 个独立 completed 事件
     (每个 { task_id, node_id:子节点 i, url:urls[i], cover_url:cover_urls[i] })
     或 1 个 batch 事件 { task_id, node_ids, urls, cover_urls }
     ↓
T7  Collab observer → Yjs N 个子节点各自 state:'idle' + content + coverUrl
     • 所有协作者同步看到 N 段视频(每段独立可操作)
     ↓
失败路径:
     worker 失败 → Redis failed 事件(batch)→ Collab 把 N 个子节点全部翻 idle + errorInfo
     或单段失败 → 该段翻 idle + errorInfo,其他段正常完成
```

**⚠️ 后端 multi-output 基建需要**:
- `LocalHandlerResult` 加 `urls?: string[]` + `cover_urls?: string[]`
- `video/cut.ts` handler 改:不 concat,分段导出 N 个独立 MP4
- `NodeEvent` 增加 `batch` 类型(或 N 条独立 completed)
- Collab task-listener 适配多节点写回
- `triggerBackendMiniTool` 签名加 `nodeIds?: string[]`,和现有 `sourceNodeId`(单节点)二选一

---

## 3. 多输出方案(决策已定,见模板 ④)

### 3.1 video.cut:走 group + 后端多输出(方案 A)

**方向**:改后端为多输出 + 前端用 ReactFlow group 包装 N 个结果子节点。见 § 2.5.2 模板 ④。

**要改动的后端基建**(下一个后端 PR 必须先做):
1. `LocalHandlerResult` 加 `urls?: string[]` + `cover_urls?: string[]`
2. `packages/worker/src/handlers/local/video/cut.ts` 改:每段单独导出独立 MP4,不 concat
3. `packages/worker/src/mini-tool.ts`(或等价派发层)识别 multi-output result,按 `task.node_ids` 发 N 条 Redis stream 事件或 1 条 batch 事件
4. `packages/collab/src/task-listener.ts` 适配多节点写回
5. `packages/server/src/routes/schemas.ts` 的 `videoToolSchema` cut variant 加 `node_ids?: string[]` + 或者统一让 `triggerBackendMiniTool` 的 mini-tool POST 接 `node_ids`

### 3.2 image.gridSlice:纯前端 + group(方案 Frontend-only)

按用户决策,**gridSlice 归前端管**,不走后端。前端用 group + N 个 localPending 子节点(见 § 2.5.1 模板 ④ 纯前端版)。后端无任何改动。

---

## 4. Mini-Tool 清单

### 4.1 Image

| Tool | 当前 | 目标模板 | 迁移工作 |
|------|------|----------|----------|
| **crop** | 调后端(已撤,422) | 模板 ①(纯前端 Canvas) | 改写 `ImageNode.tsx:775 handleCropSave`,去掉 `triggerBackendMiniTool`,改 X pattern |
| **flipRotate** | 纯前端 + 原地 updateNode + dataURL 塞 Yjs | 模板 ①'(原地更新 + 上传) | 改写 `ImageNode.tsx:575 handleFlipRotateApply`,dataURL → Blob → 上传 → updateNodeData |
| **manual-adjust** | 纯前端 Fabric + X pattern + **3000ms 延迟 resolve** | 模板 ① | 保留架构,去掉 3 秒延迟改为 await 渲染完成 |
| **expand**(布局扩展) | 纯前端 Canvas + X pattern | 模板 ① | 微调;确认是否仍想保留为独立 tool(注册表无此 tool 名) |
| **mark** | UI 存在 handler 缺 | 模板 ① | 新实现 `handleMarkSave`:合成 overlay → 上传 → X pattern |
| **graffiti** | UI 存在 handler 缺 | **模板 ②** | 新实现 `handleGraffitiSave`:合成笔画 + 拼 prompt + triggerBackendMiniTool |
| **stitch** | 组件存在但未接入 Toolbar | 模板 ① | 接入 Toolbar + 实现 `handleStitchSave`(N 图输入 → Canvas drawImage 拼接 → 上传 → X pattern) |
| **gridSlice** | UI 存在 + 切片逻辑存在 + 后续调用 stub | **模板 ④ 纯前端版**(group + N 子节点) | 接入 `createGroupWithChildren` + 每段 Canvas 切 + 并发上传 + 逐个 resolve |
| remove-bg / upscale / sharpen / denoise / restore / adjust-topaz / relight / multiAngle / edit | AIGC provider 已就绪,前端 handler 部分 stub | 模板 ③ | 补齐各自 `handle*Save`,调 `triggerBackendMiniTool` |

### 4.2 Video

| Tool | 当前 | 目标模板 | 迁移工作 |
|------|------|----------|----------|
| **crop** | 调后端(已合入 `video.crop`) | 模板 ③ | 无需改,已完成 |
| **speed** | 浏览器 ffmpeg.wasm | 模板 ③ | 改写 `handleSpeedSave`(videoNode.tsx:1341),去 `speedVideoWithFfmpeg`,调 `triggerBackendMiniTool` |
| **adjust** | 浏览器 ffmpeg.wasm | 模板 ③ | 同上,改 `handleAdjustSave` |
| **stabilization** | 浏览器 ffmpeg.wasm | 模板 ③ | 同上 |
| **audio-denoise** | 浏览器 ffmpeg.wasm | 模板 ③ | 同上 |
| **hdr-conversion** | 浏览器 ffmpeg.wasm + 进度条 | 模板 ③ | 同上(失去进度条,因为后端不发进度事件。可接受) |
| **scene-extension** | 浏览器 ffmpeg.wasm | 模板 ③ | 同上 |
| **cut** | 浏览器 ffmpeg.wasm + 多节点 | **模板 ④ 后端多输出版**(group + N handling 子节点) | 后端 multi-output 基建 PR → 前端用 `createGroupWithChildren + triggerBackendMiniTool({nodeIds:[...]})` |
| upscale / interpolate / erase / extend / animate / talking-head | AIGC 已就绪,前端已接入 | 模板 ③ | 无需改 |

### 4.3 Audio

**当前前端无 mini-tool UI**(仅 AudioNodePlayer 播放器)。sfx / tts / voice-clone / separate / extend 后端 provider 已就绪,前端未接入。

本期**不纳入迁移**。待产品决定是否为 audio 节点添加工具栏再议。

### 4.4 不在本次迁移范围

- videoEditor 子应用的 3 个 exporter(`videoExporter` / `audioExporter` / `imageExporter`):按用户决策**ban 掉 UI 入口**,不做后端迁移。见 memory `project_t3_batch_status`。

---

## 5. 迁移执行顺序(建议)

**阶段 0 — 后端 multi-output 基建 PR**(必须先于一切前端迁移):
- `LocalHandlerResult` 加 `urls?/cover_urls?` 字段
- `video/cut.ts` 改多输出
- `NodeEvent` + Collab task-listener 多节点写回
- `mini-tools` 路由 + `videoToolSchema.cut` 加 `node_ids`
- 更新 `mini-tool-registry.test.ts` + 新增 video-cut 多输出测试

**阶段 1 — 前端 API 扩展 PR**(基建,前端批量迁移的底盘):
- 新增 `uploadBlobToStorage(blob, ctx)` 通用上传封装
- 新增 `promoteLocalPendingToHandling(nodeId, patch)` X pattern 升级 API(专门给 graffiti)
- 新增 `createGroupWithChildren({groupNode, children, childState})` 多节点群组 API —— 复用主画布 `GroupToolbarPanel.handleGroup` 同款 `setNodes` 原子模式
- **把主画布 `GroupToolbarPanel` 搬到 mixed editor**(抽成 `<GroupToolbarPanel mode="canvas"|"mixed" />` 或两个薄 wrapper),让用户在 mixed editor 里也能打组/解组
- 删除 handler 加 group 守护:`任一子节点 state==='handling' → group 不可删`(和 Q3 规则一致)
- `triggerBackendMiniTool` 签名加 `nodeIds?: string[]` + `existingNodeId?: string`
- 单测覆盖三个新 primitive + group 守护逻辑

**阶段 2 — video 6 个 ffmpeg.wasm 切 handling(模板 ③)**:
- 改 `handleSpeedSave / handleAdjustSave / handleAudioDenoiseSave / handleStabilizationSave / handleHdrConversionSave / handleSceneExtensionSave`
- 去掉 `*WithFfmpeg` 引用,改 `triggerBackendMiniTool`

**阶段 3 — video.cut 切模板 ④**:
- 改 `handleCutSave` 用 `createGroupWithChildren` + `triggerBackendMiniTool({nodeIds})`
- 删 `cutVideoWithFfmpeg` 引用

**阶段 4 — image 前端补齐(模板 ①)**:
- `crop`(重写:去 triggerBackend,改 Canvas + 上传 + X pattern)
- `flipRotate`(改 模板 ①':去 dataURL 写 Yjs,改上传)
- `manual-adjust`(去掉 3 秒延迟)
- `expand`(沿用现有 X pattern,微调)
- `mark`(新实现 `handleMarkSave`)
- `stitch`(接入 Toolbar + 实现)
- `gridSlice`(模板 ④ 纯前端版)

**阶段 5 — graffiti(模板 ②)**:
- 实现 `handleGraffitiSave`:`addLocalPendingNode` → Canvas 合成 → 上传 → `promoteLocalPendingToHandling` → `triggerBackendMiniTool({existingNodeId})`

**阶段 6 — image AIGC stub handler 补齐(模板 ③)**:
- `remove-bg / upscale / multiAngle / relight` 的 `handle*Save` 补 `triggerBackendMiniTool`

**阶段 7 — 清理**:
- 删 `packages/web/src/utils/videoEditor/*WithFfmpeg.ts`(7 个)
- 删 ffmpeg.wasm bundle 依赖 + CDN 引用(`@ffmpeg/ffmpeg` / `@ffmpeg/util` / `breatic.visiony.cc/ffmpeg/` CDN)
- ban Timeline Exporter(`videoExporter / audioExporter / imageExporter`)UI 入口
- `packages/web/src/apps/project/components/mixedEditor/types.ts` 里的 `'localPending'` 字面量保留(X pattern 内部仍用);只确保**没有代码直接写 Yjs 时写 localPending**——这条已在 `useMixedEditorActions.ts:198` 的注释里说明

**阶段 8 — 文档 & memory 更新**:
- 本文档补上"迁移完成"状态
- `FRONTEND.md` / `YJS.md` 刷新
- `project_t3_batch_status` memory 关闭

建议 PR 拆分:阶段 0 / 阶段 1 独立 PR;阶段 2-6 合一个大前端迁移 PR;阶段 7 清理一个独立 PR。

---

## 6. Appendix

### A. X pattern 机制细节

本地占位存储在 `MixedEditorDataContext.pendingTasks: Map<nodeId, PendingTaskEntry>`,tab-scoped,不持久化。`addLocalPendingNode` 同时:
1. 写入 `pendingTasks`
2. 塞入本地 React state 的 nodes 数组(ReactFlow 渲染占位)

`resolveLocalPendingNode` 同时:
1. 从 `pendingTasks` 移除
2. 从本地 React state 移除占位
3. `doc.transact(() => flow.set(nodeId, buildNodeYMap(finalNode)), userOrigin)` 写 Yjs

因为 React state 的移除和 Yjs 的写入几乎同步,发起者视角是"占位无缝替换成正式节点"。

### B. fabric.js vs 原生 Canvas 选择指南

| 场景 | 推荐 |
|------|------|
| 需要多个图层 / 对象选择 / 用户可编辑后再导出 | fabric.js(adjust / multiAngle 已用) |
| 单次像素变换(crop / rotate / flip) | 原生 Canvas(轻量) |
| 笔画涂鸦 / 自由绘制 | fabric.js 或 konva,根据 overlay 组件选 |
| N 张图拼接输出(stitch) | 原生 Canvas drawImage |
| 切片(gridSlice) | 原生 Canvas drawImage(每片一次) |

### C. ReactFlow group 使用方式

**现状**:**主画布已完整实现 group + 打组/解组**(`packages/web/src/apps/project/components/canvas/common/GroupToolbarPanel.tsx`),包括:
- 打组 `handleGroup()`:选 2+ 节点 → 一次 `setNodes([groupNode, ...childNodes.reparented, ...rest])` 原子写入。因为 `useCanvasActions.setNodes` 内部用 `doc.transact + userOrigin`,自动进入 UndoManager 历史
- 解组 `handleUngroup()`:1 个 group 选中 → 从子节点删 `parentId` / `extent`,坐标从 local 转回 absolute
- 嵌套 group、locked group(不可选)、拖入拖出 group 自动更新 parentId(`canvas/index.tsx:495-520`)、group 复制粘贴的坐标处理(`NodeContextMenu.tsx`)

**Mixed editor 现状**:
- Yjs schema 支持:`type:'group'` + `parentId`(`useMixedEditorYjsInternal.ts:19, 67, 92`)
- 底层 action 支持:`setNodes` / `updateNode` 带 history options
- **缺**:UI 层打组/解组入口(GroupToolbarPanel 等价物)

**multi-output 工具的 group 约定**:
- group 节点:`type:'group'`, `data: { collapsed:false, backgroundColor, name: "Cut Result" | "Grid Slices" | ... }`,和用户手动打组的 group **完全等价**
- 子节点:按正常 image/video 节点类型(2002/2003),加上 `parentId = group.id`,`position` 是 group 内的 local 坐标
- 子节点**不锁死**:`extent` 不设置,用户可以拖出 group 或手动解组。新 API `createGroupWithChildren` 内部逻辑 ≈ `GroupToolbarPanel.handleGroup` + 预设的 children + childState 注入

**Undo 语义**:
- 打组 / 解组 / multi-output 创建,都是**单次 `setNodes`** → 单个 undo 步骤
- 用户 Ctrl+Z 后:打组操作撤销 → 子节点回到 group 外,group 消失
- 同理 redo

### D. 常见陷阱

1. **不要直接 updateNodeData 写 content=dataURL**。必须先上传得到持久 URL。Yjs 不适合承载大 payload。
2. **不要在 Type A 流程里混入 `triggerBackendMiniTool`**。如果确实需要后端 AIGC(如 graffiti),走模板 ② 的"本地占位 → 升级 handling → 后端"路径。
3. **X pattern 的 resolve 只写一次 Yjs**。不要在 resolve 前多次 updateNodeData 试图"更新占位"——占位本来就在本地,Yjs 还没这个节点。
4. **失败 toast + removeLocalPendingNode 的顺序**:先 `failLocalPendingNode`,后 toast。toast 统一走屏幕顶部位置(产品规定)。
5. **Type B 的 placeholder 尺寸(expectedSize)**:如果后端返回的结果尺寸和预期不一致(如 crop 后尺寸变了),Yjs observer 负责 refinement。前端 placeholder 给**预期尺寸**即可,不要给 0 × 0 或源尺寸。
6. **模板 ④ 的 group 子节点级联删除**:产品规则"handling 不能删"对 **子节点**有效。如果子节点全部 handling,用户点击 group 删除时要同时判断:group 可删 = 所有子节点都 idle。这条要在 UI 删除 handler 里加。
