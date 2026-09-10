// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas node types shared between frontend, Collab, and server.
 *
 * Each project has one Yjs document containing nodesMap (Y.Map<nodeId, Y.Map>)
 * + edgesMap (Y.Map<edgeId, Y.Map>). A node carries no state of its own: what
 * it shows is derived from its four task counts and `errorMessage` (#186).
 */

/**
 * Top-level key of the canvas document's node map.
 *
 * Every process that reaches into a canvas document reads it through this
 * name, so a reader and a writer cannot end up on two different maps: the
 * browser writes the nodes, collab writes what the server recounted, and a
 * mismatch between them is invisible — the reader finds no node and silently
 * leaves it alone.
 */
export const CANVAS_NODES_KEY = 'nodesMap';

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
 * The modalities that offer Generate — image and video (#1896), audio
 * (#1960). Text is planned (#1778) but not built, so it stays out: a node
 * created while this said yes would carry a prompt container forever after,
 * and the menu item would open nothing.
 *
 * That container is also why an audio node created before #1960 has none:
 * seeding happens at creation and nothing backfills, so those nodes have no
 * prompt to type into and the panel says so rather than showing an editor
 * whose text goes nowhere.
 *
 * This list IS the product decision. `canGenerate` reads it rather than
 * comparing against literals, so its body answers the question its name asks
 * and another modality is one more entry here rather than another clause
 * somewhere.
 */
const GENERATIVE_MODALITIES: readonly NodeType[] = ['image', 'video', 'audio'];

/**
 * Whether a node of this modality offers Generate.
 *
 * Two places must agree on this — the canvas gates the Generate menu item on
 * it, and node creation seeds a prompt container only for nodes that can use
 * one — so it lives here, the one package both of them sit above.
 *
 * It answers ONLY whether a modality generates. **It never says which panel
 * opens**, even though image and video have separate panels (user 2026-08-08):
 * this package is shared with the backend and must not know what a frontend
 * panel is, and the consumer that seeds prompt containers does not care which
 * one would open. That routing lives in the panel opener, which takes the node
 * type and decides there.
 * @param type - The node's modality.
 * @returns True when a node of this modality offers Generate.
 */
export function canGenerate(type: NodeType): boolean {
  return GENERATIVE_MODALITIES.includes(type);
}

/**
 * Attachment reference stored in a node's `attachments` array — a plain
 * array value on the data Y.Map (node data holds plain values only, see
 * the web `buildDataMap`).
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
 * One focus crop stored in a node's `focusImages` Y.Array (#1782 focus
 * slice) — a standalone image cropped out of a source node's content at
 * creation time.
 *
 * COPY semantics (user decision 2026-07-16, mirroring `styleImageUrl`):
 * the crop is uploaded as its own asset and keeps ZERO relationship to
 * the node it was cropped from — deleting, renaming, or regenerating the
 * source never changes an existing focus image. `name` is a snapshot of
 * the source node's display name at crop time and never follows renames.
 * Frontend-owned; the backend never reads or writes this field — focus
 * images only reach a generate request when the user `@`-mentions them
 * (same explicit-selection rule as node references).
 */
export interface FocusImage {
  /** Stable id (frontend-generated UUID v4); `@` mentions reference it. */
  id: string;
  /** Public URL of the uploaded crop asset. */
  url: string;
  /** Source node display name snapshotted at crop time (raw, no suffix). */
  name: string;
  /** Crop width in natural (source-resolution) pixels. */
  width: number;
  /** Crop height in natural (source-resolution) pixels. */
  height: number;
}

// ── Content-node Generate: references + prompt ───────────
//
// The generative node's reference rail is NOT a stored field. A connection is
// a reference (a canvas edge `source → target` means `source` is a reference
// input for `target`), so the rail is derived live from the node's incoming
// edges — single source of truth = the edges map, zero drift (see the web
// `deriveReferences` helper). The prompt is stored as an opaque `Y.XmlFragment`
// (`data.prompt`, typed `unknown` on the wire). Its structured shape is a
// FRONTEND rendering concern that never crossed this boundary: the backend
// only ever reads the prompt as plain text via `extractPromptText`, never the
// chip structure. (Web once carried a `prompt-types` module describing that
// shape; it had no consumers and was deleted in #1952 — the live chip
// attributes are the ones on `reference-mention.tsx`.)
//
// ── Text-node body ───────────────────────────────────────
//
// A text node's words live in `data.body`, an opaque `Y.XmlFragment` seeded
// when the node is created, so two people typing in one node merge character
// by character instead of overwriting each other. It is absent from the
// interface below for the same reason `prompt` carries no structured type:
// this package has no yjs dependency (it must stay browser-safe and bundles
// through a single entry), and a live collaborative object is not wire data.
// Read it through the web helpers `getTextBody` / `bodyToPlainText`.
//
// `content` below is dead for a text node: nothing writes it (a landing task
// puts its words in the body instead) and nothing reads it (the view
// projection omits it for text, the clipboard reads the body). Nodes older
// than this feature still carry a value there, and it stays unread — before
// launch we do not serve legacy data.

/**
 * Documents the keys on each node's Y.Map in the canvas document.
 *
 * One content-node model (model revision 2026-06-15): a content node
 * (text / image / audio / video / 3d / web) carries its payload
 * (content / coverUrl / etc.) AND its Generate inputs
 * (prompt / model / mode / references / param records) — Generate is a toolbar
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
     * User-driven manual lock (spec §10.13.6). Only the user UI toggles
     * this; no server-side path writes it. When `true`, the node is
     * undeletable and its `content` is immutable.
     */
    locked: boolean;

    // ─── Tasks (all node types) ─────────────────────────────
    /** Last failure message from whatever wrote this node's content. */
    errorMessage?: string;
    /**
     * How many tasks this node carries in each state (#186) — the whole of
     * what the document says about them. The server recounts after every
     * change and collab replaces this object; there are no entries, no ids
     * and no increments here, so nothing can be applied to the wrong row.
     *
     * Absent on a node no task has ever touched, which reads as four zeros.
     * The details behind these numbers live in the `node_tasks` table and
     * reach the browser only when somebody opens the task list.
     */
    taskCounts?: NodeTaskCounts;

    // ─── Data node fields ───────────────────────────────────
    /**
     * Primary result: URL (image/video/audio/3D) or text (web). Retired for a
     * text node — neither written nor read there since #1774; its words are in
     * `data.body` (see the note above).
     */
    content?: string;
    /**
     * Video poster (first-frame thumbnail). Video-only: image renders
     * `content` directly and audio has no cover, so neither ever carries this
     * field — writing it onto them creates a phantom asset-GC reference (#1619).
     */
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
    // 2026-06-15). mode / prompt / model / param records are the Generate panel's
    // inputs, stored on the content node and shared via Yjs so collaborators
    // see edits live. There is no `outputType` — the content node's own
    // modality is its output. The reference rail is NOT stored here — it is
    // derived live from the node's incoming edges (a connection = a reference).
    /**
     * Generation sub-mode — the input variant picked in the Generate panel,
     * with ONE value set per node modality:
     *   - image: `'t2i'` (text-to-image) / `'i2i'` (image-to-image)
     *   - audio (future): e.g. TTS / Song / SFX / Melody / Clone
     *   - video (future): its own generation variants
     * Set by the Generate panel's manual toggle. Drives which catalog models
     * the picker offers and (image) whether references are enabled. Stays a
     * free `string`: the wire contract is modality-neutral and must NOT couple
     * to the per-modality valid set — that narrowing (e.g. web's `ImageGenMode`
     * = `'t2i' | 'i2i'`) is a frontend / `config/models` concern. Distinct from
     * top-level `type` (the node's content modality): `mode` is the sub-mode
     * WITHIN that modality's generation. (Replaced the earlier `data.kind`
     * sub-mode field, whose name clashed with the view discriminant — cleanup
     * 2026-07-09.)
     */
    mode?: string;
    /** Rich text prompt — Y.XmlFragment at runtime (TipTap + y-prosemirror). */
    prompt?: unknown;
    /** Model id from config/models/*.yaml. */
    model?: string;
    /**
     * Per-mode memory of the last-chosen model name, keyed by the generation
     * sub-mode (image: `t2i` / `i2i`), so toggling between modes restores the
     * model the user last picked for that mode (falling back to the first
     * available one otherwise).
     */
    modelByMode?: Record<string, string>;
    /**
     * Per-model params, keyed by model id (#1948). Each record holds exactly
     * that model's declared param set, so selecting a model restores what it
     * was left at and a model used for the first time starts from its own
     * defaults. Values never travel between two models' records — which is
     * what keeps a mode switch from handing the outgoing model's settings to
     * the incoming one.
     *
     * The only place the panel's param CONTROLS write to: what the panel has
     * in effect is resolved from these on every render, so there is no second
     * field to keep in step. Three keys a model may also declare under
     * `params` are not among them and live elsewhere on the node or on the
     * prompt — `prompt`, `images` (the reference rail) and `style_images`
     * (`data.styleImageUrl`); the execute payload spreads the records first
     * and then overwrites those three. A node written before #1948 carries no
     * records and gets none — Yjs data from before launch gets no
     * compatibility handling (user 2026-08-15).
     */
    paramsByModel?: Record<string, Record<string, unknown>>;
    /**
     * Style-reference image URL (image-node style slice, #1664) — a COPY of
     * the picked image's asset URL, snapshotted at pick time (user decision
     * 2026-07-16: one style image max; stored as a copy, NO relationship to
     * the upstream node — deleting or regenerating the source never changes
     * this snapshot; assets are never deleted, so the URL stays valid).
     * Frontend-owned like `model` / `paramsByModel` — the worker never writes it; at
     * execute time the frontend sends it as `params.style_images` when the
     * active model supports style references. Distinct from i2i source images
     * (edges → the reference rail): style guides aesthetics and survives
     * text-to-image. Scalar last-write-wins. Absent = none picked.
     */
    styleImageUrl?: string;
    /**
     * First-frame image URL for a video node's image-to-video generation
     * (#1896) — a pick-time COPY of the clicked image's URL, on the same
     * terms as `styleImageUrl`: no relationship to the node it came from, so
     * deleting or regenerating that node leaves this one alone. The video
     * panel renders it in its first-frame slot and sends it as `params.image`
     * at execute time, which is what the backend source gate reads for `i2v`.
     *
     * A slot, not a reference: the reference rail is derived from edges and
     * feeds the prompt's `@` mentions, while this is one image with one
     * meaning to the model. Scalar last-write-wins. Absent = none picked.
     */
    firstFrameUrl?: string;
    /**
     * End-frame image URL for the first-last frame mode (#1904, wire
     * `data.endFrameUrl`) — a pick-time COPY on the same terms as
     * `firstFrameUrl`, sent as `params.end_image` at execute time.
     *
     * Independent of the first frame: either can be picked or replaced at any
     * time and neither waits for the other, because only execute asks for both
     * (user 2026-08-10). It stays on the node across a mode switch, and the
     * payload simply does not build it under a mode that has no end frame.
     */
    endFrameUrl?: string;
    /**
     * Character image URL for the modes that animate a person — image
     * animation (#1918) and the talking head (#1935) — wire
     * `data.characterImageUrl`. A pick-time COPY on the same terms as
     * `firstFrameUrl`, sent as `params.image` at execute time. One slot for
     * both because both want the same thing of it: one picture of a person.
     *
     * Its own field although it travels under the same param as the first
     * frame: a pick survives a mode switch, so one shared field would turn
     * the frame chosen for image-to-video into the figure animation drives.
     */
    characterImageUrl?: string;
    /**
     * The driving video for the image-animation mode (#1918, wire
     * `data.drivingVideo`) — the performance whose motion is transferred onto
     * the character. `url` is sent as `params.video` at execute time; `cover`
     * is the poster copied from the picked node at the same moment, ours to
     * show and never sent upstream (the toolbar draws a filled slot with an
     * `<img>`, and a video URL there paints nothing at all).
     *
     * Both inside ONE field on purpose: two fields are two independent
     * last-writer-wins registers, so two clients picking at once converge
     * per-field and one client's video can end up wearing the other's poster.
     */
    drivingVideo?: { url: string; cover?: string };
    /**
     * Reference-to-video's motion guidance (`data.referenceVideo`) — the one
     * clip whose movement the vendor follows, sent as `params.video` (#1928).
     *
     * Its own field rather than `drivingVideo`'s: image animation needs a
     * driving video to run at all, this one is optional guidance alongside
     * reference images, and a user moving between the two modes keeps each
     * pick where it was.
     */
    referenceVideo?: { url: string; cover?: string };
    /**
     * The driving audio for the talking-head mode (#1935, wire
     * `data.drivingAudio`) — the track the portrait's lips follow. `url` is
     * sent as `params.audio` at execute time.
     *
     * Shaped like `drivingVideo` above because it travels the same road: a
     * slot taking anything other than an image keeps its poster beside the
     * asset, in one field, for the same convergence reason. `cover` is always
     * absent here — an audio node carries no poster of its own — which leaves
     * the toolbar showing the slot's icon, the way every small row in the
     * product shows audio.
     */
    drivingAudio?: { url: string; cover?: string };
    /**
     * The voice to clone for the audio panel's voice-cloning mode (#1960 PR2,
     * wire `data.refAudio`) — the recording whose timbre the new lines are
     * spoken in. `url` is sent as `params.audio` at execute time.
     *
     * Its own field although it travels under the same param as
     * `drivingAudio`: a pick survives a mode switch, and these two are picked
     * on different panels for different jobs — one shared field would turn the
     * track a portrait's lips follow into the voice a line is spoken in.
     *
     * Shaped like `drivingAudio` for the same convergence reason, and `cover`
     * is likewise always absent, leaving the toolbar showing the slot's icon.
     */
    refAudio?: { url: string; cover?: string };
    /**
     * The three references the audio panel's reference-to-music mode collects
     * (#1960, wire `data.musicSong` / `musicVoice` / `musicInstrumental`) —
     * a whole song to write after, a vocal line to follow, a backing track to
     * play over. Their `url`s are sent as `params.song` / `voice` /
     * `instrumental`, the names minimax/music-01 reads them under.
     *
     * Three fields rather than one list because the vendor gives each its own
     * role and a user may supply any combination. Shaped like `refAudio` for
     * the same convergence reason, and `cover` is likewise always absent.
     */
    musicSong?: { url: string; cover?: string };
    musicVoice?: { url: string; cover?: string };
    musicInstrumental?: { url: string; cover?: string };
    /**
     * The words to sing, on an audio node (#1960, wire `data.lyrics`) — a
     * `Y.XmlFragment` beside `prompt`, since two people may write lyrics at
     * once the way they may write a prompt at once.
     *
     * `unknown` for the same reason `prompt` is: the wire shape describes what
     * the key holds, and a CRDT fragment has no plain-JSON form to state here.
     */
    lyrics?: unknown;
    /**
     * Focus crops created on this node's generate panel (#1782) — maintained
     * in the doc as a `Y.Array` CRDT SEQUENCE (the one exception to the
     * plain-values convention of the web `buildDataMap`): concurrent appends
     * from two collaborators BOTH survive the merge and the ✕ deletes its
     * target in place, commuting with concurrent edits — a whole-array LWW
     * value silently dropped the loser's crop with its asset already
     * uploaded (design adversary 2026-07-17). The container is eager-seeded
     * empty at node birth (lazy creation is itself a whole-container LWW
     * race); a plain-array value (a pre-encoding doc / forged wire) is
     * converted on its first write. This WIRE type is unchanged either way:
     * `toJSON()` serializes both encodings to the same plain array, and the
     * backend never reads or writes the field. See {@link FocusImage} for
     * the copy semantics. Empty / absent = none created.
     */
    focusImages?: FocusImage[];

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

/** The four numbers a node shows about its tasks. */
export interface NodeTaskCounts {
  running: number;
  done: number;
  failed: number;
  expired: number;
}

/**
 * The five content fields a finished task writes onto its node.
 *
 * Every producer sends `null` for the last three today, and the node reads its
 * pixel size and its duration out of the DOM once the media has loaded. They
 * are on the wire because the measurement they will carry is taken where the
 * bytes are — at the edge, on the way into R2 — and every lane already passes
 * through that one point; filling them is task #209.
 */
export interface NodeTaskResult {
  content: string;
  coverUrl: string | null;
  /** Intrinsic pixel width of an image or video. */
  width: number | null;
  /** Intrinsic pixel height of an image or video. */
  height: number | null;
  /** Playing time of a video or audio, in seconds. */
  duration: number | null;
}

/**
 * The server recounted a node's tasks (#186).
 *
 * One event type covers every state change, because the document holds only
 * the four counts: which task moved is not on the wire, so nothing here can
 * be applied to the wrong row. Repeating an event lands the same numbers.
 *
 * `result` rides on the transition that reached `done` and on no other, so a
 * task judged expired before its report arrived leaves the node's content
 * alone — the user may already have retried, and choosing for them is not
 * ours to do. Its result is still reachable from the task list.
 */
export interface NodeTaskCountsEvent {
  type: 'node-task-counts';
  /** Yjs doc name, `project-{projectId}/canvas-{spaceId}`. */
  docName: string;
  /** The node whose counts these are. */
  nodeId: string;
  /** All four, freshly counted from the table. */
  counts: NodeTaskCounts;
  /** Present only on the transition into `done`. */
  result?: NodeTaskResult;
}

/** Single union for forward-compat. */
export type NodeEvent = NodeTaskCountsEvent;

// ── Edges ──────────────────────────────────────────────────────────
// Edges carry no shared wire data fields. `isPrimary` (the generative
// primary-downstream marker) was removed with the generative/asset split
// (model revision 2026-06-15); mini-tool lineage edges are plain
// source→target links. The frontend binding models edges locally.
