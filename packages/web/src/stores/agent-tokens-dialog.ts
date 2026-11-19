// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from 'zustand';

/**
 * Whether the account's Agent tokens dialog is open, and which connection it
 * points at (#1488 §5): opened from the account menu, and from a comment's
 * hand-over label on any page, so it is mounted once at the app root.
 */
interface AgentTokensDialogState {
  open: boolean;
  /** The connection to bring into view; null for none. */
  focusId: string | null;
  /** Open it, pointing at one connection when given. */
  show: (focusId?: string) => void;
  /** Close it. */
  hide: () => void;
}

export const useAgentTokensDialog = create<AgentTokensDialogState>((set) => ({
  open: false,
  focusId: null,
  show: (focusId) => set({ open: true, focusId: focusId ?? null }),
  hide: () => set({ open: false, focusId: null }),
}));
