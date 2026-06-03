// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Toast queue store — high-level orchestration around sonner.
 *
 * Most app code calls `sonner.toast()` directly. This store exists for
 * places that need to read queue depth (e.g. disabling actions while
 * blocking toasts are open) or programmatically dismiss by id.
 */
export type ToastVariant = 'default' | 'success' | 'info' | 'warning' | 'error';

export interface ToastEntry {
  id: string;
  variant: ToastVariant;
  message: string;
  createdAt: number;
}

interface ToastState {
  queue: ToastEntry[];
  push: (entry: Omit<ToastEntry, 'createdAt'>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>()(
  immer((set) => ({
    queue: [],
    push: (entry) =>
      set((s) => {
        s.queue.push({ ...entry, createdAt: Date.now() });
      }),
    dismiss: (id) =>
      set((s) => {
        s.queue = s.queue.filter((t) => t.id !== id);
      }),
    clear: () =>
      set((s) => {
        s.queue = [];
      }),
  })),
);
