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

/** User-editable input for a node's content pipeline. */
export interface CanvasNodeRuntimeData {
  /**
   * `parameter` — explicit params chosen by the user.
   * `sensitive` — intelligent mode where the LLM picks params.
   */
  runType?: "parameter" | "sensitive";
  attach?: unknown;
  /** JSON-in-HTML prompt payload from the rich text editor. */
  prompt?: string;
  parameter?: Record<string, unknown>;
}

/**
 * Shape of a canvas node's `data` field — the portion written by
 * both the frontend and the Collab service.
 *
 * Frontend-only UI state (pickState, handles, pendingFileId) lives
 * in `CanvasWorkflowNodeData` in the frontend types; the backend
 * never touches those.
 */
export interface CanvasNodeData {
  /** Node display name / modality label ("image" | "video" | ...). */
  name: string;
  /** Primary result: URL (image/video/audio/3d) or text content. */
  content: string;
  /** Video first-frame cover — only set for video nodes. */
  cover_url?: string;
  /** Current state of the content pipeline. */
  state: CanvasNodeState;
  /** Who is currently handling this node; present iff state === "handling". */
  handlingBy?: HandlingActor;
  /** Input parameters the node uses when it runs. */
  nodeRuntimeData: CanvasNodeRuntimeData;
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
