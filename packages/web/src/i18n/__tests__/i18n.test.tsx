import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  getLocale,
  resetLocales,
  setLocale,
  setLocaleMessages,
  t,
  type Locale,
} from '@breatic/shared/i18n';
import { useTranslation } from '@/i18n/use-translation';

import en from '../../../../../locales/en.json';
import zhCN from '../../../../../locales/zh-CN.json';
import zhTW from '../../../../../locales/zh-TW.json';
import ja from '../../../../../locales/ja.json';

function bootstrap() {
  setLocaleMessages('en', en as Record<string, unknown>);
  setLocaleMessages('zh-CN', zhCN as Record<string, unknown>);
  setLocaleMessages('zh-TW', zhTW as Record<string, unknown>);
  setLocaleMessages('ja', ja as Record<string, unknown>);
  setLocale('en');
}

describe('web i18n integration', () => {
  beforeEach(() => {
    // Wipe state — `resetLocales` clears every catalog + listener so
    // each test exercises the full bootstrap path rather than reusing
    // stale messages from the global vitest setup.
    resetLocales();
    bootstrap();
  });

  afterEach(() => {
    setLocale('en');
  });

  describe('plain-string lookup', () => {
    it('resolves keys against the current locale', () => {
      expect(t('canvas.emptyState.title')).toBe('The canvas is empty');
      setLocale('zh-CN');
      expect(t('canvas.emptyState.title')).toBe('画布是空的');
      setLocale('ja');
      expect(t('canvas.emptyState.title')).toBe('キャンバスは空です');
      setLocale('zh-TW');
      expect(t('canvas.emptyState.title')).toBe('畫布是空的');
    });
  });

  describe('English-fallback semantics', () => {
    it('falls back to en when a key is missing in the active locale', () => {
      setLocaleMessages('fr-FR' as Locale, {});
      setLocale('fr-FR' as Locale);
      expect(t('canvas.emptyState.title')).toBe('The canvas is empty');
    });

    it('returns the key when missing in every locale', () => {
      expect(t('totally.unknown.key.path')).toBe('totally.unknown.key.path');
    });
  });

  describe('ICU MessageFormat — plural', () => {
    it('renders English one/other branches correctly', () => {
      expect(t('spaces.drawer.description', { count: 1 })).toBe(
        '1 space · click to open or use the right menu',
      );
      expect(t('spaces.drawer.description', { count: 5 })).toBe(
        '5 spaces · click to open or use the right menu',
      );
    });

    it('renders CJK locales with the other-only branch (no plural)', () => {
      setLocale('zh-CN');
      expect(t('spaces.drawer.description', { count: 1 })).toBe(
        '1 个 · 点击切换或右侧操作',
      );
      expect(t('spaces.drawer.description', { count: 5 })).toBe(
        '5 个 · 点击切换或右侧操作',
      );
    });

    it('renders Japanese the same regardless of count', () => {
      setLocale('ja');
      expect(t('spaces.drawer.description', { count: 1 })).toBe(
        '1 件 · クリックで切替、右側で操作',
      );
      expect(t('spaces.drawer.description', { count: 99 })).toBe(
        '99 件 · クリックで切替、右側で操作',
      );
    });
  });

  describe('ICU MessageFormat — placeholder interpolation', () => {
    it('substitutes named params in plain strings', () => {
      expect(t('chat.empty.greetingWithName', { name: 'Alice' })).toBe(
        'Hi, Alice!',
      );
      setLocale('zh-CN');
      expect(t('chat.empty.greetingWithName', { name: '小明' })).toBe(
        '嗨, 小明!',
      );
    });
  });

  describe('useTranslation hook', () => {
    it('returns the shared t function', () => {
      const { result } = renderHook(() => useTranslation());
      expect(result.current).toBe(t);
    });

    it('triggers a re-render when setLocale changes the active locale', () => {
      const { result } = renderHook(() => useTranslation());
      const initial = result.current('canvas.emptyState.title');
      expect(initial).toBe('The canvas is empty');

      act(() => {
        setLocale('zh-CN');
      });

      // Hook should have re-rendered and now resolves against zh-CN.
      expect(result.current('canvas.emptyState.title')).toBe('画布是空的');
      expect(getLocale()).toBe('zh-CN');
    });
  });
});
