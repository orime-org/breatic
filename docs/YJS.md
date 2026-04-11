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

The canvas document has a single root `Y.Map` keyed `"canvas"`:

```
Y.Doc
  └── canvas: Y.Map
        ├── nodes:          plain JS array of CanvasNode objects
        ├── edges:          plain JS object (map id → Edge)
        └── newResultsFlag: plain JS array — transient UI hint
```

> **Important**: `nodes` is stored as a **plain JS array**, not a
> `Y.Array`. Every update replaces the whole array via
> `canvasMap.set("nodes", newArray)`. This matches the frontend's
> `createCanvasSliceSync` in `yjsSliceSyncs.ts`.

### 3.1 CanvasNode shape

Each entry in `nodes[]` is a ReactFlow-compatible node:

```ts
interface CanvasNode {
  id: string;                           // "1002-1775309939251-LP9fU"
  type: string;                         // "1001" | "1002" | "1003" | "1004" | "group"
  position: { x: number; y: number };
  data: CanvasNodeData;                 // see section 3.2
}
```

The `type` field uses numeric strings corresponding to modalities:

| `type` | Meaning |
|--------|---------|
| `"1001"` | Text node |
| `"1002"` | Image node |
| `"1003"` | Video node |
| `"1004"` | Audio node |
| `"group"` | Group node (container for other nodes) |

### 3.2 CanvasNodeData — the authoritative shape

Defined in `@breatic/shared/types/canvas-node.ts`:

```ts
interface CanvasNodeData {
  /** Display label / modality name ("image" | "video" | ...). */
  name: string;

  /** Primary result: URL (image/video/audio/3d) or text content. */
  content: string;

  /** Video first-frame cover — only set for video nodes. */
  cover_url?: string;

  /** Current state of the content pipeline. */
  state: "idle" | "handling";

  /** Who is currently handling this node; present iff state === "handling". */
  handlingBy?: { userId: string; username: string };

  /** User-editable input for the content pipeline. */
  nodeRuntimeData: {
    runType?: "parameter" | "sensitive";
    attach?: unknown;
    prompt?: string;                    // JSON-in-HTML from rich text editor
    parameter?: Record<string, unknown>;
  };
}
```

The frontend's `CanvasWorkflowNodeData` extends this with UI-only
fields that the backend never touches:

```ts
// packages/web/src/apps/project/components/canvas/types.ts
interface CanvasWorkflowNodeData extends CanvasNodeData {
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

The fundamental rule: **the frontend does not write node state**.

| Field | Written by | When |
|-------|------------|------|
| `content` | Collab (via Worker/upload events) | After generation/upload completes |
| `cover_url` | Collab (via Worker/upload events) | After video generation/upload completes |
| `state` | Collab (via API/Worker events) | handling (on lock acquire) / idle (on completion) |
| `handlingBy` | Collab (via API events) | handling (set) / completion (cleared) |
| `name` | Frontend | User renames the node |
| `nodeRuntimeData` | Frontend | User edits params or prompt |
| `position` | Frontend | User drags the node |
| `id`, `type` | Frontend | Node creation |
| Node creation / deletion | Frontend | User adds or deletes a node |

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

## 9. Best practices for backend code writing Yjs

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

## 10. Node editor documents (future)

Each canvas node may have an accompanying editor document for its
detailed UI (rich text, image editor subcanvas, etc.). These are
**independent Yjs documents**, not subdocs, following the name
pattern `project-{id}/node/{nodeId}`.

For the canvas sync work in task #115, editor documents are **not
yet integrated** with the event stream. Their contents are purely
frontend-owned. Cross-document consistency (e.g. updating a canvas
node when its editor content changes) will be handled in a later
iteration via the same event bus pattern.

## 11. Awareness (future)

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
