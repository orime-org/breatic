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
 * Documents the keys on each node's Y.Map in the canvas document
 * (`canvas.nodesMap`).
 *
 * This is a documentation type — you never instantiate it. The
 * actual runtime values are accessed via `nodeMap.get("content")`,
 * `nodeMap.get("prompt")`, etc. Yjs shared types (Y.XmlFragment,
 * Y.Array, Y.Map) are noted in comments since they have no TS
 * representation here.
 */
export interface CanvasNodeFields {
  /** Stable node ID (immutable after creation). */
  id: string;
  /** Modality: "1001" text, "1002" image, "1003" video, "1004" audio, "group". */
  type: string;
  /** Canvas coordinates — Y.Map { x, y } at runtime. */
  position: { x: number; y: number };
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
  /** Rich text prompt — Y.XmlFragment at runtime (TipTap + y-prosemirror). */
  prompt: unknown;
  /** Per-node upload pool — Y.Array<Y.Map> at runtime. */
  attachments: AttachRef[];
  /** Generation parameters — Y.Map<string, unknown> at runtime. */
  params: Record<string, unknown>;
}

// ── Event bus payloads ─────────────────────────────────────────────

/** Node enters handling state (generation or upload started). */
export interface NodeHandlingEvent {
  type: "handling";
  projectId: string;
  nodeId: string;
  actor: HandlingActor;
}

/** Node handling finishes successfully. */
export interface NodeCompletedEvent {
  type: "completed";
  projectId: string;
  nodeId: string;
  content: string;
  cover_url?: string;
}

/** Node handling fails — content stays unchanged. */
export interface NodeFailedEvent {
  type: "failed";
  projectId: string;
  nodeId: string;
}

/** Union of all node state events on the canvas event bus. */
export type NodeEvent = NodeHandlingEvent | NodeCompletedEvent | NodeFailedEvent;
