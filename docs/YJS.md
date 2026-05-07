# Yjs Document Structure

This document is the authoritative specification for every Yjs
document Breatic stores — naming conventions, map shapes, who
writes what, and how updates are coordinated across the frontend,
the Collab service, the API, and the Worker.

All types referenced below live in `@breatic/shared/types/canvas-node.ts`.
Any change to this spec must update that file and vice versa.

---

## 1. Document types

Breatic uses **one** flavor of Yjs document per project, backed by the
`yjs_documents` table in PostgreSQL via Hocuspocus:

| Flavor | Scope | Persistence | Awareness |
|--------|-------|-------------|-----------|
| **Canvas** | Per-project, shared by all collaborators | `yjs_documents` | Yes (cursors, selection, online users) |

There is a single Yjs document per project. Per-node editor sub-documents
(previously `project-{id}/node/{nodeId}`) are no longer created; all node
data lives in the single project canvas document.

The TipTap text editor opens in a left panel and connects to a separate
editor context (not a separate Yjs document). A "video editor" entry point
on video nodes is planned (剪映/PR-style), currently in design.

## 2. Document naming

Document name function lives in `packages/collab/src/schema.ts`:

```ts
canvasDocName(projectId) → "project-{projectId}"
```

One document per project. The old `project-{id}/canvas` and
`project-{id}/node/{nodeId}` naming schemes are obsolete. All canvas
and node data shares this single document.

## 3. Canvas document shape

The canvas document has a single root `Y.Map` keyed `"canvas"`.
Each node is an independent `Y.Map` keyed by its ID, so editing
one node never touches any other node's data.

```
Y.Doc
  └── canvas: Y.Map
        ├── nodesMap:  Y.Map<nodeId, Y.Map>   ← node data, O(1) by ID
        └── edges:     Y.Map<edgeId, Y.Map>
```

Z-index (node stacking order) is **not persisted** in Yjs. ReactFlow
manages z-index per user as ephemeral UI state — clicking a node
brings it to front locally, which does not need to sync across
collaborators.

### 3.1 Node Y.Map fields

Each value in `nodesMap` is a `Y.Map` with a nested `data` Y.Map,
mirroring ReactFlow's `{ id, type, position, data }` shape:

```
nodeMap: Y.Map
  ├── id:       string                    ← top level
  ├── type:     string                    ← top level
  ├── position: Y.Map { x, y }           ← top level
  └── data:     Y.Map                     ← nested, matches ReactFlow node.data
        ├── name:            string
        ├── state:           "idle" | "handling"
        ├── handlingBy:      Y.Map { userId, username } | undefined
        ├── content:         string | undefined       ← result URL or text
        ├── cover_url:       string | undefined       ← video first-frame
        ├── errorMessage:    string | undefined       ← set on failure (state stays idle)
        ├── width:           number | undefined
        ├── height:          number | undefined
        ├── duration:        number | undefined       ← audio/video seconds
        ├── sourceNodeId:    string | undefined       ← origin node for derived nodes
        ├── operation:       string | undefined       ← mini-tool operation name
        ├── operationParams: Y.Map | undefined        ← operation-specific params
        ├── prompt:          Y.XmlFragment            ← TipTap rich text
        ├── model:           string | undefined
        ├── modelParams:     Y.Map<string, unknown> | undefined
        ├── attachments:     Y.Array<Y.Map>
        └── childIds:        Y.Array<string>          ← ordered child node IDs (for N-output ops)
```

**Top-level keys** (immutable after creation or frontend-owned topology):

| Key | Yjs type | Description | Written by |
|-----|----------|-------------|------------|
| `id` | string | Stable node ID (immutable after creation) | Frontend |
| `type` | string | Modality: `"1001"` text, `"1002"` image, `"1003"` video, `"1004"` audio, `"group"` | Frontend |
| `position` | `Y.Map { x, y }` | Canvas coordinates | Frontend (drag) |

**Nested `data` Y.Map keys**:

| Key | Yjs type | Written by | Description |
|-----|----------|------------|-------------|
| `name` | string | Frontend | Display label |
| `state` | `"idle"` \| `"handling"` | Collab (event-stream) | Pipeline state |
| `handlingBy` | `Y.Map { userId, username }` \| undefined | Collab | Who triggered the current handling |
| `content` | string \| undefined | Collab (NodeStateUpdateEvent) | Result URL or text body |
| `cover_url` | string \| undefined | Collab (NodeStateUpdateEvent) | Video first-frame cover |
| `errorMessage` | string \| undefined | Collab (NodeStateUpdateEvent) | Set on failure; `state` remains `idle` |
| `width` | number \| undefined | Collab | Output width in pixels |
| `height` | number \| undefined | Collab | Output height in pixels |
| `duration` | number \| undefined | Collab | Audio/video duration in seconds |
| `sourceNodeId` | string \| undefined | Frontend | Origin node ID for derived (sibling) nodes |
| `operation` | string \| undefined | Frontend | Mini-tool operation name |
| `operationParams` | `Y.Map` \| undefined | Frontend | Operation-specific parameters |
| `prompt` | `Y.XmlFragment` | Frontend | Rich text prompt with inline `@` mentions |
| `model` | string \| undefined | Frontend | Selected AI model ID |
| `modelParams` | `Y.Map<string, unknown>` \| undefined | Frontend | Generation parameters |
| `attachments` | `Y.Array<Y.Map>` | Frontend | Upload pool for this node |
| `childIds` | `Y.Array<string>` | Frontend | Ordered child node IDs for N-output operations |

**prompt** is a `Y.XmlFragment` bound to a single TipTap editor
instance when the user focuses on this node's prompt input. At most
one node can be in prompt-editing mode per user. When the prompt is
not focused, no ProseMirror instance exists — the canvas card
renders a static HTML preview via `generateHTML()` from
`@tiptap/html` (zero ProseMirror overhead). This supports 1000+
nodes without performance issues.

`@` mentions inside the prompt are TipTap `Mention` nodes carrying
the full attachment details as attributes (`url`, `name`,
`mimeType`). They are self-contained — deleting an attachment from
the `attachments` list does NOT remove the corresponding `@` from
the prompt. Users manually delete `@` blocks (whole-block delete,
like a WeChat sticker). When the prompt is submitted for generation,
the frontend extracts all `@` mention nodes and assembles the
attachment list for the API request.

**attachments** holds the per-node upload pool. Each entry is a
`Y.Map` with keys: `id`, `url`, `name`, `mimeType`, `size`,
`uploadedAt`. Attachments are NOT shared across nodes. Deletion is
a real `Y.Array` remove (not soft-delete) — recoverable via undo
within the current session, but gone after the undo stack is
destroyed. The OSS/S3 object at the URL is never deleted.

### 3.2 Node type codes

| `type` | Meaning |
|--------|---------|
| `"1001"` | Text node |
| `"1002"` | Image node |
| `"1003"` | Video node |
| `"1004"` | Audio node |
| `"group"` | Group node (container for other nodes) |

### 3.3 edges

`edges` is a `Y.Map<edgeId, Y.Map>`, where each edge map holds:

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | Stable edge ID |
| `source` | string | Source node ID |
| `target` | string | Target node ID |
| `sourceHandle` | string \| undefined | Source handle ID |
| `targetHandle` | string \| undefined | Target handle ID |

### 3.4 Frontend UI-only extensions

The frontend's `CanvasWorkflowNodeData` mirrors the `data` Y.Map
keys and adds UI-only state that is **NOT** synced to Yjs:

```ts
// packages/web/src/apps/project/components/canvas/types.ts
interface CanvasWorkflowNodeData {
  // ── From data Y.Map (synced) ──
  name: string;
  state: 'idle' | 'handling';
  handlingBy?: { userId: string; username: string };
  content?: string;
  cover_url?: string;
  errorMessage?: string;
  // ... other data Y.Map fields
  // ── UI-only (NOT in Yjs) ──
  localPending?: boolean;   // node pre-created by this client, not yet in Yjs
  pickState?: PickState | null;         // image-pick-mode overlay state
  handles?: { target?: HandleConfig[]; source?: HandleConfig[] };
}
```

**`localPending`** is tracked by `LocalPendingProvider` (React context,
browser-session lifetime, per-user). Nodes in this state are visible
only to the creating client until the Yjs write round-trip confirms
they are synced. On confirmation, `localPending` is cleared.
```

## 4. Node state machine

```
idle ──(user triggers operation)──► handling
handling ──(task success)──► idle  (content / cover_url / width / height / duration updated)
handling ──(task failure)──► idle  (content unchanged, errorMessage set)
```

Only two Yjs states: **`idle`** and **`handling`**.

- **No `failed` state in Yjs.** Failures revert the node to `idle`
  with `errorMessage` set. The error message is displayed inline on
  the node card. Previous `content` is unchanged.
- **`localPending`** is a third, browser-local pseudo-state tracked
  in `LocalPendingProvider` (React context, not Yjs). A node in
  `localPending` was pre-created by the client and is not yet
  confirmed in the Yjs document. Once the Yjs write round-trip
  succeeds, `localPending` is cleared and the node behaves normally.
- **No per-node Redis lock.** Operations produce new sibling nodes
  on the canvas (connected by edge), so concurrent operations on the
  same source node do not race for a single mutable result slot.
- **1:N support.** Worker payload includes `targetNodeIds: string[]`.
  The frontend pre-creates N placeholder nodes; Worker emits one
  `NodeStateUpdateEvent` per target node ID.

## 5. Ownership — who writes what

The fundamental rule: **the frontend does not write `data.state` /
`data.handlingBy` / `data.content` / `data.cover_url` /
`data.errorMessage` / `data.width` / `data.height` / `data.duration`**.

| Field | Written by | When |
|-------|------------|------|
| `id`, `type` | Frontend | Node creation (immutable after) |
| `position` | Frontend | User drags the node |
| `data.name` | Frontend | User renames the node |
| `data.state` | Collab (via NodeStateUpdateEvent) | Transitions to/from `handling` |
| `data.handlingBy` | Collab (via NodeStateUpdateEvent) | Set on handling start, cleared on completion |
| `data.content` | Collab (via NodeStateUpdateEvent) | After generation completes |
| `data.cover_url` | Collab (via NodeStateUpdateEvent) | After video generation completes |
| `data.errorMessage` | Collab (via NodeStateUpdateEvent) | On task failure |
| `data.width` | Collab (via NodeStateUpdateEvent) | Output dimensions (if known) |
| `data.height` | Collab (via NodeStateUpdateEvent) | Output dimensions (if known) |
| `data.duration` | Collab (via NodeStateUpdateEvent) | Audio/video duration |
| `data.sourceNodeId` | Frontend | Set at node creation for derived nodes |
| `data.operation` | Frontend | Set at node creation for mini-tool derived nodes |
| `data.operationParams` | Frontend | Operation-specific parameters |
| `data.prompt` | Frontend | User types in the prompt editor (Y.XmlFragment ops) |
| `data.model` | Frontend | User selects AI model |
| `data.modelParams` | Frontend | User changes generation parameters |
| `data.attachments` | Frontend | User uploads / deletes attach items |
| `data.childIds` | Frontend | Set when creating N-output placeholder nodes |
| `edges` | Frontend | User creates / deletes connections |
| Node creation / deletion | Frontend | User adds or deletes a node |

## 5.1 Undo / redo

Two independent `Y.UndoManager` instances, each tracking only its
own user's operations (per-user origin `canvas-user:${userId}`):

| Undo scope | Tracks | Active when | Lifetime |
|------------|--------|-------------|----------|
| **Canvas undo** | `nodesMap` (create/delete), `edges`, node `position`/`name` | Focus is on the canvas background | Entire canvas session |
| **Prompt undo** | One node's `prompt` Y.XmlFragment | Focus is in a node's prompt editor | Created on focus, **destroyed on blur** |

Key behaviors:

- **Canvas undo does NOT undo prompt edits.** Typing in a prompt
  and then pressing Ctrl+Z on the canvas will NOT undo the typing.
- **Prompt undo does NOT undo canvas topology changes.** Pressing
  Ctrl+Z inside a prompt will NOT undo a node deletion.
- **Prompt undo stack is session-scoped.** Blurring the prompt
  destroys the TipTap editor and its UndoManager. Next time the
  user focuses the same prompt, the undo stack starts empty.
- **attachments and params are NOT undo-tracked by either manager.**
  Attachment deletion inside the attachments list is recoverable
  only if a custom undo layer is added in the future. Currently,
  deleting an attach is permanent within the Yjs document (but the
  OSS object at the URL is never deleted).

Key consequences:

- **Frontend never optimistically writes `state = "handling"`.**
  Clicking generate shows a local button spinner until the Collab
  event roundtrip sets the Yjs state. This takes ~50–200ms and
  avoids CRDT races on the state field.
- **Backend never creates or deletes nodes.** It only updates
  existing nodes' `data` fields.

## 6. Event flow

AIGC state transitions travel through a Redis Stream rather than
direct RPC between services.

```
┌─────────────┐                                    ┌─────────────┐
│    API      │ ─┐                               ┌─│   Worker    │
│ POST /tasks │  │                               │ │ BullMQ job  │
└─────────────┘  │                               │ └─────────────┘
                 │                               │
                 │     dev:stream:canvas-nodes   │
                 ▼                               ▼
             ┌──────────────────────────────────────┐
             │              Redis Stream             │
             │  NodeStateUpdateEvent                 │
             └──────────────────────────────────────┘
                             │
                             │ XREAD (durable, resume-from-last-id)
                             ▼
                       ┌────────────┐
                       │   Collab   │
                       │ task-      │
                       │ listener   │
                       └────────────┘
                             │
                             │ openDirectConnection → transact
                             ▼
                    ┌──────────────────┐
                    │  Canvas Y.Doc    │
                    │  canvas.nodesMap │
                    └──────────────────┘
                             │
                             │ Yjs WebSocket broadcast
                             ▼
                      All connected clients
```

### 6.1 Event type (`NodeStateUpdateEvent`)

A single, unified event shape replaces the old three-event
(`handling` / `completed` / `failed`) union:

```ts
interface NodeStateUpdateEvent {
  type: "node-state-update";
  projectId: string;
  targetNodeId: string;      // single target node
  update: Partial<CanvasNodeFields["data"]>;
  // update is merged into the target node's data Y.Map.
  // Allowlisted fields: state, content, cover_url, errorMessage,
  //                     width, height, duration, handlingBy
}
```

For **1:N operations** (e.g. a mini-tool producing multiple outputs),
the Worker emits one `NodeStateUpdateEvent` per target node ID.
The frontend pre-creates N placeholder nodes and passes their IDs
to the API as `targetNodeIds: string[]`.

Collab merges `update` into the target node's `data` Y.Map field by
field — only allowlisted keys are written; unknown keys are ignored.

### 6.2 Who publishes what

| Publisher | Event | When |
|-----------|-------|------|
| API `POST /canvas/tasks` | `node-state-update` (state → "handling") | Before returning 201 |
| Worker `runTask` (success) | `node-state-update` (state → "idle" + content) | Task finished and result persisted |
| Worker `runTask` (failure) | `node-state-update` (state → "idle" + errorMessage) | Task threw an error |

> **Note**: User-initiated uploads (presigned URL flow) write directly
> to Yjs via the frontend — they do NOT go through the Redis Stream
> event bus. The frontend sets `data.content` on the node's Y.Map
> after uploading to the presigned URL.

### 6.3 Stream persistence

- **Stream key**: `${env}:stream:canvas-nodes`
- **Last-id key**: `${env}:collab:canvas-nodes:last-id`
- **Consumer**: single consumer (one Collab instance per env). Uses
  `XREAD BLOCK` with a Redis-persisted last-id. On Collab restart
  the consumer resumes from the saved id, so no events are lost.
- **First boot** reads from `0-0` to replay any pending history.

## 7. Concurrency — no per-node lock

In the Phase 2 canvas-native model, **per-node Redis locks are
removed**. Concurrent operations on the same source node are handled
by producing new sibling nodes on the canvas rather than overwriting
the source node in place.

The concurrency model is:

- Each operation creates one or more **new** result nodes connected
  to the source node by an edge.
- The source node's `state` is set to `"handling"` for the duration
  of the operation and returns to `"idle"` on completion or failure.
- Multiple operations can run concurrently against different result
  placeholder nodes without contention — there is no shared mutable
  slot to race over.
- Category B mini-tools (backend AIGC operations) allow unlimited
  concurrent ops per source node.

Tasks without a `targetNodeId` (agent chat creation, understand
tasks) **never touch canvas node state** — they don't emit
`NodeStateUpdateEvent`.

### 7.1 Why no lock is needed

The old lock existed to prevent two tasks from racing to overwrite
the same `content` field. The new model eliminates that race by
design: each task writes to its own new node. There is no single
mutable `content` slot to guard.

Stripe deduction idempotency is handled by `deductOnce()` on the
payment path (not by the canvas lock), so removing the canvas lock
has no billing-safety implications.

## 8. Sanity checks in the Collab handler

The `task-listener` in `packages/collab/src/task-listener.ts`
defends against edge cases:

- **`canvas.nodesMap` is not a Y.Map** → warn log + skip (first-time
  document that no client has populated yet).
- **Node missing nested `data` Y.Map** → warn log + skip (legacy
  node created before the nested data migration).
- **Node not found by id** → warn log + skip (node was deleted
  mid-operation, or the event references a stale id).
- **Same event re-delivered** after a Collab restart → idempotent
  re-apply (state is already the target value — the repeat write
  is harmless).

## 8.5 WebSocket authentication

Every `HocuspocusProvider` connection must present a session token in
the `token` field of the Hocuspocus `onAuthenticate` hook. The server
looks the token up in Redis (`${env}:session:<token>`) and resolves
the caller's `userId`, then validates that the user is a member of
the project derived from the document name (`project-<uuid>`).

On the client side (`packages/web/src/utils/yjsManager.ts`):

- `token` is a **required** constructor parameter — no fallback, no
  default, no dev token. Empty token → refuse to construct.
- `onAuthenticationFailed` is wired to call `provider.disconnect()`
  and an injected callback. Without `disconnect()`, Hocuspocus will
  keep reconnecting after the server closes the socket, producing an
  infinite loop of rejected connects. The callback typically clears
  the stored auth and navigates to `/login`.

```ts
const provider = new HocuspocusProvider({
  url: wsUrl,
  name: docId,
  document: doc,
  token,  // Required — the caller plumbs this from Redux auth state.
  timeout: 10000,
  onAuthenticationFailed: ({ reason }) => {
    provider.disconnect();  // Stop the reconnect loop.
    onAuthFailed?.(reason);
  },
});
```

Upstream in `useYjsProjectStore`, the hook refuses to start Yjs at all
until it sees a non-empty token + enabled project id. This is the
second gate — it prevents the hook from constructing a manager that
would immediately fail auth.

## 9. Persistence and multi-instance sync

Yjs documents are **not in-memory only**. Hocuspocus wires two
extensions that handle durability and horizontal scaling:

### 9.1 PostgreSQL persistence (`@hocuspocus/extension-database`)

Each Yjs document is persisted as an encoded binary blob in the
`yjs_documents` table:

```
yjs_documents(
  name       TEXT PRIMARY KEY,   -- e.g. "project-abc"
  data       BYTEA NOT NULL,      -- Y.js binary state
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

- **Load**: on first client connection, Hocuspocus calls the
  `fetch(documentName)` hook, reads the blob, and hydrates a Y.Doc.
- **Save**: on mutation, the `store(documentName, state)` hook
  upserts the full Y.Doc state. Writes are debounced via
  `config/collab.yaml` so high-frequency cursor moves or typing
  don't thrash the DB.
- **No incremental updates**: a document is always stored as its
  full merged state. On restart, loading a document replays that
  single blob into memory — no operation log to apply.

The Drizzle schema for `yjs_documents` lives in
`packages/server/src/db/schema.ts` even though Collab owns the
table at runtime.

### 9.2 Redis cross-instance sync (`@hocuspocus/extension-redis`)

When multiple Collab instances run (future horizontal scaling),
each client's mutations must reach collaborators that happen to be
connected to a different instance. The Redis extension broadcasts
Y.js updates over pub/sub:

- **Prefix**: `${env}:hocuspocus:*`
- **Pattern**: instance A publishes a small diff when its local
  Y.Doc is mutated; instance B receives it and applies it to its
  own copy; instance B's connected clients see the update through
  their normal WebSocket.
- **Current deployment**: Breatic runs a single Collab instance,
  so this pipe is mostly idle — kept on for trivial cost and to
  avoid code changes when scaling.

> **Redis usage map** — the Hocuspocus Redis keys are intentionally
> separate from the other Redis keys Breatic uses, so none of them
> collide:
>
> | Purpose | Key prefix | Consumer |
> |---------|------------|----------|
> | Yjs cross-instance sync | `${env}:hocuspocus:*` | Hocuspocus Redis extension |
> | NodeEvent stream | `${env}:stream:canvas-nodes` | Collab |
> | Stream last-id | `${env}:collab:canvas-nodes:last-id` | Collab |
> | BullMQ task queue | `${env}:bull:*` | API + Worker |
> | Session store | `${env}:session:*` | API |

### 9.3 How a single Y.Doc write reaches everyone

When the Collab task-listener applies a NodeEvent to a canvas
document, the write fans out through four mechanisms:

```
Collab transact() ──► Y.Doc in memory
                          │
                          ├──► Hocuspocus Database extension
                          │    └─► PostgreSQL yjs_documents table
                          │
                          ├──► Hocuspocus Redis extension
                          │    └─► Redis pub/sub
                          │         └─► Other Collab instances (if any)
                          │
                          └──► Hocuspocus WebSocket
                               └─► All currently connected clients
```

Three independent destinations from one `transact()` call. The
client-visible update arrives over WebSocket, the durability is
handled asynchronously by the PG extension, and cross-instance
fanout is handled asynchronously by the Redis extension.

## 10. Best practices for backend code writing Yjs

When Collab (or any future backend consumer) wants to mutate canvas
node data:

```ts
const connection = await hocuspocus.openDirectConnection(docName, {
  context: { user: { id: "system" }, source: "event-stream" },
});
try {
  await connection.transact((doc) => {
    const canvasMap = doc.getMap("canvas");
    const nodesMap = canvasMap.get("nodesMap") as Y.Map<unknown>;
    if (!(nodesMap instanceof Y.Map)) return;

    const nodeMap = nodesMap.get(targetNodeId) as Y.Map<unknown>;
    if (!(nodeMap instanceof Y.Map)) return;

    const dataMap = nodeMap.get("data") as Y.Map<unknown>;
    if (!(dataMap instanceof Y.Map)) return;

    // Write to the nested data Y.Map — never to nodeMap directly.
    dataMap.set("content", newUrl);
    dataMap.set("state", "idle");
    dataMap.delete("handlingBy");
  });
} finally {
  await connection.disconnect();
}
```

**Do not**:

- Touch `position`, `id`, or `type` — those are frontend-owned (top-level)
- Write fields directly on `nodeMap` — always use `nodeMap.get("data")`
- Mutate `data.name`, `data.prompt`, `data.attachments`, or `data.params` — frontend-owned
- Perform many individual writes outside a single `transact` call

## 11. Canvas-native interaction model (Phase 2)

In the canvas-native model, **all operations happen on the main
canvas**. There is no separate "Launch Editor" sub-canvas for
image/video/audio nodes.

### 11.1 Two node categories

| Category | Examples | Operations |
|----------|----------|------------|
| **Generative nodes** | Text (1001), Image (1002), Video (1003), Audio (1004) with prompt | User writes prompt + selects model → backend AIGC task |
| **Data nodes** | Image (1002), Video (1003), Audio (1004) holding a result asset | Mini-tools produce new sibling nodes connected by edge |

Operations on data nodes do **not** modify the source node in
place. They create new sibling nodes on the canvas connected by an
edge from the source to the result. The `sourceNodeId` / `operation`
/ `operationParams` fields on the new node record where it came from.

### 11.2 LocalPendingProvider

When the frontend creates placeholder nodes for a pending operation
(e.g. before the backend confirms the task), those nodes are tracked
in `LocalPendingProvider` — a React context with browser-session
lifetime, per-user scope. They appear on the canvas immediately
(optimistic) but are not yet in the Yjs document. On Yjs
confirmation, `localPending` is cleared and the node becomes a
normal Yjs node.

### 11.3 Text editor

The TipTap text editor opens as a full-screen left panel. It uses
the main canvas document's `data.prompt` (`Y.XmlFragment`) for the
selected text node — there is no separate Yjs document for the text
editor.

### 11.4 Video editor (planned)

A dedicated video editor entry point on video nodes (剪映/PR-style
timeline editing) is planned but currently in design. It will be
specified as a separate section when implementation begins.

## 12. Awareness (future)

Hocuspocus's built-in Yjs awareness is currently unused. Planned
scope:

- Cursor position per user per canvas document
- Currently selected node per user
- Online presence list with username + avatar

Awareness state is ephemeral — never persisted — and broadcast over
the same WebSocket as the document itself. When implemented, the
schema will be added to this document.

---

## References

- `packages/shared/src/types/canvas-node.ts` — authoritative type source (CanvasNodeFields, AttachRef, NodeStateUpdateEvent)
- `packages/collab/src/task-listener.ts` — consumer: reads nodesMap Y.Map, merges NodeStateUpdateEvent update
- `packages/collab/src/event-stream.ts` — generic Stream consumer loop
- `packages/server/src/infra/event-stream.ts` — publisher helpers
- `packages/web/src/utils/yjsProjectManager.ts` — frontend Yjs setup (nodesMap/edgesMap init)
- `packages/web/src/hooks/useCanvasYjsInternal.ts` — Yjs observe → CanvasDataContext bridge
- `packages/web/src/hooks/useCanvasActions.ts` — node/edge write operations → Yjs
- `packages/web/src/utils/canvasYjsRef.ts` — module-level Yjs manager reference
- `packages/web/src/contexts/LocalPendingProvider.tsx` — localPending React context
- `packages/web/src/apps/project/components/canvas/types.ts` — frontend UI types
