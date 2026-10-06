// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { STORAGE_KEYS } from '@web/lib/storage-keys';

/**
 * User preferences store — theme only.
 *
 * The language lives in `@breatic/shared` and is persisted by `changeLocale()`
 * from `@web/i18n/locale-bootstrap`, which also notifies the i18n engine.
 *
 * The theme is stored in `breatic.theme` as the plain value (`dark` /
 * `light` / `system`). An inline script in `index.html` reads the same key
 * before React mounts and sets `document.documentElement.dataset.theme`, so a
 * cold load does not flash the wrong theme. If the key or the stored value
 * changes, update that script too.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_MODES: ReadonlySet<string> = new Set<ThemeMode>(['light', 'dark', 'system']);

/**
 * The theme this browser stored, or `system` when none is stored, the value
 * is not one of the three, or storage cannot be read.
 * @returns The stored theme.
 */
export function readStoredTheme(): ThemeMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.theme);
    return value !== null && THEME_MODES.has(value) ? (value as ThemeMode) : 'system';
  } catch {
    // Private mode and blocked site data throw on access.
    return 'system';
  }
}

/**
 * Store the theme, giving up silently when the browser refuses; the choice
 * still holds for this session.
 * @param theme - The theme the user picked.
 */
function storeTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEYS.theme, theme);
  } catch {
    // Quota and blocked site data both throw.
  }
}

interface PreferencesState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  immer((set) => ({
    theme: readStoredTheme(),
    setTheme: (theme) => {
      set((s) => {
        s.theme = theme;
      });
      storeTheme(theme);
    },
  })),
);
