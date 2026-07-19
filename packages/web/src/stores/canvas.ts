// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { CanvasNodeFields } from '@breatic/shared';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/** A node-create intent posted by chrome for the canvas to fulfil. */
type CreateIntent = CanvasNodeFields['type'];

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
 */
export type PickPurpose = 'reference' | 'style' | 'focus';

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
  /** Chrome → canvas mailbox: the node type to create at the viewport centre. */
  pendingNodeCreate: CreateIntent | null;
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
   * Per-user Generate panel: the node id whose Generate panel is open for THIS
   * user, or null. Local UI only (never Yjs) — one collaborator opening a
   * panel must not open it for others. Only one panel is open at a time; the
   * panel's collaborative content (prompt / model / params / references) lives
   * on the node itself.
   */
  generatePanelNodeId: string | null;
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
  /** Post a create intent from chrome (node-library pick). */
  requestNodeCreate: (type: CreateIntent) => void;
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
  /** Open the Generate panel for a node (replaces any currently open panel). */
  openGeneratePanel: (nodeId: string) => void;
  /** Close the Generate panel (exit button, or execute hands off to handling). */
  closeGeneratePanel: () => void;
  /** Enter a REFERENCE pick (wires i2i source edges) for a generative node. */
  startReferencePick: (nodeId: string) => void;
  /** Enter a STYLE pick (#1664, copies one image URL into the slot) for a generative node. */
  startStylePick: (nodeId: string) => void;
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
    pendingUploadFiles: null,
    pendingViewportCommand: null,
    pendingHistoryCommand: null,
    pendingRename: null,
    canUndo: false,
    canRedo: false,
    generatePanelNodeId: null,
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
    requestNodeCreate: (type) =>
      set((s) => {
        s.pendingNodeCreate = type;
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
    openGeneratePanel: (nodeId) =>
      set((s) => {
        s.generatePanelNodeId = nodeId;
        // Switching the panel to another node must exit any in-progress pick —
        // otherwise a stale pick would wire the next click to the PREVIOUS node
        // (closeGeneratePanel clears it too).
        s.pickSession = null;
      }),
    closeGeneratePanel: () =>
      set((s) => {
        s.generatePanelNodeId = null;
        s.pickSession = null;
      }),
    startReferencePick: (nodeId) =>
      set((s) => {
        s.pickSession = { nodeId, purpose: 'reference' };
      }),
    startStylePick: (nodeId) =>
      set((s) => {
        s.pickSession = { nodeId, purpose: 'style' };
      }),
    startFocusPick: (nodeId) =>
      set((s) => {
        s.pickSession = { nodeId, purpose: 'focus' };
      }),
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
        s.pendingUploadFiles = null;
        s.pendingViewportCommand = null;
        s.pendingHistoryCommand = null;
        s.pendingRename = null;
        s.canUndo = false;
        s.canRedo = false;
        s.generatePanelNodeId = null;
        s.pickSession = null;
        s.pendingFocusUploads = [];
        // `minimapVisible` / `snapToGrid` / `zoom` are viewport preferences, not
        // session state — deliberately NOT reset here (see the interface doc).
      }),
  })),
);
