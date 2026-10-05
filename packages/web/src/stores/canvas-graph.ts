// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Edge, Node } from '@xyflow/react';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { createSpaceRegistry } from '@web/stores/space-registry';

/**
 * Canvas graph store (#1647 step 4) — owns one canvas's ReactFlow render
 * buffer. Every open Space keeps its canvas mounted (inner#1235), so each Space
 * has its own buffer, kept while its tab is open. Yjs remains the source of
 * truth; this holds the local ReactFlow mirror (`flowNodes` / `flowEdges`) so
 * drag stays smooth and selection is per-user.
 *
 * It is a PLAIN zustand store (no immer) on purpose: the node array is
 * high-frequency and immer's autoFreeze + draft proxies would freeze / wrap the
 * node objects, which fights ReactFlow's controlled rendering and the
 * reference-stable mirror merge (`mergeCanvasNodes`). The setters take a
 * functional updater so that merge can reconcile against the current buffer.
 *
 * Splitting the buffer out of the monolithic `CanvasSpace` component into this
 * store lets discrete consumers subscribe to just their slice (selective
 * subscription), instead of the whole component re-running its O(N) derived
 * computations on every change.
 */
export interface CanvasGraphState {
  /** ReactFlow node render buffer (Yjs mirror). */
  flowNodes: Node[];
  /** ReactFlow edge render buffer (Yjs mirror). */
  flowEdges: Edge[];
  /** Apply an updater to the node buffer (reference-stable merge / node changes). */
  setFlowNodes: (updater: (prev: Node[]) => Node[]) => void;
  /** Apply an updater to the edge buffer. */
  setFlowEdges: (updater: (prev: Edge[]) => Edge[]) => void;
}

/** One canvas's render buffer. */
export type CanvasGraphStore = StoreApi<CanvasGraphState>;

/**
 * Create one canvas's render buffer.
 * @returns The store.
 */
function createCanvasGraphStore(): CanvasGraphStore {
  return createStore<CanvasGraphState>((set, get) => ({
    flowNodes: [],
    flowEdges: [],
    setFlowNodes: (updater) => set({ flowNodes: updater(get().flowNodes) }),
    setFlowEdges: (updater) => set({ flowEdges: updater(get().flowEdges) }),
  }));
}

/**
 * Canvas render buffers live as long as their Space's tab: created on first
 * use, dropped when the tab is closed, all cleared when the project is left.
 */
export const canvasGraphs = createSpaceRegistry<CanvasGraphStore>(createCanvasGraphStore);
