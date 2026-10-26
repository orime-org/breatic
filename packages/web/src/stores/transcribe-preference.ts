// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transcription panel's filler switch (inner#856).
 *
 * One for the whole page: a reader who turned fillers off in one canvas
 * expects them off in the next. A canvas session is one per Space and is
 * dropped with its tab, so the switch lives here, until the page reloads.
 */

import { create } from 'zustand';

interface TranscribePreference {
  /** Whether filler words stay as spoken. */
  keepFillers: boolean;
  /** Set the switch. */
  setKeepFillers: (keepFillers: boolean) => void;
}

export const useTranscribePreference = create<TranscribePreference>((set) => ({
  keepFillers: true,
  setKeepFillers: (keepFillers) => set({ keepFillers }),
}));
