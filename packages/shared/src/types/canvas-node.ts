/**
 * Canvas node data shared between frontend, Collab, and server.
 *
 * Defines the authoritative shape of a canvas node's `data` field —
 * what lives in the Yjs document under `canvas.nodes[i].data`. The
 * frontend extends this with UI-only fields (pickState, handles,
 * pendingFileId) in its own `CanvasWorkflowNodeData`.
 *
 * State machine:
 *   idle  ─▶ (user clicks generate / upload)  ─▶  handling
 *   handling  ─▶ (Worker / upload success)     ─▶  idle (content updated)
 *   handling  ─▶ (Worker / upload failure)     ─▶  idle (content unchanged,
 *                                                        failure recorded
 *                                                        in node_history)
 *
 * Concurrency: only one operation can run against a node at a time.
 * The lock is enforced server-side via a Redis SETNX on
 * `${env}:canvas:lock:${projectId}:${nodeId}` with a 2-hour TTL.
 */

/** State of a canvas node's content pipeline. */
export type CanvasNodeState = "idle" | "handling";

/** Identifies the user who triggered the current handling. */
export interface HandlingActor {
  userId: string;
  username: string;
}

/**
 * User-editable input for a node's content pipeline.
 *
 * @deprecated Legacy shape from the plain-JS-array era. New code
 * should read prompt / attachments / params directly from the node
 * Y.Map. See `CanvasNodeFields` for the new per-key schema.
 */
export interface CanvasNodeRuntimeData {
  runType?: "parameter" | "sensitive";
  attach?: unknown;
  prompt?: string;
  parameter?: Record<string, unknown>;
}

/**
 * Shape of a canvas node's `data` field in the legacy plain-array
 * format.
 *
 * @deprecated Retained for backward compatibility during migration.
 * New canvas documents use `nodesMap: Y.Map<nodeId, Y.Map>` with
 * the fields listed in `CanvasNodeFields`.
 */
export interface CanvasNodeData {
  name: string;
  content: string;
  cover_url?: string;
  state: CanvasNodeState;
  handlingBy?: HandlingActor;
  nodeRuntimeData: CanvasNodeRuntimeData;
}

// ── New structure (Y.Map per node) ────────────────────────────────

/**
 * Attachment reference stored in the per-node `attachments` Y.Array.
 *
 * Each attachment is a `Y.Map` with these string-typed keys. The
 * `id` is used inside TipTap `@` Mention nodes to identify which
 * attachment is being referenced (the mention also carries `url` and
 * `name` as attrs for display).
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
 * Documents the keys present on each node's `Y.Map` in the new
 * canvas document structure (`canvas.nodesMap`).
 *
 * This is NOT a runtime type — you never instantiate a
 * `CanvasNodeFields` object. It exists to document the Y.Map schema
 * in TypeScript so that readers can see the shape at a glance
 * without opening `docs/YJS.md`. The actual runtime values are
 * accessed via `nodeMap.get("content")`, `nodeMap.get("prompt")`,
 * etc.
 *
 * Yjs types are not representable in this interface (there is no TS
 * type for "a Y.XmlFragment"), so those fields are annotated in
 * comments.
 */
export interface CanvasNodeFields {
  /** Stable node ID (immutable after creation). */
  id: string;
  /** Modality type code: 1001 text, 1002 image, 1003 video, 1004 audio, group. */
  type: string;
  /** Canvas coordinates — stored as Y.Map { x, y } at runtime. */
  position: { x: number; y: number };
  /** Display label. */
  name: string;
  /** Pipeline state machine. */
  state: CanvasNodeState;
  /** Who triggered the current handling; undefined when idle. */
  handlingBy?: HandlingActor;
  /** Primary result: URL (image/video/audio/3d) or text body. */
  content: string;
  /** Video first-frame cover URL. */
  coverUrl?: string;
  /**
   * Rich text prompt — at runtime this is a `Y.XmlFragment` bound
   * to TipTap via y-prosemirror. Contains text + inline Mention
   * nodes with attachment details (url, name, mimeType).
   *
   * Stored as `Y.XmlFragment`, not a string.
   */
  prompt: unknown; // Y.XmlFragment at runtime
  /**
   * Per-node upload pool — at runtime a `Y.Array<Y.Map>` where each
   * entry conforms to `AttachRef`.
   */
  attachments: AttachRef[];
  /**
   * Generation parameters — at runtime a `Y.Map<string, unknown>`.
   */
  params: Record<string, unknown>;
}

// ── Event bus payloads ─────────────────────────────────────────────

/**
 * Fired when a node transitions to `handling` (generation or upload
 * just started). Collab sets `state: "handling"` + `handlingBy` on
 * the canvas node.
 */
export interface NodeHandlingEvent {
  type: "handling";
  projectId: string;
  nodeId: string;
  actor: HandlingActor;
}

/**
 * Fired when a node's handling finishes successfully. Collab updates
 * `content` (+ `cover_url` for videos), clears `handlingBy`, and
 * sets `state: "idle"`.
 */
export interface NodeCompletedEvent {
  type: "completed";
  projectId: string;
  nodeId: string;
  /** New primary content (URL or text). */
  content: string;
  /** Video first-frame cover. */
  cover_url?: string;
}

/**
 * Fired when a node's handling fails. Collab clears `handlingBy`
 * and sets `state: "idle"` — `content` and `cover_url` are left
 * untouched so the previous result is preserved. Failure details
 * are written separately to `node_history` by the API/Worker.
 */
export interface NodeFailedEvent {
  type: "failed";
  projectId: string;
  nodeId: string;
}

/** Union of all node state events carried on the canvas event bus. */
export type NodeEvent = NodeHandlingEvent | NodeCompletedEvent | NodeFailedEvent;
