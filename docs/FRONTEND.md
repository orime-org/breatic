# Frontend Architecture

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5.6 |
| Build | Vite 5.2 |
| Canvas | @xyflow/react v12 (ReactFlow) |
| Collaboration | Yjs + @hocuspocus/provider (no offline — requires network for AIGC) |
| State | Redux Toolkit + Zustand |
| Audio | WaveSurfer.js |
| Video | Video.js |
| 3D | Three.js + @react-three/fiber |
| UI | Headless UI + Tailwind CSS 3.4 |
| Data Fetching | Axios + @microsoft/fetch-event-source (SSE) + React Query |
| i18n | i18next + browser language detection |
| Routing | React Router v7 |
| Monitoring | Sentry |
| Auth | @react-oauth/google |
| Types | @breatic/shared (workspace dependency) |

## Directory Structure

The web package is organized in layers, with strict bottom-up dependency direction:
`ui ← data ← domain ← features ← spaces ← pages ← app`. Lower layers don't import higher ones.

```
packages/web/src/
├── index.tsx                       # Root: Redux + Router + Sentry
├── App.tsx                         # App shell
│
├── ui/                             # Stateless primitives (HeadlessUI + tokens)
│   ├── button/ checkbox/ dialog/ dropdown/ icon/ input/
│   ├── popover/ select/ slider/ switch/ tabs/ textArea/
│   ├── tooltip/ upload/ ...        #   ~22 subdirs, no business logic
│
├── data/                           # IO layer (no business semantics)
│   ├── yjs/                        #   manager / canvas-space / project-meta /
│   │                               #   history / use-socket
│   ├── api/                        #   axios clients per resource:
│   │                               #   auth / projects / chat / canvas /
│   │                               #   mini-tools / models / payment / assets /
│   │                               #   project-members / project-spaces / users
│   │                               #   + request.ts (axios) + token.ts
│   ├── stream/                     #   sse.ts (SSE for Agent chat / text mini-tool)
│   └── storage/                    #   oss-client.ts / upload-blob.ts
│
├── domain/                         # Business hooks (compose data + state)
│   ├── space/                      #   useProjectSpaces (yjs orchestrator)
│   │                               #   useProjectMeta · useSpaceManagerPool ·
│   │                               #   useTabState · ActiveCanvasSpaceContext
│   ├── project/                    #   useProjectMembers
│   └── user/                       #   useUsers · useUserRole
│
├── apps/                           # (transitional — being decomposed into pages/, spaces/, features/)
│   ├── project/                    #   Main project page (canvas + chat)
│   ├── workspace/                  #   Project list (will become /studio in PR8)
│   ├── userCenter/                 #   User account
│   ├── auth/                       #   Login / register
│   └── videoEditor/                #   Video editor (will move to spaces/timeline/ in PR7)
│
├── components/                     # (transitional — most have moved to ui/)
│   ├── base/agent/                 #   Chat business components (will move to features/chat/ in PR5)
│   ├── loading/ themeProvider/ modals/ lottiePlayer/
│
├── hooks/                          # (transitional — canvas-specific hooks pending PR6 move)
│   ├── useCanvasActions.ts         #   Canvas write operations → Yjs
│   ├── useCanvasUI.ts              #   Redux UI state (panels / comment mode)
│   ├── useCanvasYjsInternal.ts     #   Yjs observe → CanvasDataContext bridge
│   ├── useCanvasSpace.ts           #   Active canvas Space accessor
│   ├── useNodeData.ts              #   Node data accessor
│   ├── useUpstreamExternalFileList.ts
│   ├── useUserCenterStore.ts       #   Redux auth slice accessor
│   ├── useLoading.ts               #   Global loading state
│   └── useProjectStore.ts useVideoEditorStore.ts
│
├── contexts/                       # (transitional)
│   ├── CanvasDataContext.tsx       #   nodes/edges (read cache) + toasts
│   └── LocalPendingProvider.tsx    #   pre-Yjs placeholder nodes (pickState etc.)
│
├── store/
│   ├── index.ts                    # Redux store config
│   └── modules/
│       ├── canvas.ts               #   Canvas UI state (panels, comment mode — NO nodes/edges)
│       ├── userCenter.ts           #   Auth & user info
│       ├── projectInfo.ts          #   Auto-save timestamp
│       └── loading.ts              #   Global loading counter
│
├── router/index.tsx                # React Router v7 (lazy-loaded)
├── i18n/                           # i18next config
├── locales/{en,ja,zh-CN,zh-TW}/    # Translation JSON files
├── theme/                          # tailwind-vars.ts + light.css + dark.css
│                                   #   (CSS variables: brand/neutral scales,
│                                   #    rounded, text-scale, semantic colors)
├── styles/                         # Global CSS
└── utils/                          # Pure helpers
    ├── classnames.ts sanitize.ts mediaUtils.ts websocket.ts common.ts
    └── videoEditor/                # Video editor utilities (moves with timeline)
```

> Files marked **transitional** are being progressively migrated into the
> layered structure (`features/`, `spaces/`, `pages/`). The end state has
> `apps/`, `components/base/`, `hooks/` and `contexts/` collapsed entirely
> into the layered tree.

## Naming Conventions

| File type | Convention | Example |
|---|---|---|
| React component (`.tsx`) | `PascalCase` (= export name) | `Button.tsx` `ProjectMembersPanel.tsx` |
| React hook (`.ts/.tsx`) | `useFooBar` (= export name) | `useProjectSpaces.ts` `useCanvasActions.ts` |
| Other (`.ts` — util, data, config, store) | `kebab-case` | `mini-tools.ts` `oss-client.ts` |
| Test | Same name as source + `.test` | `useProjectSpaces.test.ts` |
| Directory | `kebab-case` | `data/yjs/` `domain/space/` `features/project-members/` |

## Two Zones (Agent / Canvas)

项目页面分为两个主要功能区域，各自有不同的 AI 能力和数据源：

| 区域 | 位置 | AI 能力 | 数据源 |
|------|------|---------|--------|
| **Agent 区** | 右侧聊天面板 | 多轮对话，注入三层记忆 + 压缩历史，SubAgent 可 spawn | Conversation（SSE 流式） |
| **Canvas 区** | 中央画布 | 节点级 AIGC 生成（Worker 单次执行），Mini-Tool 快捷操作 | Yjs `nodesMap` / `edgesMap` |

- Agent 区和 Canvas 区的数据**独立**——聊天消息在 Conversation 表，画布状态在 Yjs。Agent 可以通过 spawn tool 触发 Canvas 节点的 AIGC 任务
- 所有图片/视频/音频操作均在主画布上完成（canvas-native）；不再有独立的 Launch Editor 子画布
- 文本节点有独立的 TipTap 富文本编辑器（左侧全屏面板），使用主画布 Yjs 文档中该节点的 `data.prompt` Y.XmlFragment
- 视频节点的剪辑编辑器（剪映/PR 风格时间线）计划支持，目前在设计中
- Skill 系统边界：Agent（scope: agent）| Canvas（scope: canvas）。文本编辑器不使用 Skill。

## Canvas Implementation

**Tech**: @xyflow/react v12 + custom node types

### Node Types

| Type ID | Name | Content 渲染 |
|---------|------|-------------|
| `1001` | Text | 文本预览 |
| `1002` | Image | `<img>` lazy loading |
| `1003` | Video | `<video>` + `cover_url` 封面 |
| `1004` | Audio | WaveSurfer 波形 |
| `group` | Group | 容器，组织子节点 |

### Node Card Structure

每个 Canvas 节点 Card 的组成：

```
┌─────────────────────────────────┐
│  Header: name + type icon       │  ← 显示名称，点击可编辑
│  ─────────────────────────────  │
│  Content area:                  │  ← 根据 type 渲染（见 Node Types 表）
│    idle → 显示已有内容            │
│    handling → spinner + actor   │
│  ─────────────────────────────  │
│  Prompt: TipTap rich text       │  ← Y.XmlFragment，聚焦时创建编辑器实例
│    @ mentions → attachments     │     非聚焦 → generateHTML() 静态预览
│  ─────────────────────────────  │
│  Attachments toolbar            │  ← 文件上传池（presign → 直传 → Y.Array）
│  Params bar (model, size, etc.) │  ← 生成参数（Y.Map）
│  ─────────────────────────────  │
│  [Generate] button              │  ← 触发 AIGC → state: handling
└─────────────────────────────────┘
   ↕ handles (source/target)        ← 上下游节点连接
```

### Node Data Attribution

各属性的数据层归属：

| 属性 | 存储层 | 写入方 | 说明 |
|------|--------|--------|------|
| `name` | Yjs `data` Y.Map | 前端 | 显示标签 |
| `state` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | `idle` / `handling` |
| `handlingBy` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 触发者 `{ userId, username }` |
| `content` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 生成结果 URL 或文本 |
| `cover_url` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 视频封面 |
| `errorMessage` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 失败时设置；state 保持 idle |
| `width` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 输出宽度（像素） |
| `height` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 输出高度（像素） |
| `duration` | Yjs `data` Y.Map | Collab（NodeStateUpdateEvent） | 音频/视频时长（秒） |
| `sourceNodeId` | Yjs `data` Y.Map | 前端 | 派生节点的来源节点 ID |
| `operation` | Yjs `data` Y.Map | 前端 | mini-tool 操作名 |
| `operationParams` | Yjs `data` Y.Map (Y.Map) | 前端 | 操作专用参数 |
| `prompt` | Yjs `data` Y.Map (Y.XmlFragment) | 前端 | TipTap 绑定，每用户同时只编辑 1 个节点 |
| `model` | Yjs `data` Y.Map | 前端 | 选定的 AI 模型 ID |
| `modelParams` | Yjs `data` Y.Map (Y.Map) | 前端 | 生成参数（尺寸等） |
| `attachments` | Yjs `data` Y.Map (Y.Array) | 前端 | 上传池，prompt 里 @ mention 引用 |
| `childIds` | Yjs `data` Y.Map (Y.Array) | 前端 | N 输出操作的子节点 ID 列表 |
| `localPending` | LocalPendingProvider (React context) | 前端 | 预创建节点尚未写入 Yjs，UI-only |
| `pickState` | React local state | 前端 | 图片拾取模式，UI-only |
| `handles` | React local state | 前端 | 连接点元数据，UI-only |

> 前端**不写** `state` / `handlingBy` / `content` / `cover_url` / `errorMessage` / `width` / `height` / `duration`。
> 后端**不写** `name` / `prompt` / `attachments` / `modelParams` / `position`。

### Features

- Infinite panning & zooming (react-infinite-viewer)
- Custom animated edges
- Node context menus (right-click)
- Group nodes with hierarchy & lock support
- Undo/redo via Yjs UndoManager
- Multi-select via Selecto
- Connection preview (temporary anchor while connecting)
- Keyboard shortcuts (Ctrl+Z/Y, Delete, Ctrl+C/V)
- Node result display (images, videos, audio waveforms)
- Auto-layout for grouped nodes
- Right panel state management (open, panelType, nodeId)
- Resource input request handling

## Yjs Integration (Real-time Collaboration)

> **Canonical structure spec**: [docs/YJS.md](./YJS.md) — authoritative
> reference for the canvas Map-of-Maps structure, field ownership,
> the idle/handling state machine, and the backend event flow. Read
> that first if you're wiring a new Yjs interaction.

### Architecture

v10 multi-doc layout — each project owns one meta doc plus one doc per Space:

```
project-{pid}/meta              ←  spaces list, per-user tab state, project meta
project-{pid}/canvas-{spaceId}  ←  one per canvas Space (nodesMap + edges)
project-{pid}/document-{spaceId} ←  future (TipTap)
project-{pid}/timeline-{spaceId} ←  future (剪映-style timeline)
```

All docs for a single project share **one** Hocuspocus websocket
(spec §5.3.3). Canvas Space docs are kept alive in an LRU pool (default
size 5), so switching tabs doesn't reconnect.

```
data/yjs/manager.ts            → Base: Y.Doc + @hocuspocus/provider, with explicit
                                  attach() when sharing a websocket
data/yjs/project-meta.ts       → Project meta doc (spaces / userStates / awareness)
data/yjs/canvas-space.ts       → Canvas Space doc (nodesMap + edges + UndoManager)
data/yjs/use-socket.ts         → Shared HocuspocusProviderWebsocket per project
                                  (useMemo-built, available on first render)
domain/space/useProjectSpaces  → Project-level orchestrator: ws + meta + pool
domain/space/useProjectMeta    → React subscription to meta.spaces
domain/space/useSpaceManagerPool → LRU canvas-{spaceId} doc pool
domain/space/ActiveCanvasSpaceContext → Active canvas Space manager (replaces
                                  the old module-level `canvasYjsRef`)
contexts/CanvasDataContext     → Read cache: yjsNodes + toasts → ReactFlow
hooks/useCanvasYjsInternal     → Yjs observe → CanvasDataContext bridge
hooks/useCanvasActions         → Write ops → Yjs (nodesMap.set, etc.)
hooks/useCanvasUI              → Redux UI-only state (rightPanel, commentMode)
```

> **Default Space seeding**: when `POST /projects` runs, the server
> writes a precomputed initial Yjs update for `project-{pid}/meta`
> directly into `yjs_documents` inside the same transaction. So the
> first time a client connects to a freshly-created project's meta
> doc, `meta.spaces` already contains a default Canvas Space — no
> client-side bootstrap effect needed. See `core/db/yjs-bootstrap.ts`
> for the only place outside the collab process that writes
> `yjs_documents.data` directly (safe because no client can be
> connected before the creating transaction commits).

### Yjs / Redux / ReactFlow 三者关系

| 层 | 角色 | 职责 |
|---|------|------|
| **Yjs** | 数据源（Source of Truth） | 持有 nodes/edges 的真实数据，负责协作同步、持久化、undo/redo |
| **CanvasDataContext** | 只读缓存（Read Cache） | yjsNodes + localOverlay 合并后给 ReactFlow |
| **Redux** | 纯 UI 状态 | workflowId, rightPanel, commentMode 等——不含 nodes/edges |
| **ReactFlow** | 渲染层 | 从 Context 读取 nodes/edges，用户交互交给 useCanvasActions |

数据绝不反向流动：Context → Yjs 方向不存在写入。

### Data Flow

```
写入路径：
  User action → useCanvasActions → Yjs nodesMap.set(...)
                                        ↓
读取路径（增量 observe）：
  nodesMap.observeDeep → getAffectedNodeIds(events)
    → 只重建受影响的节点，未变化的复用旧引用（O(affected)）
    → setYjsNodes → useMemo merge with localOverlay → ReactFlow

初始同步兜底：
  doc.on('update') → 检测 nodesMap 实例是否变化（CRDT 僵尸修复）
    → 变化则重新订阅 observeDeep → 全量读取一次
```

**Sync-first 架构**：产品需要网络才能使用 AIGC，不支持离线编辑。
因此去掉了 IndexedDB 缓存，只有 Hocuspocus 服务器一个数据源。
打开项目时显示 loading，等 WebSocket 同步完成后才初始化
nodesMap/edgesMap/UndoManager 并渲染画布。这消除了所有
缓存/同步竞争条件和 CRDT 僵尸引用问题。

**两层状态分离**：`yjsNodes`（Yjs 数据）和 `localOverlay`（ReactFlow
select/dimensions）分开存储，`useMemo` 合并。两条路径互不干扰，
没有竞争。

**增量 observe**：`observeDeep` 事件直接提供受影响的节点 ID，
只重建那几个节点。未受影响的节点复用旧对象引用，ReactFlow
跳过重渲染。支持 1000+ 节点。

### Canvas Space Yjs Structure

The canvas Space doc (`project-{pid}/canvas-{spaceId}`) has nodesMap +
edges at the **top level** — no `canvas:` wrapper map. The wrapper layer
existed pre-v10 when one doc held all spaces; the multi-doc split made
it redundant.

```
project-{pid}/canvas-{spaceId} (Y.Doc)
  ├── nodesMap: Y.Map<nodeId, Y.Map>   ← each node is an independent Y.Map
  └── edges:    Y.Map<edgeId, Y.Map>

Each node Y.Map:
  ├── id:       string                  ← top level
  ├── type:     string                  ← top level
  ├── position: Y.Map { x, y }         ← top level
  └── data:     Y.Map                   ← nested, matches ReactFlow node.data
        ├── name, state, handlingBy, content, cover_url, errorMessage
        ├── width, height, duration
        ├── sourceNodeId, operation, operationParams
        ├── model, modelParams
        ├── attachments:  Y.Array<Y.Map>
        ├── childIds:     Y.Array<string>
        └── prompt:       Y.XmlFragment (TipTap binding)
```

The project meta doc (`project-{pid}/meta`) holds:

```
project-{pid}/meta (Y.Doc)
  ├── projectMeta: Y.Map<string, unknown>   ← name / description
  ├── spaces:      Y.Map<spaceId, Y.Map>    ← Tab Bar source of truth
  │     each entry: { id, type, name, order, locked, createdAt, createdBy }
  └── userStates:  Y.Map<userId, Y.Map>     ← per-user tab state (active spaceId etc.)
```

The nested `data` Y.Map mirrors ReactFlow's `node.data` shape, so
`yMapToNode()` is a direct structural mapping with no field
reshuffling. Editing one node's data field is a single Yjs op — no
whole-array replacement, no collateral impact on other nodes.

Concurrency is handled by the canvas-native operation model: each
operation produces new sibling result nodes rather than overwriting
the source node. No per-node Redis lock exists. See
[YJS.md section 7](./YJS.md#7-concurrency--no-per-node-lock).

### Undo/Redo

Two independent scopes, `captureTimeout: 500ms`, max stack depth 50:

| Scope | Tracks | Not tracked | Lifetime |
|-------|--------|-------------|----------|
| Canvas undo | create/delete node, move, rename, create/delete edge | prompt, attachments, params, backend writes | Entire canvas session |
| Prompt undo | One node's Y.XmlFragment (TipTap internal) | canvas topology | Focus → blur, then destroyed |

Canvas UndoManager scoped to nodesMap + edgesMap, per-user origin
`trackedOrigins: ['canvas-user:${userId}']` — 协作者不会互相撤销。
Prompt/attachment/params writes use `noHistoryOrigin` to avoid polluting canvas undo stack.

### Toast Notifications

AIGC 生成完成时弹出 toast（右下角堆叠，5s 自动消失，点击跳转节点，
`role="status" aria-live="polite"`）。前端通过观察节点 `data.state`
回到 `"idle"` 时判断完成；若 `data.errorMessage` 非空则为失败 toast。

### Sync Timeout

HocuspocusProvider 配置 `timeout: 10000`，React 层 15 秒兜底。
超时后设置 `syncError` 状态，CanvasDataContext 暴露给 UI 显示错误。

### CanvasDataContext

```ts
interface CanvasDataContextValue {
  nodes: Node[];
  edges: Edge[];
  nodesById: Map<string, Node>;  // O(1) 节点查找
  loading: boolean;
  syncError: string | null;
  toasts: CanvasToast[];
  dismissToast: (id: string) => void;
  applyLocalNodeChanges: (changes: NodeChange[]) => void;
}
```

## Canvas-Native Interaction Model

All media operations (image, video, audio) happen directly on the
main canvas — there is no separate Launch Editor sub-canvas.

### Two node categories

| Category | Behaviour |
|----------|-----------|
| **Generative nodes** | User writes a prompt + selects a model → `[Generate]` button → backend AIGC task → new result sibling node |
| **Data nodes** | Already hold a result asset; mini-tools (crop, adjust, remove-bg, etc.) produce new sibling result nodes connected by edge |

### Operation pattern

1. User selects a source data node and chooses a mini-tool operation
2. Frontend creates N placeholder result nodes on the canvas (with `localPending: true`)
3. API call is made; backend task runs
4. Worker emits `NodeStateUpdateEvent` per result node ID
5. Collab writes the result into each node's `data` Y.Map
6. `localPending` is cleared; the result nodes become normal Yjs nodes

Source nodes are **never mutated** by mini-tool operations. Each
operation is a new branch on the canvas graph, making the full
operation history visible as node topology.

### useCanvasActions

```ts
// Key write operations available to UI components
const {
  createDataNode,        // create a new data node
  createGenerativeNode,  // create a new generative node
  createEdge,            // connect two nodes
  deleteNodeAndEdges,    // remove a node + all its edges
  setNodeState,          // optimistic state update (frontend use only)
} = useCanvasActions();
```

### Text editor

Text nodes (type `1001`) open a full-screen TipTap editor in the
left panel. The editor binds to `data.prompt` (Y.XmlFragment) of
the selected text node — no separate Yjs document is created.

### Video editor (planned)

A timeline-style video editor entry point on video nodes is planned
(剪映/PR-style). It will be specified separately when implementation
begins.

### Redux state changes

The `imageEditor` Redux slice (previously tracking sub-canvas nodes,
edges, activeTool) is no longer used for canvas-level operations.
All canvas node data lives in Yjs via `CanvasDataContext`.

## AI Chat Panel

**Location**: `apps/project/components/agent/`

### Components

- **AiChatRecordPanel** — Message list + composer, per-node chat history
- **NodeChatComposer** — Text input + resource upload + upstream node injection
- **AgentInput/Message/ModelSelect/SendButton/ComposerTabs** — Base agent UI in `components/base/agent/`

### Features

- SSE streaming for AI responses (via `chat.sendMessage`)
- Skill command execution (via `chat.sendSkillCommand`)
- Node output injection as chat context (upstream selector)
- Resource upload with preview (images, audio, video)
- Model selector for AI provider
- Per-node scoped conversation history

## API Layer

### Architecture


Frontend imports types and Zod schemas from `@breatic/shared` — single source of truth for API contracts. New API files are domain-based, aligned with backend routes.


### HTTP (Axios)

- Base URL: none — call sites write the full `/api/v1/...` path and axios sends it relative to `window.location.origin`
- Timeout: 180s
- Auto Bearer token injection (via `token.ts`)
- 401 → logout + redirect
- Optional global loading spinner

### SSE (fetch-event-source)

- Wrapper for server-sent events
- JSON body support
- Auth header injection
- Ping event filtering
- Error/close lifecycle handling

### API Files (aligned with backend `/api/v1/*`)

```
data/api/
├── auth.ts                # register / login / logout / getMe
├── projects.ts            # list / create / update / remove / duplicate
├── project-members.ts     # list / add / update role / remove
├── project-spaces.ts      # POST / DELETE Space
├── chat.ts                # sendMessage(SSE) / sendSkillCommand(SSE) / conversations
├── canvas.ts              # createTask / understand / listTasks / getTask
├── mini-tools.ts          # executeImage / Video / Audio / Text(SSE)
├── models.ts              # getAll (model catalog)
├── payment.ts             # getTiers / createCheckout / getHistory
├── assets.ts              # presign / uploadToPresignedUrl / reportHistory
├── users.ts               # batch GET (avatars, names)
├── legacy-oss-stub.ts     # OSS upload stubs for the standalone /video_editor route
├── request.ts             # axios instance + interceptors + auth token
├── token.ts               # localStorage persistence
└── index.ts               # barrel export
```

## State Management

### Redux Slices (5 slices)

| Slice | File | Content |
|-------|------|---------|
| `canvas` | `canvas.ts` | **UI-only**: workflowId, rightPanel, overlayPanel, commentMode, nodeTemplateData |
| `imageEditor` | `imageEditor.ts` | Legacy — was used for image editor sub-canvas; no longer active for canvas-native operations |
| `userCenter` | `userCenter.ts` | Auth state, user info |
| `projectInfo` | `projectInfo.ts` | Auto-save timestamp |
| `loading` | `loading.ts` | Global loading counter |

> Canvas `nodes`/`edges` 不在 Redux 里——它们在 `CanvasDataContext`（来自 Yjs observe）。

### Auth hydration at store init

`userCenter.ts` 的 `initialState` 通过 `loadInitialAuthInfo()` 在**模块导入时同步**
读取 `localStorage.auth`，而不是在某个组件的 `useEffect` 里做。这保证任何路由
（包括 `/project/<id>` 这种深链）首次 render 就能拿到持久化的 session token。

历史坑：旧实现把水合写在 `Workspace`（`/`）的 `useEffect` 里，深链直接进入项目
页时 Redux 的 token 保持为空字符串，继而让 `useProjectSpaces` 的 `enabled` 判空失败，
manager 从未创建，`addNode` 静默早返回——从用户视角就是"点击添加节点无反应"。
把水合下沉到 reducer 层，结构性地消除了这类耦合。

### Three Hooks

| Hook | 读/写 | 数据源 | 用途 |
|------|-------|--------|------|
| `useCanvasData()` | 读 | CanvasDataContext | nodes, edges, toasts |
| `useCanvasActions()` | 写 | Yjs | addNode, updateNode, onNodesChange, undo/redo |
| `useCanvasUI()` | 读写 | Redux | rightPanel, commentMode, workflowId 等 |

## i18n

- **Framework**: i18next + react-i18next
- **Detection**: localStorage → browser language
- **Locales**: en, ja, zh-CN, zh-TW
- **Resources**: JSON files per module (base, project, workspace, usercenter)

## Environment Variables

All `VITE_*` variables are in the root `.env` file (shared with backend). Vite reads from root via `envDir` config.

| Variable | Purpose |
|----------|---------|
| `VITE_LOGIN_MODE` | Login mode (must match backend) |
| `VITE_APP_VERSION` | App version string |
| `GOOGLE_CLIENT_ID` | Google OAuth — injected via Vite `define` as `__GOOGLE_CLIENT_ID__` (optional) |
| `VITE_SENTRY_DSN` | Sentry error tracking (optional) |

### Why there's no `VITE_API_URL` / `VITE_WS_URL`

The frontend talks to the backend over **relative URLs** (`/api/*`, `/ws`, `/uploads/*`). The browser resolves these against `window.location`, so:

- The built bundle has **no host baked in** — the same `dist/` works on `localhost:8000`, `staging.example.com`, `breatic.ai`, or any preview URL.
- Dev mode relies on Vite's `server.proxy` (in `vite.config.ts`) to forward `/api` → `localhost:3000` and `/ws` → `localhost:1234`. From the browser's view it's single-origin on `localhost:8000`.
- Production relies on nginx (in the `web` Docker container) to reverse-proxy the same routes to the API/Collab containers. Same single-origin model.
- WebSocket URLs can't be purely relative (the `new WebSocket()` constructor requires a full URL), so `data/yjs/use-socket.ts` (the shared Hocuspocus websocket) and `utils/websocket.ts` (the misc ws helper) build them at runtime from `window.location.protocol` + `window.location.host`.

The upshot: changing deployment domains requires zero frontend rebuild; the only constraint is that frontend and backend must share one reverse proxy, which they always do in breatic's architecture.

---

## Issues to Address

### 1. Component Migration to New APIs (In Progress)

13 components still reference old API files (`projectApi.ts`, `userCenterApi.ts`, `workspaceApi.ts`). Should be migrated to new domain-based APIs (`auth.ts`, `projects.ts`, etc.) incrementally.

### Resolved

- ~~API Endpoint Mismatch~~ — New API files created, aligned with `/api/v1/*`
- ~~No @breatic/shared Integration~~ — Frontend now imports from `@breatic/shared`
- ~~Duplicate i18n System~~ — Unified to root `locales/*.json`, shared by frontend and backend
- ~~State Management Complexity~~ — Clarified: canvas state is Yjs-first with Redux as read cache
- ~~Direct OSS Upload~~ — Replaced with presigned URL flow (`GET /assets/presign` → direct PUT). `ossClient.ts` and `pendingFileStore.ts` removed
- ~~Auth Integration~~ — Login page (email/password + Google OAuth + password reset) wired to `/api/v1/auth`. UserCenter fetches real user info from `/auth/me`. Google OAuth uses `__GOOGLE_CLIENT_ID__` global constant (not `import.meta.env`). axios 401 interceptor loop fixed
