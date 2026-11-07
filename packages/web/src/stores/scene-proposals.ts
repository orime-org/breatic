// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The mailbox between a 3D generation proposal card in the chat column and
 * the 3D Space in front (inner#1691, design 6.2 and 8.5).
 *
 * Bound to no Space, like the canvas mailbox (`canvasListening` in
 * `stores/canvas.ts`): whichever 3D Space is showing says it is listening,
 * the card hands its proposal in, and that Space takes it out. A hidden Space
 * runs no effects, so only the one in front listens.
 */

import { create } from 'zustand';
import type { SceneGenerationProposal } from '@breatic/shared';

interface SceneProposalsState {
  /** Whether a 3D Space in front is receiving proposals. */
  listening: boolean;
  /** A proposal handed in and not taken yet. */
  incoming: SceneGenerationProposal | null;
  /** Said by the receiving Space as it starts and stops listening. */
  setListening: (listening: boolean) => void;
  /** Hand a proposal to the Space in front. */
  request: (proposal: SceneGenerationProposal) => void;
  /** Take the waiting proposal out, leaving the mailbox empty. */
  take: () => SceneGenerationProposal | null;
  /** Forget the listener and the waiting proposal, as leaving the project does. */
  reset: () => void;
}

/**
 * The 3D proposal mailbox.
 * @returns The store hook.
 */
export const useSceneProposals = create<SceneProposalsState>()((set, get) => ({
  listening: false,
  incoming: null,
  setListening: (listening) => set({ listening }),
  request: (proposal) => set({ incoming: proposal }),
  take: () => {
    const { incoming } = get();
    if (incoming !== null) set({ incoming: null });
    return incoming;
  },
  reset: () => set({ listening: false, incoming: null }),
}));
