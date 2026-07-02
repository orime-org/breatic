// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Canvas node types shared between frontend, Collab, and server.
 *
 * Each project has one Yjs document containing nodesMap (Y.Map<nodeId, Y.Map>)
 * + edgesMap (Y.Map<edgeId, Y.Map>). Node state machine: 'idle' / 'handling'
 * (in Yjs); 'localPending' is local-only React state, never in Yjs.
 *
 * See the yjs-editor-redesign design spec (2026-04-26, 04-29 banner).
 */

/** Yjs-shared lifecycle. localPending is local-only and not represented here. */
export type NodeState = 'idle' | 'handling';

/**
 * Node modality — semantic names (replaced the legacy numeric codes
 * `'1001'..'1004'` on 2026-06-15). The 6 content modalities (text / image /
 * audio / video / 3d / web) own a renderable payload; `annotation` is a
 * collaboration sticky (text via `data.content`, author via `data.createdBy`);
 * `group` contains other nodes. There is no `generative` type — Generate is a
 * toolbar action on a content node, not a node type (model revision
 * 2026-06-15).
 */
export type NodeType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | '3d'
  | 'web'
  | 'annotation'
  | 'group';

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
 *
 * No display-name snapshot here (email-registration rewrite, 2026-06-06):
 * "who is handling" is rendered by looking up `meta.users[userId].name` in
 * the live Yjs awareness roster, which updates automatically when a user
 * renames themselves. Freezing a name onto the node would drift the moment
 * the user changed their display name.
 *
 * `startedAt` was added 2026-07-02 (#1569 handling lease): the epoch-ms
 * start of the fixed-budget lease. Disconnect events remain the fast path
 * (seconds), but events can be lost (collab restart, silently-crashed
 * driver) — the lease is the correctness guarantee: any handling node
 * older than {@link HANDLING_TIMEOUT_MS} is swept back to idle by the
 * collab sweeper regardless of what happened to its driver. No heartbeat
 * renewal by design: renewals written into Yjs would pollute the CRDT
 * history forever, so the budget is generous instead.
 */
export interface HandlingActor {
  userId: string;
  /** Who owns the handling → idle/error transition. See type-doc above. */
  type: 'frontend' | 'backend';
  /** Lease start (epoch ms); the fixed-budget timeout is measured from here. */
  startedAt: number;
}

/**
 * Unified fixed-budget handling lease (#1569, user decision 2026-07-02):
 * ONE hour for every handling operation (upload / AIGC / future frontend
 * media ops). The budget's job is to bound rare zombies (lost disconnect
 * events), not to fit per-operation durations — common cases are cleaned
 * in seconds by the disconnect fast path. Web (display-level timeout
 * fallback) and collab (sweeper) both import THIS constant so the two
 * sides can never drift.
 */
export const HANDLING_TIMEOUT_MS = 3_600_000;

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

// ── Content-node Generate helpers (references + prompt) ───────────

/** Source node modality for a content node's Generate references / chip snapshots. */
export type GenerativeRefSourceType = 'image' | 'video' | 'audio' | 'text';

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
 * One content-node model (model revision 2026-06-15): a content node
 * (text / image / audio / video / 3d / web) carries its payload
 * (content / coverUrl / etc.) AND its Generate inputs
 * (prompt / model / kind / references / params) — Generate is a toolbar
 * action, not a separate node type. `annotation` is a sticky; `group`
 * contains other nodes. All node types share the state machine and core
 * fields.
 */
export interface CanvasNodeFields {
  /** Stable node ID (frontend-generated UUID v4, immutable after creation). */
  id: string;
  /** Node modality — see {@link NodeType}. Semantic names (2026-06-15). */
  type: NodeType;
  /** Canvas coordinates. Y.Map { x, y } at runtime. */
  position: { x: number; y: number };
  /**
   * Containing Group id — set on a member node to bind it to its Group
   * (ReactFlow `parentId` convention). When present, `position` is relative
   * to that Group's top-left; absent for top-level nodes. Structural: it sits
   * alongside `position`, NOT inside `data` (which `toNodeView` narrows per
   * modality and would drop it). Added in the group redesign
   * (2026-06-23) — replaces the auto-container model where a group derived its
   * members from `data.childIds`.
   */
  parentId?: string;
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
    /** Video first-group thumbnail; equals `content` for image. */
    coverUrl?: string;
    /**
     * For image/video: intrinsic media pixel width. For a `group` (Group):
     * the Group's authoritative canvas width — its user-resizable footprint,
     * stored in Yjs (group redesign 2026-06-23; no longer derived from
     * the member bounding box).
     */
    width?: number;
    /**
     * For image/video: intrinsic media pixel height. For a `group` (Group):
     * the Group's authoritative canvas height. See {@link CanvasNodeFields} `data.width`.
     */
    height?: number;
    /** Video / audio duration in seconds. */
    duration?: number;
    /** Source node id when this data node was produced by a mini-tool from a parent node. */
    sourceNodeId?: string;
    /** Tool name when produced by mini-tool (e.g., 'image.crop'). */
    operation?: string;
    /** Tool input params when applicable. */
    operationParams?: Record<string, unknown>;

    // ─── Generate inputs (content nodes) ────────────────────
    // Generate is a toolbar action on a content node (model revision
    // 2026-06-15). kind / prompt / references / model / params are the
    // Generate panel's inputs, stored on the content node and shared via Yjs
    // so collaborators see edits live. There is no `outputType` — the content
    // node's own modality is its output.
    /**
     * Generate sub-mode — the variant picked in the Generate panel, one set
     * per content modality (e.g. audio: TTS / Song / SFX / Melody / Clone;
     * image: text-to-image / image-to-image). Stays a free `string`: the
     * valid set per modality is a frontend / `config/models` concern, not a
     * shape the wire contract should couple to the model catalog.
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
    /** Model-specific params for the Generate request. */
    params?: Record<string, unknown>;

    // ─── Group (Group) node fields ──────────────────────────
    // A Group's authoritative size lives in `width`/`height` above; its members
    // bind back via their own top-level `parentId` (group redesign
    // 2026-06-23 — there is no `childIds`; `parentId` is the single source).
    /** Group container tint when type === 'group' (model revision 2026-06-15). */
    backgroundColor?: string;

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
 * content / coverUrl / errorMessage / handlingBy / width / height /
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

// ── Edges ──────────────────────────────────────────────────────────
// Edges carry no shared wire data fields. `isPrimary` (the generative
// primary-downstream marker) was removed with the generative/asset split
// (model revision 2026-06-15); mini-tool lineage edges are plain
// source→target links. The frontend binding models edges locally.
