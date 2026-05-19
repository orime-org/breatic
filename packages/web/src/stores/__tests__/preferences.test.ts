import { describe, it, expect, beforeEach } from 'vitest';
import { usePreferencesStore } from '../preferences';

describe('usePreferencesStore', () => {
  beforeEach(() => {
    usePreferencesStore.getState().resetTweaks();
    usePreferencesStore.setState({ theme: 'light', language: 'zh-CN' });
  });

  it('initial defaults match Direction B', () => {
    const s = usePreferencesStore.getState();
    expect(s.theme).toBe('light');
    expect(s.language).toBe('zh-CN');
    expect(s.tweaks.textScale).toBe(14);
    expect(s.tweaks.saturation).toBe(58);
    expect(s.tweaks.hue).toBe(8);
    expect(s.tweaks.radius).toBe('round');
    expect(s.tweaks.neutrals).toBe('warm-zinc');
  });

  it('setTheme changes theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });

  it('setTweak updates a single tweak field', () => {
    usePreferencesStore.getState().setTweak('hue', 200);
    expect(usePreferencesStore.getState().tweaks.hue).toBe(200);
    expect(usePreferencesStore.getState().tweaks.textScale).toBe(14);
  });

  it('resetTweaks restores defaults', () => {
    usePreferencesStore.getState().setTweak('saturation', 100);
    usePreferencesStore.getState().resetTweaks();
    expect(usePreferencesStore.getState().tweaks.saturation).toBe(58);
  });
});
