// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { create } from 'zustand';

import { readUserPreferences, writeUserPreference } from '@web/lib/user-preferences-storage';

/** How documents are shown, one value for every open document Space. */
interface DocumentViewState {
  /** Whether the heading outline beside the body is shown (inner#1149 A11). */
  outlineVisible: boolean;
  /** The account the value was read for; null before the first read. */
  owner: string | undefined | null;
  restore: (userId: string | undefined) => void;
  setOutlineVisible: (visible: boolean) => void;
  toggleOutline: () => void;
}

/**
 * Document view settings shared by every open document Space, read once per
 * account and stored on change. A write that storage refuses still changes
 * this session's value; it is only forgotten on reload.
 * @returns The store hook.
 * @throws {never} Never.
 */
export const useDocumentViewStore = create<DocumentViewState>()((setState, get) => ({
  outlineVisible: true,
  owner: null,
  restore: (userId) => {
    setState({ owner: userId, outlineVisible: readUserPreferences(userId).documentOutlineVisible });
  },
  setOutlineVisible: (visible) => {
    setState({ outlineVisible: visible });
    writeUserPreference(get().owner ?? undefined, { documentOutlineVisible: visible });
  },
  toggleOutline: () => {
    get().setOutlineVisible(!get().outlineVisible);
  },
}));
