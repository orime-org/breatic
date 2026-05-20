import { describe, it, expect, beforeEach } from 'vitest';
import { usePreferencesStore } from '../preferences';

describe('usePreferencesStore', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ theme: 'light', language: 'zh-CN' });
  });

  it('initial defaults', () => {
    const s = usePreferencesStore.getState();
    expect(s.theme).toBe('light');
    expect(s.language).toBe('zh-CN');
  });

  it('setTheme changes theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });

  it('setLanguage changes language', () => {
    usePreferencesStore.getState().setLanguage('en');
    expect(usePreferencesStore.getState().language).toBe('en');
  });
});
