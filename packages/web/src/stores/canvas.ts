// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { CanvasNodeFields, CanvasProposal, NodeType } from '@breatic/shared';
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
 *   - `style` — COPIES the clicked image node's asset URL into the target's
 *     `styleImageUrl` (image-node style slice #1664, one style image max): a
 *     pick-time snapshot with NO relationship to the source node, then the
 *     session auto-exits (single slot, unlike the continuous reference pick).
 *   - `focus` — opens a crop marquee on the clicked image node (#1782); each
 *     confirmed crop uploads a standalone copy and APPENDS it to the target's
 *     `focusImages` (no edge, no source relationship). Continuous like
 *     reference — the user may crop several regions on the SAME node and
 *     across nodes — until manual Exit.
 *   - `firstFrame` — COPIES the clicked image node's asset URL into a video
 *     node's `firstFrameUrl` (#1896), the image-to-video first frame. Same
 *     copy semantics and same single-slot auto-exit as `style`; they differ
 *     only in which field they fill and what it means to the model.
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
 *   - `refAudio` — the same, into `refAudio` (#1960 PR2), also from an AUDIO
 *     node: the voice a cloning model speaks the new lines in. Its own slot
 *     rather than `drivingAudio`'s, though both travel as `audio`, because
 *     the two are picked on different panels for different jobs and a pick
 *     survives a mode switch.
 *   - `musicSong` / `musicVoice` / `musicInstrumental` — three more of the
 *     same into their own slots (#1960), all from AUDIO nodes: the track a
 *     new song is written after, a vocal line to follow, a backing track to
 *     play over. Three rather than one because the vendor reads each under
 *     its own name and a user may give any combination of them.
 */
export type PickPurpose =
  | 'reference'
  | 'style'
  | 'focus'
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'referenceVideo'
  | 'drivingAudio'
  | 'refAudio'
  | 'musicSong'
  | 'musicVoice'
  | 'musicInstrumental';

/**
 * An in-progress "pick a node from the canvas" session. Only one is active at a
 * time — the SAME interaction (click a node, continuous until Exit, locate,
 * dim non-candidates) with two completion targets discriminated by `purpose`.
 * One source of truth, never a second parallel field per purpose.
 */
export interface PickSession {
  /** The generative node the pick feeds (the pick target). */
  nodeId: string;
  /** What clicking a node wires — a reference edge, or a style source. */
  purpose: PickPurpose;
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
   * Whether the annotation tool is armed: the left menu's comment button was
   * pressed and the next canvas click says where the note goes (#1881 §6.4).
   *
   * A flag rather than a mailbox, because nothing travels — the canvas needs
   * to know the tool is up, and the click it is waiting for carries the only
   * payload there is. Nothing reaches Yjs until the note's first words do.
   */
  placingAnnotation: boolean;
  /**
   * The box each sticky has open, by node id. Empty is the ordinary case.
   * @see OpenAnnotationDraft
   */
  annotationDrafts: Record<string, OpenAnnotationDraft>;
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
  /**
   * Per-user node panel host: the node id whose bottom-anchored panel (Generate,
   * reset-empty-image, or node-history) is open for THIS user, or null. Local UI
   * only (never Yjs) — one collaborator opening a panel must not open it for
   * others. These panels share one host + one lifecycle and are mutually
   * exclusive (only one is ever open); `panelKind` picks which body renders. The
   * panel's collaborative content (Generate's prompt / model / params /
   * references) lives on the node itself.
   */
  panelHostId: string | null;
  /**
   * Which panel is open on `panelHostId` (null when no panel is open). A single
   * host + kind is the correct abstraction for N mutually-exclusive node-
   * anchored panels — cheaper and inherently exclusive versus parallel states.
   */
  panelKind:
    | 'generate'
    | 'generateVideo'
    | 'generateAudio'
    | 'resetEmpty'
    | 'history'
    | 'tasks'
    | 'annotation'
    | null;
  /**
   * Which of a node's four task states the open list is showing (#186 §7.1),
   * null whenever the task list is not the open panel.
   *
   * The list answers one state at a time, so which one was asked for belongs
   * beside the host rather than inside the panel: the counts column outside
   * the node reads it to show which of its four buttons is pressed.
   */
  taskPanelStatus: 'running' | 'done' | 'failed' | 'expired' | null;
  /**
   * The in-progress canvas node-pick session (reference or style), or null.
   * When set, the canvas is in pick mode for `pickSession.nodeId`: clicking
   * another node wires the pick per `pickSession.purpose`, staying in the
   * session (continuous select) until Exit. Local UI only (never Yjs).
   */
  pickSession: PickSession | null;
  /**
   * Focus crops whose upload is still in flight (#1782) — local rail
   * placeholders only (never Yjs): the FocusImage copy is written to the
   * node only once the upload succeeds; a failure just drops the entry.
   */
  pendingFocusUploads: Array<{ id: string; nodeId: string; name: string }>;
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
  /**
   * Set or drop the box a sticky has open. Passing null forgets that sticky.
   * @see OpenAnnotationDraft
   */
  setAnnotationDraft: (nodeId: string, open: OpenAnnotationDraft | null) => void;
  /** Forget every open box whose sticky is no longer on the canvas. */
  /** Arm the annotation tool — chrome pressed the comment button. */
  startAnnotationPlacement: () => void;
  /** Disarm it: the note was placed, Escape was pressed, or the Space changed. */
  endAnnotationPlacement: () => void;
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
   * Open the Generate panel for a node (replaces any currently open panel).
   *
   * Image, video and audio have separate panels (#1896, #1960), and this
   * decides which one from the node's modality so callers never have to know
   * how many exist: adding text generation (#1778) is one more case here, not
   * a branch at every call site.
   */
  openGeneratePanel: (nodeId: string, type: NodeType) => void;
  /** Open the reset-empty-image panel for a node (replaces any open panel). */
  openEmptyImagePanel: (nodeId: string) => void;
  /** Open the node-history panel for a node (#1619, replaces any open panel). */
  openHistoryPanel: (nodeId: string) => void;
  /**
   * Open one state's task list for a node (#186 §7.1, replaces any open
   * panel). Calling it again with another state re-asks the same panel.
   */
  openTaskPanel: (
    nodeId: string,
    status: 'running' | 'done' | 'failed' | 'expired',
  ) => void;
  /**
   * Expand one annotation's sticky (#1881 §8.7.3, replaces any open panel).
   *
   * The fifth node-anchored panel in the same exclusive slot, and the reason
   * "one sticky open at a time" needs no rule of its own. Local only: which
   * note this reader has open never goes into the document.
   */
  openAnnotationPanel: (nodeId: string) => void;
  /** Close whichever bottom panel is open (exit button, or execute hands off). */
  closeActivePanel: () => void;
  /** Enter a REFERENCE pick (wires i2i source edges) for a generative node. */
  startReferencePick: (nodeId: string) => void;
  /** Enter a STYLE pick (#1664, copies one image URL into the slot) for a generative node. */
  startStylePick: (nodeId: string) => void;
  /** Enter the first-frame pick for a video node (#1896). */
  startFirstFramePick: (nodeId: string) => void;
  /** Enter the end-frame pick for a video node (#1904). */
  startEndFramePick: (nodeId: string) => void;
  /** Enter the character-image pick for a video node (#1918). */
  startCharacterImagePick: (nodeId: string) => void;
  /** Enter the driving-video pick for a video node (#1918). */
  startDrivingVideoPick: (nodeId: string) => void;
  /** Enter the reference-video pick for a video node (#1928). */
  startReferenceVideoPick: (nodeId: string) => void;
  /** Enter the driving-audio pick for a video node (#1935). */
  startDrivingAudioPick: (nodeId: string) => void;
  /** Enter the reference-audio pick for an audio node (#1960 PR2). */
  startRefAudioPick: (nodeId: string) => void;
  /** Enter the whole-song reference pick for an audio node (#1960). */
  startMusicSongPick: (nodeId: string) => void;
  /** Enter the vocal-line reference pick for an audio node (#1960). */
  startMusicVoicePick: (nodeId: string) => void;
  /** Enter the backing-track reference pick for an audio node (#1960). */
  startMusicInstrumentalPick: (nodeId: string) => void;
  /** Enter a FOCUS pick (#1782, crop marquee → focusImages append) for a generative node. */
  startFocusPick: (nodeId: string) => void;
  /** Add a rail placeholder for an in-flight focus-crop upload (#1782). */
  addPendingFocusUpload: (entry: { id: string; nodeId: string; name: string }) => void;
  /** Drop a focus-upload placeholder (success wrote Yjs, or failure toasted). */
  removePendingFocusUpload: (id: string) => void;
  /** Exit the current pick session (after a node is picked, or on cancel). */
  endPick: () => void;
  /**
   * Reset the per-project canvas SESSION state to fresh (leaving a project must
   * not carry its open panel / pick mode / selection into the next entry, #1771).
   * Viewport PREFERENCES (`minimapVisible`, `snapToGrid`, `zoom`) are kept — they
   * are "how I like my canvas", not "what I was doing in this project"; `zoom`
   * re-syncs from the mounting canvas anyway.
   */
  reset: () => void;
}

/**
 * Which Generate panel a modality opens (#1896, #1960). Image, video and audio
 * each have their own panel, so this map — not the call site — decides which
 * body renders.
 *
 * It is deliberately partial: a modality absent here has no Generate panel,
 * and `openGeneratePanel` opens nothing for it. Adding text generation (#1778)
 * means one entry here and no change anywhere else.
 */
const GENERATE_PANEL_BY_TYPE: Partial<
  Record<NodeType, 'generate' | 'generateVideo' | 'generateAudio'>
> = {
  image: 'generate',
  video: 'generateVideo',
  audio: 'generateAudio',
};

/** The two slots that read the canvas's next click. */
interface CanvasModeSlots {
  placingAnnotation: boolean;
  pickSession: PickSession | null;
}

/**
 * Hand the canvas's next click to one mode, and take it away from the other.
 *
 * Placing a note and picking a node are two readings of the same click, and
 * the canvas settles them by the order its handlers happen to run in — the
 * drop answers first, so a pick left standing beside an armed tool never sees
 * the click it is waiting for, and one Escape ends both. Whichever mode was
 * asked for last is the one that is on.
 *
 * Both directions come through here because the rule is one fact. Written as
 * "every opener also clears the other", it was fourteen places to keep in
 * step, and the thirteen pick openers were missing their half.
 * @param s - The draft state being written.
 * @param s.placingAnnotation - Whether the note tool is armed.
 * @param s.pickSession - The pick in progress, if any.
 * @param mode - The pick to start, or `'annotation'` for the note tool.
 */
function claimTheNextClick(
  s: CanvasModeSlots,
  mode: PickSession | 'annotation',
): void {
  s.placingAnnotation = mode === 'annotation';
  s.pickSession = mode === 'annotation' ? null : mode;
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
    placingAnnotation: false,
    annotationDrafts: {},
    canvasListening: false,
    proposalOutcome: null,
    pendingUploadFiles: null,
    pendingViewportCommand: null,
    pendingHistoryCommand: null,
    pendingRename: null,
    canUndo: false,
    canRedo: false,
    panelHostId: null,
    panelKind: null,
    taskPanelStatus: null,
    pickSession: null,
    pendingFocusUploads: [],
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
    setAnnotationDraft: (nodeId, open) =>
      set((s) => {
        if (open === null) delete s.annotationDrafts[nodeId];
        else s.annotationDrafts[nodeId] = open;
      }),
    startAnnotationPlacement: () => set((s) => claimTheNextClick(s, 'annotation')),
    endAnnotationPlacement: () =>
      set((s) => {
        s.placingAnnotation = false;
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
    openGeneratePanel: (nodeId, type) =>
      set((s) => {
        // Image, video and audio have separate panels (#1896, #1960).
        // Deciding here rather than at the call site keeps the number of
        // panels a detail of this store: a fourth generative modality is one
        // more entry in the map, not a new branch wherever Generate is
        // opened from.
        const kind = GENERATE_PANEL_BY_TYPE[type];
        // A modality with no panel opens nothing. The unmapped modalities are
        // the ones with no Generate panel yet (text / 3d / web / annotation /
        // group), and the menu never offers Generate on them
        // (canGenerate gates it) — so arriving here means a caller is wrong.
        // Falling back to the image panel would put such a node's host id
        // under an image body, which reads as a working panel operating on
        // the wrong thing; nothing happening is the honest outcome.
        if (!kind) return;
        s.panelHostId = nodeId;
        s.panelKind = kind;
        // Switching the panel to another node (or from the reset panel) must
        // exit any in-progress pick — otherwise a stale pick would wire the
        // next click to the PREVIOUS node (closeActivePanel clears it too).
        s.pickSession = null;
      }),
    openEmptyImagePanel: (nodeId) =>
      set((s) => {
        // Opening reset replaces any open panel (Generate included) — single
        // host + kind makes the two mutually exclusive with no manual bookkeeping.
        s.panelHostId = nodeId;
        s.panelKind = 'resetEmpty';
        s.pickSession = null;
      }),
    openHistoryPanel: (nodeId) =>
      set((s) => {
        // History browse is another node-anchored panel in the same mutually-
        // exclusive slot; clearing pickSession matches the other two openers so
        // a stale Generate pick can't wire the next click to a previous node.
        s.panelHostId = nodeId;
        s.panelKind = 'history';
        s.pickSession = null;
      }),
    openTaskPanel: (nodeId, status) =>
      set((s) => {
        // The fourth node-anchored panel in the same exclusive slot; clearing
        // pickSession matches the other three openers so a stale Generate pick
        // cannot wire the next click to a previous node.
        s.panelHostId = nodeId;
        s.panelKind = 'tasks';
        s.taskPanelStatus = status;
        s.pickSession = null;
      }),
    openAnnotationPanel: (nodeId) =>
      set((s) => {
        // The fifth panel in the exclusive slot; clearing pickSession matches
        // the other four openers so a stale Generate pick cannot wire the next
        // click to a previous node.
        s.panelHostId = nodeId;
        s.panelKind = 'annotation';
        s.pickSession = null;
      }),
    closeActivePanel: () =>
      set((s) => {
        s.panelHostId = null;
        s.panelKind = null;
        s.taskPanelStatus = null;
        s.pickSession = null;
      }),
    startReferencePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'reference' })),
    startStylePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'style' })),
    startFirstFramePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'firstFrame' })),
    startEndFramePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'endFrame' })),
    startCharacterImagePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'characterImage' })),
    startDrivingVideoPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'drivingVideo' })),
    startReferenceVideoPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'referenceVideo' })),
    startDrivingAudioPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'drivingAudio' })),
    startRefAudioPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'refAudio' })),
    startMusicSongPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'musicSong' })),
    startMusicVoicePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'musicVoice' })),
    startMusicInstrumentalPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'musicInstrumental' })),
    startFocusPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'focus' })),
    addPendingFocusUpload: (entry) =>
      set((s) => {
        s.pendingFocusUploads.push(entry);
      }),
    removePendingFocusUpload: (id) =>
      set((s) => {
        s.pendingFocusUploads = s.pendingFocusUploads.filter(
          (p) => p.id !== id,
        );
      }),
    endPick: () =>
      set((s) => {
        s.pickSession = null;
      }),
    reset: () =>
      set((s) => {
        s.selectedNodeIds = [];
        s.hoverNodeId = null;
        s.showLockedOverlay = false;
        s.pendingNodeCreate = null;
        s.placingAnnotation = false;
        s.annotationDrafts = {};
        s.pendingUploadFiles = null;
        s.pendingViewportCommand = null;
        s.pendingHistoryCommand = null;
        s.pendingRename = null;
        s.canUndo = false;
        s.canRedo = false;
        s.panelHostId = null;
        s.panelKind = null;
        s.taskPanelStatus = null;
        s.pickSession = null;
        s.pendingFocusUploads = [];
        // `minimapVisible` / `snapToGrid` / `zoom` are viewport preferences, not
        // session state — deliberately NOT reset here (see the interface doc).
      }),
  })),
);
