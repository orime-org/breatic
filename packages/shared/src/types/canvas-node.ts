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

/**
 * Identifies the user who triggered the current handling AND the driver
 * responsible for advancing the node out of `handling`.
 *
 * `type` was added 2026-05-11 (ADR `2026-05-11-mini-tool-state-machine.md`)
 * so the Collab `onDisconnect` cleanup hook can distinguish:
 *
 *   - `frontend` — the user's own browser is running the op. If the
 *     client disconnects, Collab writes back `state: 'idle', errorMessage:
 *     "Operation interrupted by client disconnect"` so the node doesn't
 *     stay stuck in `handling` forever.
 *   - `backend`  — a Worker is running the op (POST → BullMQ → provider).
 *     Worker has its own retry / dead-letter machinery; Collab leaves
 *     these nodes untouched on user disconnect.
 */
export interface HandlingActor {
  userId: string;
  username: string;
  /** Who owns the handling → idle/error transition. See type-doc above. */
  type: 'frontend' | 'backend';
}

/**
 * One mini-tool configure-phase lock on a node.
 *
 * Added 2026-05-11 (ADR `2026-05-11-mini-tool-state-machine.md`). Multiple
 * locks can coexist on the same node — one per (user, tool) pair — to
 * support concurrent multi-user mini-tool configuration.
 *
 * Lifecycle:
 *   - Pushed when a user picks a tool in `NodeFloatMenu`.
 *   - Removed when the same user presses Apply or Cancel (matched by
 *     `toolId + userId`; one operation may only release its own lock).
 *   - Stripped by Collab's `onDisconnect` hook when the holder leaves
 *     the canvas doc (any operationLock entry with `userId === disconnected`).
 *
 * Independent of the user's manual `data.locked` (which Collab never
 * touches) and of the implicit `state === 'handling'` lock (handled
 * separately, see `HandlingActor`).
 */
export interface OperationLock {
  /** Tool id matching a row in `IMAGE_TOOLS` etc. */
  toolId: string;
  /** User who owns this lock; the only one allowed to remove it. */
  userId: string;
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

// ── Generative node helpers (v13) ─────────────────────────────────

/** Source node modality for references / chip snapshots. */
export type GenerativeRefSourceType = 'image' | 'video' | 'audio' | 'text' | 'generative';

/**
 * One row in a generative node's reference rail (spec §10.13.2 v13).
 *
 * The rail is the **single source of truth** for the node's incoming
 * edges: adding/removing a row also adds/removes the matching edge,
 * and connecting/disconnecting an edge syncs the rail. Display fields
 * (`sourceNodeName`, `thumbnail`) are *live* — they reflect the upstream
 * node as it currently is; if the user wants a frozen copy, they @-insert
 * the reference into the prompt, which captures a `ChipSnapshot`.
 */
export interface ReferenceItem {
  /** Stable id for this row; not the source node id. */
  refId: string;
  /** Upstream node currently connected to this slot. */
  sourceNodeId: string;
  sourceNodeType: GenerativeRefSourceType;
  /** Live name of the upstream node; updates as the upstream is renamed. */
  sourceNodeName: string;
  /** Live thumbnail / preview URL when available. */
  thumbnail?: string;
  /** When the row was added (epoch ms). */
  addedAt: number;
}

/**
 * Frozen snapshot of a reference at the moment the user @-inserts it
 * into the prompt (spec §10.13.2 v13). After capture the snapshot is
 * independent — renaming the upstream, deleting the reference rail
 * row, or even deleting the upstream node leaves the chip intact. The
 * `sourceNodeId` field is kept only for "jump to source" UX and the
 * delete-confirmation flow when a user removes the upstream.
 */
export interface ChipSnapshot {
  /** Unique id for this chip; each @-insertion produces a new id even when the source is the same. */
  chipId: string;
  /** Upstream node at capture time (may now be deleted/renamed; chip remains valid). */
  sourceNodeId: string;
  sourceNodeType: GenerativeRefSourceType;
  /** Frozen display name from the moment of capture. */
  snapshotName: string;
  snapshotThumbnail?: string;
  /** Frozen content excerpt at capture time (text body, URL, etc.). */
  snapshotContent?: string;
  /** When the snapshot was taken (epoch ms). */
  capturedAt: number;
}

/** One inline run in a {@link PromptDoc} — either plain text or an atomic chip. */
export type PromptInline =
  | { type: 'text'; text: string }
  | { type: 'chip'; attrs: ChipSnapshot };

/**
 * Serialized prompt body. At runtime stored as a Y.XmlFragment in the
 * generative node's data Y.Map under key `prompt` (so collaborators see
 * keystrokes via y-prosemirror). The plain shape mirrors the Tiptap /
 * ProseMirror document so the editor can render it directly. The F2
 * mockup uses a textarea and projects chips to plain `@name` text;
 * the full Tiptap implementation will preserve the inline-atom shape.
 */
export interface PromptDoc {
  type: 'doc';
  content: PromptInline[];
}

/**
 * Documents the keys on each node's Y.Map in the canvas document.
 *
 * Two node categories:
 *   - Generative: has outputType/kind/prompt/references/model/params; click execute → produces data node
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
    /**
     * User-driven manual lock (spec §10.13.6). Only the user UI can
     * toggle this; mini-tool operations and Collab `onDisconnect`
     * never touch it. When `true`, the node is undeletable and its
     * `content` is immutable.
     */
    locked: boolean;
    /**
     * Mini-tool configure-phase locks (spec §10.13.6.2 — added
     * 2026-05-11 in ADR `2026-05-11-mini-tool-state-machine.md`).
     * Each entry is `{ toolId, userId }`. Multiple entries can coexist
     * — one per (user, tool) pair — so two collaborators may simultaneously
     * configure different tools on the same node.
     *
     * Reading conventions:
     *   - Empty array (or undefined on older Yjs docs) = no operation lock
     *   - The `yMapToNode` adapter normalizes missing field to `[]`
     *
     * Authorization (enforced by writers, not type system):
     *   - Mini-tool `setActive`: push `{ toolId, userId: self }` iff not present
     *   - Mini-tool Apply/Cancel: remove entries matching `toolId + userId`
     *   - Collab `onDisconnect`: strip entries where `userId === disconnected`
     */
    operationLocks: OperationLock[];

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
    /**
     * Asset modality this generative node produces. Set once at creation;
     * never updated (changing modality means deleting + creating a new node).
     */
    outputType?: 'text' | 'image' | 'video' | 'audio';
    /**
     * Sub-task variant within an `outputType` (spec §10.13.1 v13).
     *  - image: 'text-to-image' / 'image-to-image'
     *  - audio: 'music' / 'tts' / 'melody' / 'ambient'
     *  - video / text / 3d: single kind, value still required for forward compat.
     */
    kind?: string;
    /** Rich text prompt — Y.XmlFragment at runtime (TipTap + y-prosemirror). */
    prompt?: unknown;
    /**
     * Reference rail rows — Y.Array of Y.Map at runtime, plain
     * {@link ReferenceItem}[] when read through `yMapToNode`. Mirrors the
     * node's incoming edges; see {@link ReferenceItem} for the bidirectional
     * sync rules.
     */
    references?: ReferenceItem[];
    /** Model id from config/models/*.yaml. */
    model?: string;
    /** Model-specific params (spec §10.13.2 v13). */
    params?: Record<string, unknown>;

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
