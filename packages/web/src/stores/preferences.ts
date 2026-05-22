import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * User preferences store — theme only.
 *
 * `language` lived here briefly but moved to `@breatic/shared/i18n` as
 * the single source of truth (2026-05-22, PR follow-up to #117). The
 * LangSwitcher now calls `changeLocale()` from `@/i18n/locale-bootstrap`
 * directly, which persists to `localStorage["breatic.locale"]` and
 * notifies the i18n engine in one shot. Keeping a Zustand mirror caused
 * silent drift (store changed but engine didn't, so `useTranslation`
 * never re-rendered).
 *
 * Direction B runtime Tweaks (text scale / saturation / hue / radius /
 * neutrals) were removed 2026-05-19 per user decision: the defaults
 * (text 14 / radius round / neutrals warm-zinc) are fixed in
 * `theme/tokens.css` and not user-tunable at runtime.
 *
 * Theme persistence to localStorage lands in a later PR.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

interface PreferencesState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  immer((set) => ({
    theme: 'system',
    setTheme: (theme) =>
      set((s) => {
        s.theme = theme;
      }),
  })),
);
