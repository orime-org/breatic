// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Mini-tool session store — tracks the active mini-tool invocation per
 * node toolbar (right zone). Holds session id, preview state, progress.
 *
 * One session at a time per node; multiple nodes can have parallel sessions
 * keyed by source node id.
 */
export type MiniToolStatus = 'idle' | 'previewing' | 'submitting' | 'error';

export interface MiniToolSession {
  sessionId: string;
  sourceNodeId: string;
  toolName: string;
  status: MiniToolStatus;
  progress: number;
  previewUrl?: string;
  errorMessage?: string;
}

interface MiniToolState {
  sessions: Record<string, MiniToolSession>;
  startSession: (session: Omit<MiniToolSession, 'status' | 'progress'>) => void;
  updateSession: (sourceNodeId: string, patch: Partial<MiniToolSession>) => void;
  endSession: (sourceNodeId: string) => void;
  /** Clear all mini-tool sessions on project change (#1771). */
  reset: () => void;
}

export const useMiniToolStore = create<MiniToolState>()(
  immer((set) => ({
    sessions: {},
    startSession: (session) =>
      set((s) => {
        s.sessions[session.sourceNodeId] = {
          ...session,
          status: 'previewing',
          progress: 0,
        };
      }),
    updateSession: (sourceNodeId, patch) =>
      set((s) => {
        const existing = s.sessions[sourceNodeId];
        if (existing) Object.assign(existing, patch);
      }),
    endSession: (sourceNodeId) =>
      set((s) => {
        delete s.sessions[sourceNodeId];
      }),
    reset: () =>
      set((s) => {
        s.sessions = {};
      }),
  })),
);
