/**
 * Canvas node types shared between frontend, Collab, and server.
 *
 * These types document the Y.Map-per-node structure used in the
 * canvas Yjs document. See `docs/YJS.md` section 3 for the full
 * specification.
 *
 * State machine:
 *   idle  -> (user clicks generate / upload)  ->  handling
 *   handling  -> (Worker / upload success)     ->  idle (content updated)
 *   handling  -> (Worker / upload failure)     ->  idle (content unchanged)
 */

/** State of a canvas node's content pipeline. */
export type CanvasNodeState = "idle" | "handling";

/** Identifies the user who triggered the current handling. */
export interface HandlingActor {
  userId: string;
  username: string;
}

/**
 * Attachment reference stored in a node's `attachments` Y.Array.
 *
 * Each attachment is a `Y.Map` at runtime with these keys. The
 * `id` is used inside TipTap `@` Mention nodes for reference.
 */
export interface AttachRef {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

/**
 * Documents the keys on each node's Y.Map in the canvas document.
 *
 * Structure mirrors ReactFlow's `{ id, type, position, data }`:
 *
 * ```
 * nodeMap: Y.Map
 *   ├── id:       string
 *   ├── type:     string
 *   ├── position: Y.Map { x, y }
 *   └── data:     Y.Map              ← nested, matches ReactFlow
 *         ├── name:         string
 *         ├── content:      string
 *         ├── coverUrl:     string | undefined
 *         ├── state:        "idle" | "handling"
 *         ├── handlingBy:   Y.Map { userId, username } | undefined
 *         ├── runType:      "parameter" | "sensitive"
 *         ├── params:       Y.Map<string, unknown>
 *         ├── attachments:  Y.Array<Y.Map>
 *         └── prompt:       Y.XmlFragment
 * ```
 *
 * This is a documentation type — you never instantiate it.
 */
export interface CanvasNodeFields {
  /** Stable node ID (immutable after creation). */
  id: string;
  /** Modality: "1001" text, "1002" image, "1003" video, "1004" audio, "group". */
  type: string;
  /** Canvas coordinates — Y.Map { x, y } at runtime. */
  position: { x: number; y: number };
  /** Nested data — Y.Map at runtime, matches ReactFlow node.data. */
  data: {
    /** Display label. */
    name: string;
    /** Pipeline state. */
    state: CanvasNodeState;
    /** Who triggered the current handling; undefined when idle. */
    handlingBy?: HandlingActor;
    /** Primary result: URL or text body. */
    content: string;
    /** Video first-frame cover URL. */
    coverUrl?: string;
    /** Generation run type. */
    runType?: "parameter" | "sensitive";
    /** Rich text prompt — Y.XmlFragment at runtime (TipTap + y-prosemirror). */
    prompt: unknown;
    /** Per-node upload pool — Y.Array<Y.Map> at runtime. */
    attachments: AttachRef[];
    /** Generation parameters — Y.Map<string, unknown> at runtime. */
    params: Record<string, unknown>;
    /**
     * Last failure message. Set when a task fails (POST-side rejection or
     * Worker-side throw); cleared automatically by the Collab consumer
     * when the next `handling` or `completed` event lands on the node.
     *
     * Semantics differ by doc kind (enforced in the Collab consumer):
     *   - Canvas: failure preserves prior `content` / `coverUrl` so the
     *     user never loses their last successful result.
     *   - Mixed editor flow: failure clears `content` + `coverUrl`
     *     because the node IS the task's output — a failed mini-tool
     *     placeholder has no valid content to retain, and there is no
     *     retry UX for mixed-editor tiles (user deletes the node).
     */
    errorInfo?: string;
  };
}

// ── Event bus payloads ─────────────────────────────────────────────

/**
 * `docName` identifies the target Yjs document unambiguously:
 *   - `"project-{projectId}/canvas"` — main canvas (CanvasNodeFields above)
 *   - `"project-{projectId}/node/{hostNodeId}"` — mixed editor flow
 *     (the `nodeId` on the event is then the sub-node inside that flow)
 *
 * See `packages/collab/src/schema.ts` for the canonical builders
 * (`canvasDocName`, `nodeEditorDocName`) and parser (`parseDocName`).
 */

/**
 * Task-level event schema (unified multi-output):
 *
 * Every task — whether it produces 1 output or N — emits a single
 * event per state transition. Consumers iterate the `nodeIds` /
 * `outputs` array; N=1 tasks are a degenerate case of the same
 * shape. This is the outcome of the T3 phase5 refactor:
 * there is no "single-output fast path" — one schema, one code path.
 *
 * Examples:
 *   - `image.crop` — 1 input image → 1 output → `nodeIds: [x]`
 *   - `video.cut` — 1 input video + N segments → N outputs →
 *     `nodeIds: [x1,x2,...]` at handling,
 *     `outputs: [{nodeId:x1, content:...}, ...]` at completion
 */

/** All N nodes for the task enter handling simultaneously. */
export interface NodeHandlingEvent {
  type: "handling";
  docName: string;
  /** Task ID that acquired the lock. */
  taskId: string;
  actor: HandlingActor;
  /** The set of nodes this task updates on completion (N ≥ 1). */
  nodeIds: string[];
}

/**
 * Task completed. Exactly one output per node in `nodeIds`; the
 * consumer matches them by index-parallel iteration.
 */
export interface NodeCompletedEvent {
  type: "completed";
  docName: string;
  /** Task ID that held the lock — used for verified release. */
  taskId: string;
  /** One entry per affected node (N ≥ 1). */
  outputs: Array<{
    nodeId: string;
    content: string;
    cover_url?: string;
  }>;
}

/**
 * Task failed. All N nodes enter the failed state together (all-or-
 * nothing); partial success is expressed via completed + failed on
 * overlapping subsets if a handler ever needs that (not currently
 * used).
 *
 * Behavior on each node's `data` is doc-kind dependent (the Collab
 * consumer routes by `parseDocName(docName)`):
 *   - Canvas: `content` / `coverUrl` preserved (user's prior result
 *     stays visible); `errorInfo` set; `state` → `'idle'`.
 *   - Mixed editor flow: `content` + `coverUrl` cleared; `errorInfo`
 *     set; `state` → `'idle'`. The node becomes an explicit "failed
 *     placeholder" that the user must delete manually (no retry UI).
 */
export interface NodeFailedEvent {
  type: "failed";
  docName: string;
  /** Task ID that held the lock — used for verified release. */
  taskId: string;
  /** All nodes affected by this failure (N ≥ 1). */
  nodeIds: string[];
  /**
   * Human-readable failure reason. Written into each node's
   * `data.errorInfo` by the Collab consumer. Optional — events
   * without this field land as `errorInfo: ''`.
   */
  errorMessage?: string;
}

/** Union of all node state events on the task-events bus. */
export type NodeEvent = NodeHandlingEvent | NodeCompletedEvent | NodeFailedEvent;
