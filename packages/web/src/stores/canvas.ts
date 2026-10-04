// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { CanvasNodeFields, CanvasProposal } from '@breatic/shared';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type {
  DraftState,
  DraftTarget,
} from '@web/stores/annotation-draft';

/**
 * The box one sticky has open, and which of its entries it belongs to.
 *
 * Kept here rather than inside the node that draws it because the canvas runs
 * with `onlyRenderVisibleElements`: panning a sticky off screen unmounts its
 * DOM, and a draft held in that component went with it -- measured on a real
 * board, two screens away and back left the box closed and half a reply gone,
 * with nothing said about it. The node is still in the document the whole
 * time, so what the reader is writing has to outlive the element as well.
 *
 * Same reason the crop marquee's target sits in `CanvasSpace` rather than in
 * the node being cropped (#1782 adversarial round 8).
 */
export interface OpenAnnotationDraft {
  readonly draft: DraftState;
  readonly target: DraftTarget;
}

/**
 * A create intent posted by chrome for the canvas to fulfil.
 *
 * The mailbox exists because whoever asks has no viewport of its own: the
 * node-library button sits in chrome, and a proposal card sits in the chat
 * column. Both post what they want built and let the canvas decide where it
 * goes, so both travel this way -- one node type, or a whole wired group.
 */
export type CreateIntent = CanvasNodeFields['type'] | { proposal: CanvasProposal };

/**
 * Whether this intent is a group rather than a single node.
 *
 * The single-node path reads the intent as the node's type, so a proposal
 * arriving there would be read as a type string and silently dropped.
 * @param intent - What the mailbox holds.
 * @returns True when it carries a proposal.
 * @throws {never} Never.
 */
export function isProposalIntent(
  intent: CreateIntent,
): intent is { proposal: CanvasProposal } {
  return typeof intent !== 'string';
}

/**
 * A viewport command posted by the chrome zoom toolbar for the canvas to run
 * against ReactFlow. `'zoomIn'` / `'zoomOut'` step the zoom, `'fit'` frames all
 * nodes, and `{ zoomTo }` applies an absolute zoom (preset / custom input).
 */
export type ViewportCommand =
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | { readonly zoomTo: number };

/**
 * A canvas history command posted by the chrome viewport toolbar for the
 * canvas to run against its per-space `Y.UndoManager`. The toolbar's undo /
 * redo buttons live outside the ReactFlow provider (same boundary as zoom),
 * so they post here and the canvas consumes it.
 */
export type HistoryCommand = 'undo' | 'redo';

/**
 * What a canvas node-pick session wires when the user clicks a node:
 *   - `reference` — an i2i source edge (clicked → target) feeding the reference
 *     rail (a connection IS a reference).
 *   - `focus` — opens a crop marquee on the clicked image node (#1782); each
 *     confirmed crop uploads a standalone copy and APPENDS it to the target's
 *     `focusImages` (no edge, no source relationship). Continuous like
 *     reference — the user may crop several regions on the SAME node and
 *     across nodes — until manual Exit.
 *   - `firstFrame` — COPIES the clicked image node's asset URL into a video
 *     node's `firstFrameUrl` (#1896), the image-to-video first frame: a
 *     pick-time snapshot with NO relationship to the source node, then the
 *     session auto-exits (single slot, unlike the continuous reference pick).
 *   - `endFrame` — the same, into `endFrameUrl` (#1904): where the first-last
 *     frame mode ends. Independent of the first frame in every way — either
 *     one can be picked or replaced at any time, and only execute asks for
 *     both (user 2026-08-10).
 *   - `characterImage` — the same, into `characterImageUrl` (#1918): one
 *     picture of a person, for both modes that animate one — the figure
 *     image animation drives, and the portrait the talking head speaks with
 *     (#1935). Its own slot rather than the first frame's, though both travel
 *     as `image`, because a pick survives a mode switch and these two mean
 *     different things.
 *   - `drivingVideo` — the same, into `drivingVideo` (#1918), but from a
 *     VIDEO node: the performance whose motion is transferred onto the
 *     character. The first SLOT pick that takes something other than an image
 *     (`reference` has always taken any node the edge rules allow), so
 *     it copies the node's poster alongside the asset — the toolbar shows a
 *     pick with an `<img>` and a video URL would paint nothing.
 *   - `drivingAudio` — the same, into `drivingAudio` (#1935), but from an
 *     AUDIO node: the track the talking head's lips follow. Stored in the
 *     same one-field shape as `drivingVideo` for the same reason, though an
 *     audio node has no poster to copy, so the toolbar keeps showing the
 *     slot's icon.
 *   - `sourceVideo` / `leftAudio` / `rightAudio` — the same, into their own
 *     fields (#2156): the clip a lipsync model redoes, and the two speakers'
 *     tracks of a two-person talking head.
 *   - `refAudio` — the same, into `refAudio` (#1960 PR2), also from an AUDIO
 *     node: the voice a cloning model speaks the new lines in. Its own slot
 *     rather than `drivingAudio`'s, though both travel as `audio`, because
 *     the two are picked on different panels for different jobs and a pick
 *     survives a mode switch.
 *   - `musicSong` / `coverSong` / `musicMelody` / `musicVocal` — more of the
 *     same into their own slots (#1960, #2156), all from AUDIO nodes: the
 *     track a new song is written after, a song to cover, a melody, a
 *     singing voice. One per role because the vendor reads each under its own
 *     name and a user may give any combination of them.
 *   - `soundVideo` / `moodImage` — the picture a sound or a score follows,
 *     from a VIDEO node, and the picture music takes its mood from, from an
 *     IMAGE node (#2156).
 */
export type PickPurpose =
  | 'reference'
  | 'focus'
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'drivingAudio'
  | 'sourceVideo'
  | 'leftAudio'
  | 'rightAudio'
  | 'refAudio'
  | 'musicSong'
  | 'coverSong'
  | 'musicMelody'
  | 'musicVocal'
  | 'soundVideo'
  | 'moodImage'
  | 'style';

/**
 * An in-progress "pick a node from the canvas" session. Only one is active at a
 * time — the SAME interaction (click a node, continuous until Exit, locate,
 * dim non-candidates) with two completion targets discriminated by `purpose`.
 * One source of truth, never a second parallel field per purpose.
 */
export interface PickSession {
  /** The generative node the pick feeds (the pick target). */
  nodeId: string;
  /** What clicking a node wires — a reference edge, or a copied source. */
  purpose: PickPurpose;
  /**
   * How many files the slot being filled holds, for a slot holding several
   * (inner#826): the pick keeps going until the slot is full or the reader
   * exits. Absent for every one-file slot, whose pick ends on the first click.
   */
  capacity?: number;
}

/**
 * Canvas UI store — non-Yjs UI state for the canvas viewport.
 *
 * **Important**: real canvas data (nodes / edges / positions) lives in Yjs
 * via `data/yjs/canvas-space`. This store ONLY holds per-user UI state that
 * never needs to sync to collaborators: selection ids, hover, zoom level,
 * minimap visibility, lock-state overlay toggle, etc.
 *
 * It also carries the **chrome → canvas mailbox** (`pendingNodeCreate`): the
 * node-library button lives in chrome, outside the ReactFlow viewport, so it
 * cannot compute a drop point. It posts the *type* here; the canvas (which
 * owns the viewport) reads it, drops the node at the viewport centre, and
 * clears the mailbox via `consumePendingNodeCreate`.
 */
interface CanvasState {
  selectedNodeIds: string[];
  hoverNodeId: string | null;
  zoom: number;
  minimapVisible: boolean;
  /**
   * Snap-to-grid toggle: when on, ReactFlow rounds dragged node positions to the
   * grid (aligned to the visible background dots). Per-user viewport state kept
   * here so CanvasSpace can subscribe and feed ReactFlow's `snapToGrid` prop.
   */
  snapToGrid: boolean;
  showLockedOverlay: boolean;
  /** Chrome → canvas mailbox: what to create at the viewport centre. */
  pendingNodeCreate: CreateIntent | null;
  /**
   * Whether a canvas is mounted and reading the mailbox.
   *
   * A proposal card sits in the chat column, which is beside the canvas, not
   * inside it: without this it would post into a mailbox nobody is holding and
   * the reader would press a button that silently did nothing. Asking the
   * canvas rather than reading which space is open keeps the chat column out
   * of the space state entirely -- what it needs to know is whether anyone is
   * listening, and only the listener can answer that.
   */
  canvasListening: boolean;
  /**
   * What became of the proposal just posted, for the card that posted it.
   *
   * Cleared as the card reads it. Untagged because it cannot be ambiguous:
   * placing runs to completion inside one synchronous effect, so a second card
   * cannot have posted in between.
   */
  proposalOutcome: 'placed' | 'failed' | null;
  /**
   * Chrome → canvas mailbox: files picked from the left "upload assets" button
   * for the canvas to turn into nodes at the viewport centre. The picker lives
   * in chrome (it must open synchronously inside the button's click to keep the
   * browser's user-activation), so it posts the `File[]` here and the canvas
   * (which owns the viewport + Yjs writes) fulfils them.
   */
  pendingUploadFiles: File[] | null;
  /** Chrome → canvas mailbox: a zoom-toolbar command for the canvas to run. */
  pendingViewportCommand: ViewportCommand | null;
  /** Chrome → canvas mailbox: an undo/redo command for the canvas to run. */
  pendingHistoryCommand: HistoryCommand | null;
  /** Canvas-internal mailbox: a node / group id the menu asked to inline-rename. */
  pendingRename: string | null;
  /** Canvas → chrome mirror: whether an undo is currently available. */
  canUndo: boolean;
  /** Canvas → chrome mirror: whether a redo is currently available. */
  canRedo: boolean;
  setSelectedNodeIds: (ids: string[]) => void;
  addSelectedNodeId: (id: string) => void;
  clearSelection: () => void;
  setHoverNodeId: (id: string | null) => void;
  setZoom: (zoom: number) => void;
  setMinimapVisible: (visible: boolean) => void;
  toggleMinimap: () => void;
  setSnapToGrid: (enabled: boolean) => void;
  toggleSnapToGrid: () => void;
  setShowLockedOverlay: (show: boolean) => void;
  /** Post a create intent (node-library pick, or an accepted proposal). */
  requestNodeCreate: (intent: CreateIntent) => void;
  /** Say whether a canvas is holding the mailbox (the canvas, on mount / unmount). */
  setCanvasListening: (listening: boolean) => void;
  /** Report what became of a placed proposal (the canvas). */
  reportProposalOutcome: (outcome: 'placed' | 'failed') => void;
  /** Drop the outcome once the card that posted has read it. */
  clearProposalOutcome: () => void;
  /** Clear the mailbox once the canvas has fulfilled the intent. */
  consumePendingNodeCreate: () => void;
  /** Post picked upload files from chrome (left "upload assets" button). */
  requestUpload: (files: File[]) => void;
  /** Clear the upload mailbox once the canvas has fulfilled it. */
  consumePendingUpload: () => void;
  /** Post a viewport command from the chrome zoom toolbar. */
  requestViewportCommand: (command: ViewportCommand) => void;
  /** Clear the mailbox once the canvas has run the command. */
  consumeViewportCommand: () => void;
  /** Post an undo/redo command from the chrome viewport toolbar. */
  requestHistoryCommand: (command: HistoryCommand) => void;
  /** Clear the mailbox once the canvas has run the history command. */
  consumeHistoryCommand: () => void;
  /** Post a request to inline-rename a node / group (from the right-click menu). */
  requestRename: (nodeId: string) => void;
  /** Clear the rename mailbox once the node / group has entered edit mode. */
  consumePendingRename: () => void;
  /** Mirror the canvas undo manager's availability flags for the toolbar. */
  setHistoryAvailability: (canUndo: boolean, canRedo: boolean) => void;
  /**
   * Reset the per-project canvas SESSION state to fresh (leaving a project must
   * not carry its open panel / pick mode / selection into the next entry, #1771).
   * Viewport PREFERENCES (`minimapVisible`, `snapToGrid`, `zoom`) are kept — they
   * are "how I like my canvas", not "what I was doing in this project"; `zoom`
   * re-syncs from the mounting canvas anyway.
   */
  reset: () => void;
}


export const useCanvasStore = create<CanvasState>()(
  immer((set) => ({
    selectedNodeIds: [],
    hoverNodeId: null,
    zoom: 1,
    // The built minimap ships on (#1548) — one toolbar click turns it off.
    minimapVisible: true,
    // Snap-to-grid ships OFF — free placement is the default, snapping is opt-in.
    snapToGrid: false,
    showLockedOverlay: false,
    pendingNodeCreate: null,
    canvasListening: false,
    proposalOutcome: null,
    pendingUploadFiles: null,
    pendingViewportCommand: null,
    pendingHistoryCommand: null,
    pendingRename: null,
    canUndo: false,
    canRedo: false,
    setSelectedNodeIds: (ids) =>
      set((s) => {
        s.selectedNodeIds = ids;
      }),
    addSelectedNodeId: (id) =>
      set((s) => {
        if (!s.selectedNodeIds.includes(id)) s.selectedNodeIds.push(id);
      }),
    clearSelection: () =>
      set((s) => {
        s.selectedNodeIds = [];
      }),
    setHoverNodeId: (id) =>
      set((s) => {
        s.hoverNodeId = id;
      }),
    setZoom: (zoom) =>
      set((s) => {
        s.zoom = zoom;
      }),
    setMinimapVisible: (visible) =>
      set((s) => {
        s.minimapVisible = visible;
      }),
    toggleMinimap: () =>
      set((s) => {
        s.minimapVisible = !s.minimapVisible;
      }),
    setSnapToGrid: (enabled) =>
      set((s) => {
        s.snapToGrid = enabled;
      }),
    toggleSnapToGrid: () =>
      set((s) => {
        s.snapToGrid = !s.snapToGrid;
      }),
    setShowLockedOverlay: (show) =>
      set((s) => {
        s.showLockedOverlay = show;
      }),
    requestNodeCreate: (intent) =>
      set((s) => {
        s.pendingNodeCreate = intent;
      }),
    setCanvasListening: (listening) =>
      set((s) => {
        s.canvasListening = listening;
      }),
    reportProposalOutcome: (outcome) =>
      set((s) => {
        s.proposalOutcome = outcome;
      }),
    clearProposalOutcome: () =>
      set((s) => {
        s.proposalOutcome = null;
      }),
    consumePendingNodeCreate: () =>
      set((s) => {
        s.pendingNodeCreate = null;
      }),
    requestRename: (nodeId) =>
      set((s) => {
        s.pendingRename = nodeId;
      }),
    consumePendingRename: () =>
      set((s) => {
        s.pendingRename = null;
      }),
    requestUpload: (files) =>
      set((s) => {
        s.pendingUploadFiles = files;
      }),
    consumePendingUpload: () =>
      set((s) => {
        s.pendingUploadFiles = null;
      }),
    requestViewportCommand: (command) =>
      set((s) => {
        s.pendingViewportCommand = command;
      }),
    consumeViewportCommand: () =>
      set((s) => {
        s.pendingViewportCommand = null;
      }),
    requestHistoryCommand: (command) =>
      set((s) => {
        s.pendingHistoryCommand = command;
      }),
    consumeHistoryCommand: () =>
      set((s) => {
        s.pendingHistoryCommand = null;
      }),
    setHistoryAvailability: (canUndo, canRedo) =>
      set((s) => {
        s.canUndo = canUndo;
        s.canRedo = canRedo;
      }),
    reset: () =>
      set((s) => {
        s.selectedNodeIds = [];
        s.hoverNodeId = null;
        s.showLockedOverlay = false;
        s.pendingNodeCreate = null;
        s.pendingUploadFiles = null;
        s.pendingViewportCommand = null;
        s.pendingHistoryCommand = null;
        s.pendingRename = null;
        s.canUndo = false;
        s.canRedo = false;
        // `minimapVisible` / `snapToGrid` / `zoom` are viewport preferences, not
        // session state — deliberately NOT reset here (see the interface doc).
      }),
  })),
);
