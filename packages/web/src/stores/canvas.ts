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
   * When set, the canvas is in "pick a reference from canvas" mode for this
   * generative node: the next click on another node wires an edge (clicked →
   * this node) as a new reference, then exits. Local UI only (never Yjs).
   */
  referencePickForNodeId: string | null;
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
  /** Enter "pick a reference from canvas" mode for a generative node. */
  startReferencePick: (nodeId: string) => void;
  /** Exit reference-pick mode (after a node is picked, or on cancel). */
  endReferencePick: () => void;
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
    referencePickForNodeId: null,
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
        // Switching the panel to another node must exit any in-progress
        // reference pick — otherwise a stale pick would wire the next click to
        // the PREVIOUS node (closeGeneratePanel clears it too).
        s.referencePickForNodeId = null;
      }),
    closeGeneratePanel: () =>
      set((s) => {
        s.generatePanelNodeId = null;
        s.referencePickForNodeId = null;
      }),
    startReferencePick: (nodeId) =>
      set((s) => {
        s.referencePickForNodeId = nodeId;
      }),
    endReferencePick: () =>
      set((s) => {
        s.referencePickForNodeId = null;
      }),
  })),
);
