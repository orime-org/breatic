/**
 * Canvas node types shared between frontend, Collab, and server.
 *
 * Each project has one Yjs document containing nodesMap (Y.Map<nodeId, Y.Map>)
 * + edgesMap (Y.Map<edgeId, Y.Map>). Node state machine: 'idle' / 'handling'
 * (in Yjs); 'localPending' is local-only React state, never in Yjs.
 *
 * See design spec at:
 *   breatic-inner/design/2026-04-26-yjs-editor-redesign/spec.md (04-29 banner)
 */

/** Yjs-shared lifecycle. localPending is local-only and not represented here. */
export type NodeState = 'idle' | 'handling';

/** Identifies the user who triggered the current handling. */
export interface HandlingActor {
  userId: string;
  username: string;
}

/**
 * Attachment reference stored in a node's `attachments` Y.Array.
 *
 * Each attachment is a Y.Map at runtime with these keys.
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
 * Two node categories:
 *   - Generative: has prompt/model/modelParams; click execute → produces data node
 *   - Data: has content/cover_url/etc.; can be source for mini-tool ops
 *
 * Both share the state machine and core fields. Type fields below are
 * marked with which category they apply to.
 */
export interface CanvasNodeFields {
  /** Stable node ID (frontend-generated UUID v4, immutable after creation). */
  id: string;
  /** Modality: '1001' text, '1002' image, '1003' video, '1004' audio, '3d', 'web', 'generative', 'group'. */
  type: string;
  /** Canvas coordinates. Y.Map { x, y } at runtime. */
  position: { x: number; y: number };
  /** Nested data Y.Map at runtime. */
  data: {
    /** Display label. */
    name: string;

    // ─── Audit / lifecycle metadata (v13, all node types) ─────
    /** Creation time as epoch ms. Set once at node creation; never updated. */
    createdAt: number;
    /** User id who created the node. Set once at creation; never updated. */
    createdBy: string;
    /** When true, mini-tools / Worker writes / accidental deletes are blocked (spec §10.13.6). */
    locked: boolean;

    // ─── State machine (all node types) ─────────────────────
    /** Yjs-shared lifecycle. */
    state: NodeState;
    /** Who triggered the current handling; undefined when state === 'idle'. */
    handlingBy?: HandlingActor;
    /** Last failure message; present when state === 'idle' AND last operation failed. */
    errorMessage?: string;

    // ─── Data node fields ───────────────────────────────────
    /** Primary result: URL (image/video/audio/3D) or text body (text/web). */
    content?: string;
    /** Video first-frame thumbnail; equals `content` for image. */
    cover_url?: string;
    /** Image / video pixel width. */
    width?: number;
    /** Image / video pixel height. */
    height?: number;
    /** Video / audio duration in seconds. */
    duration?: number;
    /** Source node id when this data node was produced by a mini-tool from a parent node. */
    sourceNodeId?: string;
    /** Tool name when produced by mini-tool (e.g., 'image.crop'). */
    operation?: string;
    /** Tool input params when applicable. */
    operationParams?: Record<string, unknown>;

    // ─── Generative node fields ─────────────────────────────
    /** Rich text prompt — Y.XmlFragment at runtime (TipTap + y-prosemirror). */
    prompt?: unknown;
    /** Model id from config/models/*.yaml. */
    model?: string;
    /** Model-specific params. */
    modelParams?: Record<string, unknown>;

    // ─── Group node fields ──────────────────────────────────
    /** Child node IDs when type === 'group'. */
    childIds?: string[];

    // ─── Common ─────────────────────────────────────────────
    /** Per-node upload pool — Y.Array<Y.Map> at runtime. */
    attachments: AttachRef[];
  };
}

// ── Event bus payloads ────────────────────────────────────────────

/**
 * Partial update payload for a NodeStateUpdateEvent.
 *
 * Mirrors `Partial<CanvasNodeFields['data']>` but allows `null` for
 * fields that can be explicitly cleared — most importantly `handlingBy`.
 *
 * Why null instead of undefined:
 *   `JSON.stringify({ handlingBy: undefined })` → `"{}"` — the key is
 *   dropped and the Collab consumer never sees it. Using `null` preserves
 *   the key through the JSON round-trip so the consumer can call
 *   `dataMap.delete("handlingBy")` to clear the field.
 */
export type NodeStateUpdatePayload = {
  [K in keyof CanvasNodeFields['data']]?: CanvasNodeFields['data'][K] | null;
};

/**
 * Worker → Collab event.
 *
 * Worker writes to canvas state via this event (never directly to Yjs).
 * Collab consumes the event and applies `update` (NodeStateUpdatePayload)
 * to the target node, with allowlist filtering on the receiving end.
 *
 * Universal rule: backend can ONLY modify state fields. It cannot
 * create or delete nodes — that's frontend's responsibility. So the
 * `update` payload here will only carry state-field updates (state /
 * content / cover_url / errorMessage / handlingBy / width / height /
 * duration), enforced by the consumer's allowlist.
 *
 * docName carries the target Yjs doc. In the v10 multi-doc layout
 * (one Canvas Space doc per project per Space), this will be
 * `project-{projectId}/canvas-{spaceId}` once the worker rewrite in
 * PR-C lands. PR-A+B leaves this as the pre-v10 single-doc form
 * `project-{projectId}` because the worker hasn't migrated yet.
 *
 * Null-as-delete convention:
 *   A `null` value means "clear this field" (consumer calls Y.Map.delete).
 *   An absent key means "leave this field untouched".
 *   This distinction survives the JSON round-trip; `undefined` does not.
 */
export interface NodeStateUpdateEvent {
  type: 'node-state-update';
  /**
   * Yjs doc name. Pre-v10 form `project-{projectId}` until PR-C
   * migrates the worker to emit `project-{projectId}/canvas-{spaceId}`.
   */
  docName: string;
  /** Target node receiving the update. */
  nodeId: string;
  /** Partial update merged into target node's data Y.Map by Collab consumer. */
  update: NodeStateUpdatePayload;
}

/** Single union for forward-compat. */
export type NodeEvent = NodeStateUpdateEvent;

// ── Edge schema (v13) ──────────────────────────────────────────────

/**
 * Per-edge data fields stored under `edgeMap.data` (a Y.Map at runtime).
 *
 * `isPrimary` is meaningful only on a generative node's outgoing edges:
 * at most one such edge per source carries `isPrimary: true` and marks
 * the "primary downstream" the next regenerate updates in place
 * (spec §10.13.2 / §10.13.5). Non-generative edges should leave it
 * absent (or `false`); the invariant is enforced by frontend writers.
 */
export interface CanvasEdgeData {
  /** Marks the primary-downstream edge from a generative node. At most 1 true per source node. */
  isPrimary?: boolean;
}
