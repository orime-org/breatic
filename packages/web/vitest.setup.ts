import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setLocale, setLocaleMessages } from '@breatic/shared/i18n';

import en from '../../locales/en.json';
import zhCN from '../../locales/zh-CN.json';
import zhTW from '../../locales/zh-TW.json';
import ja from '../../locales/ja.json';

// Register all four locale catalogs once so components rendered via
// `useTranslation` return real strings in tests. Default to English —
// suites that exercise localization explicitly call setLocale().
beforeAll(() => {
  setLocaleMessages('en', en as Record<string, unknown>);
  setLocaleMessages('zh-CN', zhCN as Record<string, unknown>);
  setLocaleMessages('zh-TW', zhTW as Record<string, unknown>);
  setLocaleMessages('ja', ja as Record<string, unknown>);
  setLocale('en');
});

// Auto-clean DOM after each test to prevent leakage across tests.
// Also reset locale to the default so a test that switched languages
// doesn't poison the next file in the run.
afterEach(() => {
  cleanup();
  setLocale('en');
});

// jsdom lacks several APIs that Radix / cmdk / shadcn primitives use.
// Provide minimal polyfills so component tests focus on contracts.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ??=
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };

if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
