// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Active project meta cache — viewer's role + settings for the project
 * currently open in the Project page.
 *
 * Yjs is the source of truth for project meta (spaces / membership);
 * this store mirrors the "viewer-scoped" bits that React renders against
 * (role, settings flags), updated from Yjs subscriptions in a hook layer.
 */
export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface ActiveProjectMeta {
  id: string;
  name: string;
  role: ProjectRole;
  settings: Record<string, unknown>;
}

interface ProjectState {
  active: ActiveProjectMeta | null;
  setActive: (meta: ActiveProjectMeta | null) => void;
  patchSettings: (patch: Record<string, unknown>) => void;
  clear: () => void;
}

export const useProjectStore = create<ProjectState>()(
  immer((set) => ({
    active: null,
    setActive: (meta) =>
      set((s) => {
        s.active = meta;
      }),
    patchSettings: (patch) =>
      set((s) => {
        if (s.active) Object.assign(s.active.settings, patch);
      }),
    clear: () =>
      set((s) => {
        s.active = null;
      }),
  })),
);
