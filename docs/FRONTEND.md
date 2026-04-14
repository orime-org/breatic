# Frontend Architecture

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5.6 |
| Build | Vite 5.2 |
| Canvas | @xyflow/react v12 (ReactFlow) |
| Collaboration | Yjs + y-websocket + y-indexeddb |
| State | Redux Toolkit + Zustand |
| Image Editor | Fabric.js (@erase2d/fabric) + react-image-crop + Excalidraw |
| Audio | WaveSurfer.js |
| Video | Video.js + FFmpeg WASM |
| 3D | Three.js + @react-three/fiber |
| UI | Headless UI + Tailwind CSS 3.4 |
| Data Fetching | Axios + @microsoft/fetch-event-source (SSE) + React Query |
| i18n | i18next + browser language detection |
| Routing | React Router v7 |
| Monitoring | Sentry |
| Auth | @react-oauth/google |
| Types | @breatic/shared (workspace dependency) |

## Directory Structure

```
packages/web/src/
├── index.tsx                    # Root: Redux + Router + Sentry
├── App.tsx                      # App shell
├── apps/                        # Page-level components
│   ├── project/                 # Main canvas editor
│   │   ├── components/
│   │   │   ├── canvas/          #   Infinite canvas (ReactFlow)
│   │   │   ├── imageEditor/     #   Image editing flow (Fabric.js)
│   │   │   └── agent/           #   AI chat panel
│   │   └── constants/           #   Icon maps, aspect ratios
│   ├── workspace/               # Project list, login, language
│   └── userCenter/              # Account, purchase, upgrade
├── components/
│   ├── base/                    # Reusable UI (agent, button, input, select, slider, etc.)
│   ├── loading/                 # Global loading overlay
│   ├── modals/                  # Confirm, text input, modal
│   ├── themeProvider/           # Dark/light theme
│   └── lottiePlayer/            # Lottie animation
├── store/
│   ├── index.ts                 # Redux store config
│   └── modules/
│       ├── canvas.ts            #   Canvas state (nodes, edges, newResultsFlag, panels)
│       ├── imageEditor.ts       #   Image editor state (nodes, edges, activeTool)
│       ├── userCenter.ts        #   Auth & user info
│       ├── projectInfo.ts       #   Auto-save timestamp
│       └── loading.ts           #   Global loading counter
├── hooks/
│   ├── useProjectStore.ts       # Canvas graph state accessor (writes to Yjs)
│   ├── useCanvasYjs.ts          # Yjs → Redux bridge (incremental observe)
│   ├── useYjsProjectStore.ts    # Yjs lifecycle (connect/disconnect/sync)
│   ├── useImageEditorStore.ts   # Image editor state accessor
│   ├── useUserCenterStore.ts    # User/auth state accessor
│   ├── useNodeData.ts           # Node data accessor
│   ├── useLoading.ts            # Global loading state
│   └── useUpstreamExternalFileList.ts  # Upstream node file references
├── apis/
│   ├── auth.ts                  # register, login, logout, getMe
│   ├── projects.ts              # list, create, update, remove
│   ├── chat.ts                  # sendMessage(SSE), sendSkillCommand(SSE), conversations
│   ├── canvas.ts                # createTask, understand, listTasks
│   ├── miniTools.ts             # executeImage, executeVideo, executeAudio, executeText(SSE)
│   ├── models.ts                # getAll (model catalog)
│   ├── payment.ts               # getTiers, createCheckout, getHistory
│   ├── assets.ts                # presign, uploadToPresignedUrl, reportHistory
│   ├── index.ts                 # barrel export
│   ├── projectApi.ts            # LEGACY — /api/workflow/* (pending migration)
│   ├── userCenterApi.ts         # LEGACY — /api/auth/*, /api/stripe/* (pending migration)
│   └── workspaceApi.ts          # LEGACY — /api/workflow/base/* (pending migration)
├── utils/
│   ├── yjsManager.ts            # Base Yjs doc + awareness + subdocs
│   ├── yjsProjectManager.ts     # Project Yjs: nodesMap/edgesMap Y.Map + UndoManager
│   ├── canvasYjsRef.ts          # Module-level ref to active Yjs manager
│   ├── request.ts               # Axios interceptors + auth token
│   ├── sse.ts                   # SSE stream helper
│   ├── token.ts                 # Auth token persistence (localStorage)
│   ├── websocket.ts             # WebSocket connection management
│   ├── mediaUtils.ts            # Image/audio/video utilities
│   └── common.ts                # Misc utilities
├── router/index.tsx             # React Router v7 (lazy-loaded)
├── i18n/index.ts                # i18next config
├── locales/{en,ja,zh-CN,zh-TW}/ # Translation JSON files
├── theme/                       # CSS custom properties (dark/light)
└── styles/                      # Global CSS
```

## Three Zones (Agent / Canvas / Editor)

项目页面分为三个功能区域，各自有不同的 AI 能力和数据源：

| 区域 | 位置 | AI 能力 | 数据源 |
|------|------|---------|--------|
| **Agent 区** | 右侧聊天面板 | 多轮对话，注入三层记忆 + 压缩历史，SubAgent 可 spawn | Conversation（SSE 流式） |
| **Canvas 区** | 中央画布 | 节点级 AIGC 生成（Worker 单次执行），Mini-Tool 快捷操作 | Yjs `nodesMap` / `edgesMap` |
| **Editor 区** | 节点子画布（Launch Editor） | 无 Skill，纯编辑 | 独立 Yjs 文档 `project-{id}/node/{nodeId}` |

- Agent 区和 Canvas 区的数据**独立**——聊天消息在 Conversation 表，画布状态在 Yjs。Agent 可以通过 spawn tool 触发 Canvas 节点的 AIGC 任务
- Editor 区是 Canvas 节点的子画布，通过 `getCanvasYjsManager()` 只读访问父节点数据（如 attachments），Apply 操作写回父节点的 `data.content`
- Skill 系统的三区边界：Agent（scope: agent）| Canvas（scope: canvas）| Editor（不用 Skill）

## Canvas Implementation

**Tech**: @xyflow/react v12 + custom node types

### Node Types

| Type ID | Name | Content 渲染 |
|---------|------|-------------|
| `1001` | Text | 文本预览 |
| `1002` | Image | `<img>` lazy loading |
| `1003` | Video | `<video>` + coverUrl 封面 |
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
| `content` | Yjs `data` Y.Map | Collab（后端事件） | 生成结果 URL 或文本 |
| `coverUrl` | Yjs `data` Y.Map | Collab（后端事件） | 视频封面 |
| `state` | Yjs `data` Y.Map | Collab（后端事件） | `idle` / `handling` |
| `handlingBy` | Yjs `data` Y.Map | Collab（后端事件） | 触发者 `{ userId, username }` |
| `runType` | Yjs `data` Y.Map | 前端 | `parameter` / `sensitive` |
| `prompt` | Yjs `data` Y.Map (Y.XmlFragment) | 前端 | TipTap 绑定，每用户同时只编辑 1 个节点 |
| `attachments` | Yjs `data` Y.Map (Y.Array) | 前端 | 上传池，prompt 里 @ mention 引用 |
| `params` | Yjs `data` Y.Map (Y.Map) | 前端 | 生成参数（模型、尺寸等） |
| `pickState` | React local state | 前端 | 图片拾取模式，UI-only |
| `handles` | React local state | 前端 | 连接点元数据，UI-only |

> 前端**不写** `state` / `handlingBy` / `content` / `coverUrl`。
> 后端**不写** `name` / `prompt` / `attachments` / `params` / `position`。

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

```
yjsManager.ts          → Base: Y.Doc + IndexedDB + WebSocket + Awareness
yjsProjectManager.ts   → Project: nodesMap/edgesMap Y.Map + UndoManager
useCanvasYjs.ts         → Observe: Yjs → Redux (one-directional)
canvasYjsRef.ts         → Module-level manager ref for useProjectStore
```

### Data Flow (Yjs-first, incremental observe)

Write operations in `useProjectStore` go directly to Yjs. The
`useCanvasYjs` hook observes changes and syncs back to Redux for
ReactFlow rendering:

```
User action → Yjs nodesMap.get(id).get("data").set(field, value)
                        ↓
              observeDeep → getAffectedNodeIds(events)
                        ↓
              only rebuild changed nodes, reuse old refs for unchanged
                        ↓
              dispatch setNodes → ReactFlow renders from Redux
```

**Incremental observe**: instead of calling `readAllNodes()` on every
change, `useCanvasYjs` extracts affected node IDs from Yjs events
and only reconstructs those Node objects. Unchanged nodes keep their
old object reference, so React's `shallowEqual` skips re-renders.
This is critical for supporting 1000+ nodes.

Redux is a **read-through cache** — it holds nodes/edges for
ReactFlow to consume, but the source of truth is the Yjs document.
UI-only state (rightPanel, commentMode, etc.) stays in Redux and is
NOT synced to Yjs.

### Canvas Yjs Structure

```
canvas: Y.Map
  ├── nodesMap: Y.Map<nodeId, Y.Map>   ← each node is an independent Y.Map
  └── edges:    Y.Map<edgeId, Y.Map>

Each node Y.Map:
  ├── id:       string                  ← top level
  ├── type:     string                  ← top level
  ├── position: Y.Map { x, y }         ← top level
  └── data:     Y.Map                   ← nested, matches ReactFlow node.data
        ├── name, content, coverUrl, state, handlingBy, runType
        ├── params:       Y.Map<string, unknown>
        ├── attachments:  Y.Array<Y.Map>
        └── prompt:       Y.XmlFragment (TipTap binding)
```

The nested `data` Y.Map mirrors ReactFlow's `node.data` shape, so
`yMapToNode()` is a direct structural mapping with no field
reshuffling. Editing one node's data field is a single Yjs op — no
whole-array replacement, no collateral impact on other nodes.

Concurrency on node generation state is guarded by a **Redis lock**,
not Yjs merge semantics — see
[YJS.md section 7](./YJS.md#7-concurrency--the-canvas-node-lock).

### Undo/Redo

Two independent scopes:

| Scope | Tracks | Lifetime |
|-------|--------|----------|
| Canvas undo | nodesMap + edges (topology: create/delete/move/connect) | Entire canvas session |
| Prompt undo | One node's Y.XmlFragment (TipTap internal) | Focus → blur, then destroyed |

## Image Editor

**Tech**: @xyflow/react (nested flow) + Fabric.js + Excalidraw

### Tools

Crop, Brush, Erase, Fill, Bounding box, Text overlay, Inpaint, Multi-angle (3D), Stitch, Grid slice, Enhance (upscale), Expand (outpaint), Relight, Flip/Rotate, Adjust (exposure/color), Graffiti, Quick Edit

### Architecture

- Separate Yjs subdoc per image node
- Single Redux slice (`imageEditor.ts`) with nodes, edges, activeTool
- Yjs UndoManager with tracked origins
- Export to canvas as new node

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

- Base URL: `VITE_API_URL` (from root `.env`)
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

### New API Files (aligned with backend /api/v1/*)

```
apis/
├── auth.ts            # register, login, logout, getMe
├── projects.ts        # list, create, update, remove
├── chat.ts            # sendMessage(SSE), sendSkillCommand(SSE), conversations
├── canvas.ts          # createTask, understand, listTasks, getTask
├── miniTools.ts       # executeImage, executeVideo, executeAudio, executeText(SSE)
├── models.ts          # getAll (model catalog)
├── payment.ts         # getTiers, createCheckout, getHistory
├── assets.ts          # presign, uploadToPresignedUrl, reportHistory
└── index.ts           # barrel export
```

### Legacy API Files (pending migration)

Old files (`projectApi.ts`, `userCenterApi.ts`, `workspaceApi.ts`) still exist — 13 components reference them. Should be migrated to new APIs incrementally.


### Legacy API Files (pending migration)

3 old files still exist — 13 components reference them:
- `projectApi.ts` → migrate to `projects.ts` + `canvas.ts`
- `userCenterApi.ts` → migrate to `auth.ts` + `payment.ts`
- `workspaceApi.ts` → migrate to `projects.ts`

## State Management

### Redux Slices (5 slices)

| Slice | File | Yjs-synced | Content |
|-------|------|:---:|---------|
| `canvas` | `canvas.ts` | Yes | nodes, edges, newResultsFlag, right panel state, overlays |
| `imageEditor` | `imageEditor.ts` | Yes (subdoc) | nodes, edges, activeTool, expansions |
| `userCenter` | `userCenter.ts` | No | auth state, user info |
| `projectInfo` | `projectInfo.ts` | No | auto-save timestamp |
| `loading` | `loading.ts` | No | global loading counter |

### Patterns

- **Canvas state**: single `canvas.ts` slice holds `Node[]` + `Edge[]` + UI state (Redux is a read cache, not source of truth)
- **Yjs-first writes**: `useProjectStore` writes directly to Yjs; `useCanvasYjs` observeDeep syncs changes back to Redux
- **Incremental observe**: only changed nodes are rebuilt — unchanged nodes reuse old object refs for React shallow compare
- **Undo/redo**: Yjs UndoManager with tracked origins per editor mode

## i18n

- **Framework**: i18next + react-i18next
- **Detection**: localStorage → browser language
- **Locales**: en, ja, zh-CN, zh-TW
- **Resources**: JSON files per module (base, project, workspace, usercenter)

## Environment Variables

All `VITE_*` variables are in the root `.env` file (shared with backend). Vite reads from root via `envDir` config.

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | Backend API base URL |
| `VITE_WS_URL` | WebSocket server for Yjs sync |
| `VITE_BASE_URL` | Page navigation base URL |
| `VITE_LOGIN_MODE` | Login mode (must match backend) |
| `VITE_APP_VERSION` | App version string |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth (optional) |
| `VITE_SENTRY_DSN` | Sentry error tracking (optional) |

---

## Issues to Address

### 1. Component Migration to New APIs (In Progress)

13 components still reference old API files (`projectApi.ts`, `userCenterApi.ts`, `workspaceApi.ts`). Should be migrated to new domain-based APIs (`auth.ts`, `projects.ts`, etc.) incrementally.

### 2. Auth Integration

Google OAuth via `@react-oauth/google` needs to connect with backend's `/api/v1/auth` routes. Email+password auth flow needs to be wired up.

### Resolved

- ~~API Endpoint Mismatch~~ — New API files created, aligned with `/api/v1/*`
- ~~No @breatic/shared Integration~~ — Frontend now imports from `@breatic/shared`
- ~~Duplicate i18n System~~ — Unified to root `locales/*.json`, shared by frontend and backend
- ~~State Management Complexity~~ — Clarified: canvas state is Yjs-first with Redux as read cache
- ~~Direct OSS Upload~~ — Replaced with presigned URL flow (`GET /assets/presign` → direct PUT). `ossClient.ts` and `pendingFileStore.ts` removed
