# Frontend Architecture

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5.6 |
| Build | Vite 5.2 |
| Canvas | @xyflow/react v12 (ReactFlow) |
| Collaboration | Yjs + y-websocket + y-indexeddb + createYjsStoreSync |
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
│   ├── useProjectStore.ts       # Canvas graph state accessor
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
│   ├── assets.ts                # getUploadUrl, getOssSts, query
│   ├── index.ts                 # barrel export
│   ├── projectApi.ts            # LEGACY — /api/workflow/* (pending migration)
│   ├── userCenterApi.ts         # LEGACY — /api/auth/*, /api/stripe/* (pending migration)
│   └── workspaceApi.ts          # LEGACY — /api/workflow/base/* (pending migration)
├── utils/
│   ├── yjsManager.ts            # Base Yjs doc + awareness + subdocs
│   ├── yjsProjectManager.ts     # Project Yjs + UndoManager + snapshots
│   ├── yjsStoreSync.ts          # Generic Redux <-> Yjs bidirectional sync
│   ├── request.ts               # Axios interceptors + auth token
│   ├── sse.ts                   # SSE stream helper
│   ├── token.ts                 # Auth token persistence (localStorage)
│   ├── websocket.ts             # WebSocket connection management
│   ├── ossClient.ts             # Alibaba OSS client (legacy direct upload)
│   ├── pendingFileStore.ts      # File upload queue tracking
│   ├── mediaUtils.ts            # Image/audio/video utilities
│   └── common.ts                # Misc utilities
├── router/index.tsx             # React Router v7 (lazy-loaded)
├── i18n/index.ts                # i18next config
├── locales/{en,ja,zh-CN,zh-TW}/ # Translation JSON files
├── theme/                       # CSS custom properties (dark/light)
└── styles/                      # Global CSS
```

## Canvas Implementation

**Tech**: @xyflow/react v12 + custom node types

### Node Types

| Type ID | Name | Content |
|---------|------|---------|
| 1001 | Text | Text input/display |
| 1002 | Image | Image display + lazy loading |
| 1003 | Video | Video playback + timeline |
| 1004 | Audio | Waveform + playback |
| group | Group | Container for organizing sub-graphs |

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
> reference for canvas Y.Map shape, `CanvasNodeData` field ownership,
> the idle/handling state machine, and the backend event flow. Read
> that first if you're wiring a new Yjs interaction.

### Architecture

```
yjsManager.ts          → Base: Y.Doc + IndexedDB + WebSocket + Awareness
yjsProjectManager.ts   → Project: shared maps + UndoManager + snapshots
yjsStoreSync.ts         → Sync: createYjsStoreSync() — Redux <-> Yjs two-way
```

### createYjsStoreSync (replaces old yjs-redux binder)

```typescript
createYjsStoreSync<T>({
  doc: Y.Doc,
  mapName: string,
  getState: () => T,
  dispatch: (action) => void,
  toYjs: (state: T) => Record<string, unknown>,
  fromYjs: (map: Y.Map) => T,
  shouldDebounce?: boolean,
  debounceMs?: number,
})
```

Features:
- Bidirectional sync between Redux slices and Yjs Y.Map
- Debouncing support for high-frequency updates
- User origin tracking (prevents self-echo)
- Atomic sync guards to prevent circular updates

### Shared Yjs Data

| Key | Redux Slice | Content |
|-----|-------------|---------|
| canvas | `canvas` | nodes (plain JS array, whole-array replace), edges, newResultsFlag |
| imageEditor | `imageEditor` | nodes, edges (via Yjs subdoc) |

The canvas `nodes` field is intentionally stored as a **plain JS array**
wrapped in `Y.Map.set("nodes", array)`, not a `Y.Array`. Backend updates
(from Collab's task-listener) follow the same convention: read, clone,
mutate index, `set` the full new array. Concurrency on node state is
guarded by a **Redis lock**, not Yjs merge semantics — see
[YJS.md section 7](./YJS.md#7-concurrency--the-canvas-node-lock).

### Sync Flow

```
Redux dispatch → reducer → yjsStoreSync detects change → Yjs doc updated
    → IndexedDB persists locally
    → WebSocket broadcasts to peers
    → Peers receive → Yjs doc → yjsStoreSync → Redux → UI re-renders
```

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
├── assets.ts          # getUploadUrl, getOssSts, notifyUploadComplete, query
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

- **Canvas state**: single `canvas.ts` slice holds nodes (array) + edges (record) + UI state
- **Edge storage**: Redux stores as `Record<string, Edge>` (efficient Yjs map sync), converted to `Edge[]` for ReactFlow
- **Yjs sync**: `createYjsStoreSync()` replaces old `yjs-redux` binder — cleaner, with debounce support
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

### 2. Direct OSS Upload

`ossClient.ts` uses ali-oss SDK directly with STS credentials. Should migrate to presigned URL pattern (backend `POST /api/v1/assets/upload-url` already supports this).

### 3. Auth Integration

Google OAuth via `@react-oauth/google` needs to connect with backend's `/api/v1/auth` routes. Email+password auth flow needs to be wired up.

### Resolved

- ~~API Endpoint Mismatch~~ — New API files created, aligned with `/api/v1/*`
- ~~No @breatic/shared Integration~~ — Frontend now imports from `@breatic/shared`
- ~~Duplicate i18n System~~ — Unified to root `locales/*.json`, shared by frontend and backend
- ~~State Management Complexity~~ — Clarified: `ossClient.ts` is the remaining direct-upload issue (see #2)
