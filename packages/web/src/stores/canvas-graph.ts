// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Edge, Node } from '@xyflow/react';
import { create } from 'zustand';

/**
 * Canvas graph store (#1647 step 4) — owns the ReactFlow render buffer for the
 * ONE active canvas (`SpaceOutlet` mounts only the active space's body, keyed on
 * its id, so a single canvas renders at a time). Yjs remains the source of
 * truth; this holds the local ReactFlow mirror (`flowNodes` / `flowEdges`) so
 * drag stays smooth and selection is per-user.
 *
 * It is a PLAIN zustand store (no immer) on purpose: the node array is
 * high-frequency and immer's autoFreeze + draft proxies would freeze / wrap the
 * node objects, which fights ReactFlow's controlled rendering and the
 * reference-stable mirror merge (`mergeMirroredSelection`). The setters take a
 * functional updater so that merge can reconcile against the current buffer.
 *
 * Splitting the buffer out of the monolithic `CanvasSpace` component into this
 * store lets discrete consumers subscribe to just their slice (selective
 * subscription), instead of the whole component re-running its O(N) derived
 * computations on every change.
 */
interface CanvasGraphState {
  /** ReactFlow node render buffer for the active canvas (Yjs mirror). */
  flowNodes: Node[];
  /** ReactFlow edge render buffer for the active canvas (Yjs mirror). */
  flowEdges: Edge[];
  /** Apply an updater to the node buffer (reference-stable merge / node changes). */
  setFlowNodes: (updater: (prev: Node[]) => Node[]) => void;
  /** Apply an updater to the edge buffer. */
  setFlowEdges: (updater: (prev: Edge[]) => Edge[]) => void;
  /** Clear both buffers — run on canvas unmount so a space switch never flashes the previous space's nodes. */
  reset: () => void;
}

export const useCanvasGraphStore = create<CanvasGraphState>((set, get) => ({
  flowNodes: [],
  flowEdges: [],
  setFlowNodes: (updater) => set({ flowNodes: updater(get().flowNodes) }),
  setFlowEdges: (updater) => set({ flowEdges: updater(get().flowEdges) }),
  reset: () => set({ flowNodes: [], flowEdges: [] }),
}));
