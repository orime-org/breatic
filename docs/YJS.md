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
Data (node fields) and ordering (z-index) are separated so that
editing a node's prompt never rewrites the render order, and
reordering never touches any node's data.

```
Y.Doc
  └── canvas: Y.Map
        ├── nodesMap:  Y.Map<nodeId, Y.Map>   ← data layer, O(1) by ID
        ├── nodeOrder: Y.Array<string>         ← z-order (nodeId list)
        └── edges:     Y.Map<edgeId, Y.Map>
```

### 3.1 Node Y.Map fields

Each value in `nodesMap` is a `Y.Map` with the following keys:

| Key | Yjs type | Description | Written by |
|-----|----------|-------------|------------|
| `id` | string | Stable node ID (immutable after creation) | Frontend |
| `type` | string | Modality: `"1001"` text, `"1002"` image, `"1003"` video, `"1004"` audio, `"group"` | Frontend |
| `position` | `Y.Map { x, y }` | Canvas coordinates | Frontend (drag) |
| `name` | string | Display label | Frontend |
| `state` | `"idle"` \| `"handling"` | Pipeline state | Collab (event-stream) |
| `handlingBy` | `Y.Map { userId, username }` \| undefined | Who triggered the current handling | Collab |
| `content` | string | Primary result: URL or text body | Collab (completed event) |
| `coverUrl` | string \| undefined | Video first-frame cover | Collab |
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

### 3.3 nodeOrder — z-index array

`nodeOrder` is a `Y.Array<string>` holding node IDs in render
order. The last ID in the array renders on top (highest z-index).

- **Create node**: `nodesMap.set(id, nodeMap)` + `nodeOrder.push([id])`
- **Delete node**: `nodesMap.delete(id)` + remove from `nodeOrder`
- **Bring to front**: remove from current position, push to end

`nodeOrder` is separate from `nodesMap` so that reordering never
touches any node's data fields (prompt, content, etc.), and editing
a node's data never affects z-order.

For ReactFlow rendering, the frontend maps `nodeOrder` to a
`Node[]` array:

```ts
const nodes = nodeOrder.toArray().map(id => {
  const m = nodesMap.get(id);
  return { id, type: m.get("type"), position: ..., data: ... };
});
```

### 3.4 edges

`edges` is a `Y.Map<edgeId, Y.Map>`, where each edge map holds:

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | Stable edge ID |
| `source` | string | Source node ID |
| `target` | string | Target node ID |
| `sourceHandle` | string \| undefined | Source handle ID |
| `targetHandle` | string \| undefined | Target handle ID |

### 3.5 Frontend UI-only extensions

The frontend's `CanvasWorkflowNodeData` extends the shared fields
with UI-only state that the backend never touches:

```ts
// packages/web/src/apps/project/components/canvas/types.ts
interface CanvasWorkflowNodeData {
  pickState?: PickState | null;         // image-pick-mode overlay state
  handles?: { target?: HandleConfig[]; source?: HandleConfig[] };
  pendingFileId?: string;               // in-flight upload id
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

The fundamental rule: **the frontend does not write `state` / `handlingBy` / `content` / `coverUrl`**.

| Field | Written by | When |
|-------|------------|------|
| `content` | Collab (via Worker/upload events) | After generation/upload completes |
| `coverUrl` | Collab (via Worker/upload events) | After video generation/upload completes |
| `state` | Collab (via API/Worker events) | handling → idle on completion |
| `handlingBy` | Collab (via API events) | handling (set) / completion (cleared) |
| `name` | Frontend | User renames the node |
| `prompt` | Frontend | User types in the prompt editor (Y.XmlFragment ops) |
| `attachments` | Frontend | User uploads / deletes attach items |
| `params` | Frontend | User changes generation parameters |
| `position` | Frontend | User drags the node |
| `id`, `type` | Frontend | Node creation (immutable after) |
| `nodeOrder` | Frontend | User reorders z-index (bring to front/back) |
| `edges` | Frontend | User creates / deletes connections |
| Node creation / deletion | Frontend | User adds or deletes a node |

## 5.1 Undo / redo

Two independent `Y.UndoManager` instances, each tracking only its
own user's operations (`trackedOrigins: [LOCAL_ORIGIN]`):

| Undo scope | Tracks | Active when | Lifetime |
|------------|--------|-------------|----------|
| **Canvas undo** | `nodesMap` (create/delete), `nodeOrder`, `edges`, node `position`/`name` | Focus is on the canvas background | Entire canvas session |
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
                    │  canvas.nodes[]  │
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
  actor: { userId: string; username: string };
}

// Work completed successfully
interface NodeCompletedEvent {
  type: "completed";
  projectId: string;
  nodeId: string;
  content: string;                      // new URL or text
  cover_url?: string;                   // video first-frame, if applicable
}

// Work failed — content stays unchanged
interface NodeFailedEvent {
  type: "failed";
  projectId: string;
  nodeId: string;
}

type NodeEvent = NodeHandlingEvent | NodeCompletedEvent | NodeFailedEvent;
```

### 6.2 Who publishes what

| Publisher | Event | When |
|-----------|-------|------|
| API `POST /canvas/tasks` | `handling` | Immediately after acquiring the Redis lock, before returning 201 |
| API `POST /assets/upload/prepare` | `handling` | Canvas context only, after acquiring the Redis lock |
| API `POST /assets/upload/complete` | `completed` | Canvas context only, on successful verification |
| API `POST /assets/upload/complete` | `failed` | Canvas context only, when the uploaded file is missing in storage |
| Worker `runTask` | `completed` | Task finished and result was persisted |
| Worker `runTask` | `failed` | Task threw an error; `node_history` gets a failed entry in parallel |

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
- **Value**: `{ userId, username, lockedAt }` (JSON)
- **Acquired by**: API at `POST /canvas/tasks` and
  `POST /assets/upload/prepare` (canvas context)
- **Released by**: Collab after processing a `completed` or `failed`
  event, so the lock lifetime exactly matches the handling window
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

- **`canvas.nodes` is not an array** → warn log + skip (first-time
  document that no client has populated yet).
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
> | Upload tickets | `${env}:upload:ticket:*` | API |

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
    const nodes = canvasMap.get("nodes") as CanvasNode[] | undefined;
    if (!Array.isArray(nodes)) return; // sanity check

    const idx = nodes.findIndex((n) => n.id === targetNodeId);
    if (idx === -1) return; // sanity check

    // Always build a new array — whole-array replace is the
    // frontend convention.
    const updated = [...nodes];
    updated[idx] = {
      ...nodes[idx],
      data: { ...nodes[idx].data, /* the fields you own */ },
    };
    canvasMap.set("nodes", updated);
  });
} finally {
  await connection.disconnect();
}
```

**Do not**:

- Call `canvasMap.delete("nodes")` or reorder the array
- Touch `nodes[i].position`, `nodes[i].id`, or `nodes[i].type`
- Mutate `nodes[i].data.name` or `nodes[i].data.nodeRuntimeData`
- Perform many individual writes — batch inside one `transact` call

## 11. Node editor documents (future)

Each canvas node may have an accompanying editor document for its
detailed UI (rich text, image editor subcanvas, etc.). These are
**independent Yjs documents**, not subdocs, following the name
pattern `project-{id}/node/{nodeId}`.

For the canvas sync work in task #115, editor documents are **not
yet integrated** with the event stream. Their contents are purely
frontend-owned. Cross-document consistency (e.g. updating a canvas
node when its editor content changes) will be handled in a later
iteration via the same event bus pattern.

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

- `packages/shared/src/types/canvas-node.ts` — authoritative type source
- `packages/collab/src/task-listener.ts` — consumer + canvas map writer
- `packages/collab/src/event-stream.ts` — generic Stream consumer loop
- `packages/server/src/infra/event-stream.ts` — publisher helpers
- `packages/server/src/infra/canvas-lock.ts` — Redis SETNX node locks
- `packages/web/src/utils/yjsProjectManager.ts` — frontend Yjs setup
- `packages/web/src/utils/yjsSliceSyncs.ts` — Redux ↔ Yjs bridge
- `packages/web/src/apps/project/components/canvas/types.ts` — frontend UI types
