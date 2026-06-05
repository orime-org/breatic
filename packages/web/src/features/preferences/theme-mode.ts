// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { usePreferencesStore, type ThemeMode } from '@web/stores';

export type { ThemeMode };

export interface ThemeModeOption {
  code: ThemeMode;
  i18nKey: string;
  icon: LucideIcon;
}

/**
 * The three theme intents every theme switcher offers (project + studio
 * share this list). `i18nKey` resolves the label via `t()`; `system`
 * follows the OS `prefers-color-scheme` at runtime.
 */
export const THEME_MODES: ThemeModeOption[] = [
  { code: 'light', i18nKey: 'preferences.themeMode.light', icon: Sun },
  { code: 'dark', i18nKey: 'preferences.themeMode.dark', icon: Moon },
  { code: 'system', i18nKey: 'preferences.themeMode.system', icon: Monitor },
];

/**
 * Resolve a theme intent to the concrete light/dark value to apply.
 * @param intent - Stored theme intent; `system` follows the OS color-scheme preference.
 * @returns the concrete `light` or `dark` value for `<html data-theme>`.
 */
export function resolveTheme(intent: ThemeMode): 'light' | 'dark' {
  if (intent !== 'system') return intent;
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return 'light';
}

export interface UseThemeMode {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  modes: ThemeModeOption[];
}

/**
 * Shared theme-mode hook used by every theme switcher (project + studio).
 *
 * Reads the persisted intent from `usePreferencesStore`, mirrors the
 * resolved value onto `<html data-theme>`, and (for `system`) re-resolves
 * when the OS color-scheme preference flips. Keeping the apply effect here
 * — instead of duplicated in each switcher — guarantees both chromes drive
 * the theme through one code path.
 * @returns the current intent, a setter, and the selectable mode list.
 */
export function useThemeMode(): UseThemeMode {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolveTheme(theme);

    if (theme !== 'system') return;
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    /**
     * Re-resolve `<html data-theme>` when the OS color-scheme preference flips.
     */
    const onChange = (): void => {
      document.documentElement.dataset.theme = mql.matches ? 'dark' : 'light';
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  return { theme, setTheme, modes: THEME_MODES };
}
