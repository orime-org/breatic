import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * User preferences store — theme, language, and Direction B 5-parameter
 * Tweaks (text scale / saturation / hue / radius / neutral palette).
 *
 * Persisted to localStorage in a future PR (LocalStoragePlugin).
 */
export type ThemeMode = 'light' | 'dark';
export type Language = 'zh-CN' | 'en' | 'ja' | 'zh-TW';
export type RadiusMode = 'sharp' | 'round';
export type NeutralPalette = 'warm-zinc' | 'cool-slate';

interface TweaksState {
  textScale: number;
  saturation: number;
  hue: number;
  radius: RadiusMode;
  neutrals: NeutralPalette;
}

interface PreferencesState {
  theme: ThemeMode;
  language: Language;
  tweaks: TweaksState;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
  setTweak: <K extends keyof TweaksState>(key: K, value: TweaksState[K]) => void;
  resetTweaks: () => void;
}

const DEFAULT_TWEAKS: TweaksState = {
  textScale: 14,
  saturation: 58,
  hue: 8,
  radius: 'round',
  neutrals: 'warm-zinc',
};

export const usePreferencesStore = create<PreferencesState>()(
  immer((set) => ({
    theme: 'light',
    language: 'zh-CN',
    tweaks: { ...DEFAULT_TWEAKS },
    setTheme: (theme) =>
      set((s) => {
        s.theme = theme;
      }),
    setLanguage: (lang) =>
      set((s) => {
        s.language = lang;
      }),
    setTweak: (key, value) =>
      set((s) => {
        s.tweaks[key] = value;
      }),
    resetTweaks: () =>
      set((s) => {
        s.tweaks = { ...DEFAULT_TWEAKS };
      }),
  })),
);
