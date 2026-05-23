import '@testing-library/jest-dom/vitest';
// Register vitest-axe matchers globally (adds `toHaveNoViolations` to
// `expect`). Component tests use the matcher via the helper in
// `src/test-utils/a11y.ts`. Layer B of the a11y CI plan (layer A is the
// jsx-a11y ESLint plugin, see eslint.config.mts).
//
// NOTE: we do `expect.extend` manually instead of importing
// `vitest-axe/extend-expect`. The upstream `extend-expect.js` shipped
// in v0.1.0 is a 0-byte file (build bug), so the side-effect import
// silently does nothing and tests fail with "Invalid Chai property:
// toHaveNoViolations". Wiring the matcher by hand is the documented
// workaround until vitest-axe ships a fixed dist.
import { afterEach, beforeAll, expect } from 'vitest';
// Namespace import: vitest-axe v0.1.0's `dist/matchers.d.ts` mis-types
// `toHaveNoViolations` as a type-only re-export (it is actually a
// runtime function), so a named import errors at tsc. Importing as a
// namespace works around the bad .d.ts.
import * as axeMatchers from 'vitest-axe/matchers';
expect.extend(axeMatchers as Parameters<typeof expect.extend>[0]);

// Augment vitest's `Assertion` interface so `.toHaveNoViolations()` is
// known to tsc throughout the test suite.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors vitest-axe's own AxeMatchers shape
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): unknown;
  }
}
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
