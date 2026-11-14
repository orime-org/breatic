// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The "View" press of a 3D capture placed on a canvas (#1411 design 5.4): the
 * project page opens the canvas it names, and that canvas, once loaded, moves
 * to the node, selects it and takes the request. Only the latest press is kept.
 */

import { create } from 'zustand';

interface CanvasRevealState {
  request: { spaceId: string; nodeId: string } | null;
  /** Ask a canvas to show one of its nodes. */
  reveal: (spaceId: string, nodeId: string) => void;
  /** Take the request if it is for this canvas: the node to show, or null. */
  take: (spaceId: string) => string | null;
}

export const useCanvasRevealStore = create<CanvasRevealState>()((set, get) => ({
  request: null,
  reveal: (spaceId, nodeId) => set({ request: { spaceId, nodeId } }),
  take: (spaceId) => {
    const { request } = get();
    if (request?.spaceId !== spaceId) return null;
    set({ request: null });
    return request.nodeId;
  },
}));
