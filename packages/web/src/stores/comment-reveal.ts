// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from 'zustand';

/**
 * A comment thread a Space is asked to show (#1488 §11.6, §11.7): set when
 * the project page opens at a link to it, taken by the Space once its
 * content is in.
 */
interface CommentRevealState {
  request: { spaceId: string; threadId: string } | null;
  /** Ask a Space to show one of its threads. */
  reveal: (spaceId: string, threadId: string) => void;
  /** Take the request if it is for this Space: the thread to show, or null. */
  take: (spaceId: string) => string | null;
}

export const useCommentRevealStore = create<CommentRevealState>()((set, get) => ({
  request: null,
  reveal: (spaceId, threadId) => set({ request: { spaceId, threadId } }),
  take: (spaceId) => {
    const { request } = get();
    if (request?.spaceId !== spaceId) return null;
    set({ request: null });
    return request.threadId;
  },
}));
