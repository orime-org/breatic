// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The mailbox that opens the 3D Space in front's generation dialog filled
 * (inner#1691, design 4.6, 6.2 and 8.5): an Agent proposal card in the chat
 * column, or a Retry on a generation row.
 *
 * Bound to no Space, like the canvas mailbox (`canvasListening` in
 * `stores/canvas.ts`): whichever 3D Space is showing says it is listening, a
 * fill is handed in, and that Space takes it out. A hidden Space runs no
 * effects, so only the one in front listens.
 */

import { create } from 'zustand';
import type { ThreeDGenerationMode } from '@breatic/shared';

/** One picture in a view slot. */
export interface SceneViewImage {
  assetId: string;
  url: string;
  displayName?: string | null;
}

/** What the dialog opens filled with, besides blank: an Agent proposal or a Retry. */
export interface SceneGenerateFill {
  source: 'agent' | 'retry';
  origin: 'space' | 'agent';
  mode: ThreeDGenerationMode;
  prompt: string;
  /** The settings, `negative_prompt` among them. */
  params: Record<string, unknown>;
  images: SceneViewImage[];
}

interface SceneProposalsState {
  /** Whether a 3D Space in front is receiving fills. */
  listening: boolean;
  /** A fill handed in and not taken yet. */
  incoming: SceneGenerateFill | null;
  /** Said by the receiving Space as it starts and stops listening. */
  setListening: (listening: boolean) => void;
  /** Hand a fill to the Space in front. */
  request: (fill: SceneGenerateFill) => void;
  /** Take the waiting fill out, leaving the mailbox empty. */
  take: () => SceneGenerateFill | null;
  /** Forget the listener and the waiting fill, as leaving the project does. */
  reset: () => void;
}

/**
 * The 3D generation dialog's mailbox.
 * @returns The store hook.
 */
export const useSceneProposals = create<SceneProposalsState>()((set, get) => ({
  listening: false,
  incoming: null,
  setListening: (listening) => set({ listening }),
  request: (fill) => set({ incoming: fill }),
  take: () => {
    const { incoming } = get();
    if (incoming !== null) set({ incoming: null });
    return incoming;
  },
  reset: () => set({ listening: false, incoming: null }),
}));
