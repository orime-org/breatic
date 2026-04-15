# Yjs Document Structure

This document is the authoritative specification for every Yjs
document Breatic stores — naming conventions, map shapes, who
writes what, and how updates are coordinated across the frontend,
the Collab service, the API, and the Worker.

All types referenced below live in `@breatic/shared/types/canvas-node.ts`.
Any change to this spec must update that file and vice versa.

---

## 1. Document types

Breatic uses **two** flavors of Yjs documents, each backed by the
`yjs_documents` table in PostgreSQL via Hocuspocus:

| Flavor | Scope | Persistence | Awareness |
|--------|-------|-------------|-----------|
| **Canvas** | Per-project, shared by all collaborators | `yjs_documents` | Yes (cursors, selection, online users) |
| **Node editor** | Per-node within a project, one document per node | `yjs_documents` | Future: scoped to editor viewers only |

There is **no parent-child subdoc relationship** between a canvas
document and its node editor documents. Each is an independent Yjs
document with its own WebSocket connection.

## 2. Document naming

Document name functions live in `packages/collab/src/schema.ts`:

```ts
canvasDocName(projectId)             → "project-{projectId}/canvas"
nodeEditorDocName(projectId, nodeId) → "project-{projectId}/node/{nodeId}"
```

The naming scheme is deliberately path-like so the canvas document
acts as a **registry** for its node editor documents: given a canvas
node id, you can derive the editor document name without any
explicit parent-child link.

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
        ├── name:         string
        ├── content:      string
        ├── coverUrl:     string | undefined
        ├── state:        "idle" | "handling"
        ├── handlingBy:   Y.Map { userId, username } | undefined
        ├── runType:      "parameter" | "sensitive"
        ├── lastEventType: "completed" | "failed" | undefined
        ├── params:       Y.Map<string, unknown>
        ├── attachments:  Y.Array<Y.Map>
        └── prompt:       Y.XmlFragment
```

**Top-level keys** (immutable after creation or frontend-owned topology):

| Key | Yjs type | Description | Written by |
|-----|----------|-------------|------------|
| `id` | string | Stable node ID (immutable after creation) | Frontend |
| `type` | string | Modality: `"1001"` text, `"1002"` image, `"1003"` video, `"1004"` audio, `"group"` | Frontend |
| `position` | `Y.Map { x, y }` | Canvas coordinates | Frontend (drag) |

**Nested `data` Y.Map keys**:

| Key | Yjs type | Description | Written by |
|-----|----------|-------------|------------|
| `name` | string | Display label | Frontend |
| `state` | `"idle"` \| `"handling"` | Pipeline state | Collab (event-stream) |
| `handlingBy` | `Y.Map { userId, username }` \| undefined | Who triggered the current handling | Collab |
| `content` | string | Primary result: URL or text body | Collab (completed event) |
| `coverUrl` | string \| undefined | Video first-frame cover | Collab |
| `runType` | `"parameter"` \| `"sensitive"` | Generation run type | Frontend |
| `prompt` | `Y.XmlFragment` | Rich text prompt with inline `@` mentions (TipTap / y-prosemirror) | Frontend |
| `attachments` | `Y.Array<Y.Map>` | Upload pool for this node | Frontend |
| `params` | `Y.Map<string, unknown>` | Generation parameters | Frontend |

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
  content: string;
  coverUrl?: string;
  state: 'idle' | 'handling';
  handlingBy?: { userId: string; username: string };
  runType?: 'parameter' | 'sensitive';
  // ── UI-only (NOT in Yjs) ──
  pickState?: PickState | null;         // image-pick-mode overlay state
  handles?: { target?: HandleConfig[]; source?: HandleConfig[] };
}
```

## 4. Node state machine

```
idle ──(user clicks generate or upload)──► handling
handling ──(task / upload success)──► idle  (content updated)
handling ──(task / upload failure)──► idle  (content unchanged,
                                               failure logged in
                                               node_history)
```

Only two states: **`idle`** and **`handling`**.

- **No `failed` state.** Failures revert the node to `idle` with the
  previous content intact. Failure information lives in the
  `node_history` table (queried via
  `GET /api/v1/canvas/nodes/:nodeId/history`).
- **No `taskId` on the node.** Tasks can't be cancelled, so there's
  no race between a stale task's result and a newer task — the
  Redis lock enforces strict serialization.
- **No error field on the node.** Display errors by joining against
  `node_history` on the frontend.

## 5. Ownership — who writes what

The fundamental rule: **the frontend does not write `data.state` / `data.handlingBy` / `data.content` / `data.coverUrl`**.

| Field | Written by | When |
|-------|------------|------|
| `id`, `type` | Frontend | Node creation (immutable after) |
| `position` | Frontend | User drags the node |
| `data.name` | Frontend | User renames the node |
| `data.content` | Collab (via Worker/upload events) | After generation/upload completes |
| `data.coverUrl` | Collab (via Worker/upload events) | After video generation/upload completes |
| `data.state` | Collab (via API/Worker events) | handling → idle on completion |
| `data.handlingBy` | Collab (via API events) | handling (set) / completion (cleared) |
| `data.runType` | Frontend | User changes generation mode |
| `data.prompt` | Frontend | User types in the prompt editor (Y.XmlFragment ops) |
| `data.attachments` | Frontend | User uploads / deletes attach items |
| `data.params` | Frontend | User changes generation parameters |
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

AIGC and upload state transitions travel through a Redis Stream
rather than direct RPC between services.

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
             │  NodeHandlingEvent                    │
             │  NodeCompletedEvent                   │
             │  NodeFailedEvent                      │
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

### 6.1 Event types (`NodeEvent` union)

```ts
// Lock acquired, node enters handling state
interface NodeHandlingEvent {
  type: "handling";
  projectId: string;
  nodeId: string;
  taskId: string;                       // for lock ownership verification
  actor: { userId: string; username: string };
}

// Work completed successfully
interface NodeCompletedEvent {
  type: "completed";
  projectId: string;
  nodeId: string;
  taskId: string;                       // for lock release CAS
  content: string;                      // new URL or text
  cover_url?: string;                   // video first-frame, if applicable
}

// Work failed — content stays unchanged
interface NodeFailedEvent {
  type: "failed";
  projectId: string;
  nodeId: string;
  taskId: string;                       // for lock release CAS
}

type NodeEvent = NodeHandlingEvent | NodeCompletedEvent | NodeFailedEvent;
```

### 6.2 Who publishes what

| Publisher | Event | When |
|-----------|-------|------|
| API `POST /canvas/tasks` | `handling` | Immediately after acquiring the Redis lock, before returning 201 |
| Worker `runTask` | `completed` | Task finished and result was persisted |
| Worker `runTask` | `failed` | Task threw an error; `node_history` gets a failed entry in parallel |

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

## 7. Concurrency — the canvas node lock

One operation per node at a time. Enforced by Redis SETNX with a
2-hour TTL.

- **Key**: `${env}:canvas:lock:${projectId}:${nodeId}`
- **Value**: `{ userId, username, taskId, lockedAt }` (JSON)
- **Acquired by**: API at `POST /canvas/tasks` with taskId
- **Released by**: Collab after processing a `completed` or `failed`
  event — **verified via taskId CAS** (only the task that holds the
  lock can release it, preventing forged events from stealing locks)
- **Idempotent re-acquire**: the same user can re-enter the lock
  (refresh the TTL) without being rejected
- **TTL**: 2 hours, long enough for 1 GB video uploads and 10-minute
  3D generation, short enough to recover from a crashed publisher

Tasks without a `node_id` (agent chat creation, understand tasks)
**skip the lock entirely** — they don't target a specific canvas
node and don't emit node events.

### 7.1 Why a backend lock instead of Yjs conflict resolution

Yjs merges concurrent array writes deterministically (last writer
wins on the full-array `set`), but:

1. A Yjs merge can silently lose one user's `handling` state if two
   clicks race — with nothing left on the backend to recover from.
2. Redis is the single source of truth for "who's currently working
   on this node" — Collab, API, and Worker all agree.
3. The lock also gates the **Worker's side effects** (Stripe
   deductions, AIGC provider calls), which Yjs alone can't prevent.

## 8. Sanity checks in the Collab handler

The `task-listener` in `packages/collab/src/task-listener.ts`
defends against edge cases:

- **`canvas.nodesMap` is not a Y.Map** → warn log + skip (first-time
  document that no client has populated yet).
- **Node missing nested `data` Y.Map** → warn log + skip (legacy
  node created before the nested data migration).
- **Node not found by id** → warn log + skip + release lock (node
  was deleted mid-operation, or the event references a stale id).
- **Same event re-delivered** after a Collab restart → idempotent
  re-apply (state is already the target value, lock is already
  released — both operations are harmless repeats).

## 9. Persistence and multi-instance sync

Yjs documents are **not in-memory only**. Hocuspocus wires two
extensions that handle durability and horizontal scaling:

### 9.1 PostgreSQL persistence (`@hocuspocus/extension-database`)

Each Yjs document is persisted as an encoded binary blob in the
`yjs_documents` table:

```
yjs_documents(
  name       TEXT PRIMARY KEY,   -- e.g. "project-abc/canvas"
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
> | Canvas node locks | `${env}:canvas:lock:*` | API + Collab |
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

## 11. Node editor documents (Launch Editor sub-canvas)

Each canvas node may have an accompanying editor document for its
Launch Editor UI. These are **independent Yjs documents**, not
subdocs, following the name pattern `project-{id}/node/{nodeId}`.

| Node type | Editor content |
|-----------|---------------|
| Text | TipTap rich text (`Y.XmlFragment "body"`) |
| Image | ReactFlow sub-canvas (`Y.Map "flow" { nodes, edges }`) |
| Audio | ReactFlow sub-canvas |
| Video | ReactFlow sub-canvas |

Editor documents are **lazily loaded**: the frontend connects to
the Hocuspocus document only when the user clicks Launch Editor,
with a loading indicator while the document hydrates. On close, the
frontend disconnects and drops the local Y.Doc. The sub-canvas
content persists in PostgreSQL via Hocuspocus for the next session.

Sub-canvas nodes do **not** have their own Launch Editor (no
recursion). They use separate type codes from the main canvas
(e.g. image layers, audio tracks). Sub-canvas type design is TBD.

An "Apply to node" action on the sub-canvas writes the result back
to the parent node's `content` field on the main canvas. If the
parent node is in `handling` state, Apply is blocked with a warning.

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

- `packages/shared/src/types/canvas-node.ts` — authoritative type source (CanvasNodeFields, AttachRef, NodeEvent)
- `packages/collab/src/task-listener.ts` — consumer: reads nodesMap Y.Map, sets fields directly
- `packages/collab/src/event-stream.ts` — generic Stream consumer loop
- `packages/server/src/infra/event-stream.ts` — publisher helpers
- `packages/server/src/infra/canvas-lock.ts` — Redis SETNX node locks
- `packages/web/src/utils/yjsProjectManager.ts` — frontend Yjs setup (nodesMap/edgesMap init)
- `packages/web/src/hooks/useCanvasYjs.ts` — Yjs observe → Redux dispatch bridge
- `packages/web/src/hooks/useProjectStore.ts` — node/edge write operations → Yjs
- `packages/web/src/utils/canvasYjsRef.ts` — module-level Yjs manager reference
- `packages/web/src/apps/project/components/canvas/types.ts` — frontend UI types
