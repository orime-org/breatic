import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * User preferences store — theme + language only.
 *
 * Direction B runtime Tweaks (text scale / saturation / hue / radius /
 * neutrals) were removed 2026-05-19 per user decision: the defaults
 * (text 14 / radius round / neutrals warm-zinc) are fixed in
 * `theme/tokens.css` and not user-tunable at runtime.
 *
 * Persistence to localStorage lands in a later PR.
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = 'zh-CN' | 'en' | 'ja' | 'zh-TW';

interface PreferencesState {
  theme: ThemeMode;
  language: Language;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  immer((set) => ({
    theme: 'system',
    language: 'zh-CN',
    setTheme: (theme) =>
      set((s) => {
        s.theme = theme;
      }),
    setLanguage: (lang) =>
      set((s) => {
        s.language = lang;
      }),
  })),
);
