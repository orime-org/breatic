import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * User preferences store — theme only, persisted to localStorage.
 *
 * `language` lived here briefly but moved to `@breatic/shared` as
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
 * Theme persistence (2026-05-22): wrapped in `persist` middleware so
 * the user's choice survives reload. The localStorage key is
 * `breatic.preferences` (JSON `{ state: { theme }, version }`). A
 * mirror inline script in `index.html` reads the same key before
 * React mounts and sets `document.documentElement.dataset.theme`
 * up-front to avoid a flash of the wrong theme on cold load. The two
 * must stay in sync — if you rename the storage key or change the
 * persisted shape, update the inline script too.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

interface PreferencesState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    immer((set) => ({
      theme: 'system',
      setTheme: (theme) =>
        set((s) => {
          s.theme = theme;
        }),
    })),
    {
      name: 'breatic.preferences',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ theme: s.theme }),
      version: 1,
    },
  ),
);
