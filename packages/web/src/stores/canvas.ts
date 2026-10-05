// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { CanvasNodeFields, CanvasProposal } from '@breatic/shared';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

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
   * not carry its selection or a pending request into the next entry, #1771;
   * each canvas's panel and pick go with `canvasSessions.clear()`).
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
