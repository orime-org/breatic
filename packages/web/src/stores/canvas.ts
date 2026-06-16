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
  showLockedOverlay: boolean;
  /** Chrome → canvas mailbox: the node type to create at the viewport centre. */
  pendingNodeCreate: CreateIntent | null;
  /** Chrome → canvas mailbox: a zoom-toolbar command for the canvas to run. */
  pendingViewportCommand: ViewportCommand | null;
  setSelectedNodeIds: (ids: string[]) => void;
  addSelectedNodeId: (id: string) => void;
  clearSelection: () => void;
  setHoverNodeId: (id: string | null) => void;
  setZoom: (zoom: number) => void;
  setMinimapVisible: (visible: boolean) => void;
  toggleMinimap: () => void;
  setShowLockedOverlay: (show: boolean) => void;
  /** Post a create intent from chrome (node-library pick). */
  requestNodeCreate: (type: CreateIntent) => void;
  /** Clear the mailbox once the canvas has fulfilled the intent. */
  consumePendingNodeCreate: () => void;
  /** Post a viewport command from the chrome zoom toolbar. */
  requestViewportCommand: (command: ViewportCommand) => void;
  /** Clear the mailbox once the canvas has run the command. */
  consumeViewportCommand: () => void;
}

export const useCanvasStore = create<CanvasState>()(
  immer((set) => ({
    selectedNodeIds: [],
    hoverNodeId: null,
    zoom: 1,
    minimapVisible: false,
    showLockedOverlay: false,
    pendingNodeCreate: null,
    pendingViewportCommand: null,
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
    requestViewportCommand: (command) =>
      set((s) => {
        s.pendingViewportCommand = command;
      }),
    consumeViewportCommand: () =>
      set((s) => {
        s.pendingViewportCommand = null;
      }),
  })),
);
