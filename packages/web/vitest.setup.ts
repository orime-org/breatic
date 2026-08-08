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
import { onlineManager } from '@tanstack/react-query';
import { setLocale, setLocaleMessages } from '@breatic/shared';

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
  // The two resets come first and the hygiene sweep last, deliberately: an
  // exception in the sweep must not be able to skip them. Under one process
  // per package a skipped `cleanup()` or locale reset does not stay inside
  // the test that broke — it reaches every file that runs afterwards.
  cleanup();
  setLocale('en');
  // React Query's online state is a process-wide singleton, so a test that
  // goes offline to exercise a paused fetch takes every later file with it if
  // it never comes back — queries sit in `pending` forever and fail somewhere
  // with no relation to the cause. Restoring it here rather than in the file
  // that flips it means a test can end any way it likes, including failing
  // between the two calls.
  onlineManager.setOnline(true);
  // Removing a container does not take its sheets out of
  // `document.styleSheets` in jsdom: they stay listed with
  // `document.contains(ownerNode) === false`. Re-attaching and removing is
  // what makes jsdom deregister them — removal is the only event it listens
  // for, so removing an already-detached node does nothing.
  //
  // This is memory hygiene, not correctness: measured, the a11y assertions
  // reach the same verdict with the ghost count at 134 as they do at 0.
  for (const sheet of Array.from(document.styleSheets)) {
    // `ownerNode` is `Element | ProcessingInstruction | null`; only an Element
    // can be re-attached and removed, so narrow rather than assert.
    const node = sheet.ownerNode;
    if (node instanceof Element && !document.contains(node)) {
      document.head.appendChild(node);
      node.remove();
    }
  }
});

// A note on the <style> elements vitest injects for each file's CSS imports:
// they land in the one head every file in the package shares and nothing takes
// them back out. Measured over a full one-process run, that accumulation peaks
// at three — not worth reclaiming, and reclaiming it is actively wrong: a
// library that injects its stylesheet once per process (sonner) never injects
// it again, so giving sheets back leaves every later file without CSS the
// isolated run had. An earlier commit on this branch claimed a peak of 105;
// that figure does not reproduce, and what it actually counted is not known.

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

// jsdom lacks layout APIs on non-Element nodes AND on Range. ProseMirror's
// coordsAtPos (reached via a focus() scrollIntoView) calls getClientRects /
// getBoundingClientRect on the node OR a text Range at the caret — once
// reference chips are flanked by real spaces (reference-mention-whitespace.ts),
// the caret can land on a text node / text range at the doc edge. jsdom
// implements these on neither Text nodes nor Range. Stub both (Element has them
// natively, so `??=` won't override) → scroll-into-view no-ops in tests, real
// browsers compute real rects.
{
  const zeroRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const emptyRects = (): DOMRectList => [] as unknown as DOMRectList;
  const protos = [
    typeof Node !== 'undefined' ? Node.prototype : null,
    typeof Range !== 'undefined' ? Range.prototype : null,
  ];
  for (const proto of protos) {
    if (!proto) continue;
    const p = proto as unknown as {
      getClientRects?: () => DOMRectList;
      getBoundingClientRect?: () => DOMRect;
    };
    p.getClientRects ??= emptyRects;
    p.getBoundingClientRect ??= zeroRect;
  }
}

// jsdom implements no ClipboardEvent at all (checked against jsdom 29:
// `new ClipboardEvent('paste')` throws "ClipboardEvent is not defined").
// ProseMirror's own `view.pasteHTML(html)` constructs one when the caller does
// not supply an event, so without this the editor's real clipboard pipeline is
// unreachable from a test and paste behaviour could only be checked in a
// browser. The stub carries `clipboardData` because that is the field a paste
// event is defined by; ProseMirror does not read it on this path — the HTML
// comes in as an argument — so nothing here decides what gets pasted.
(globalThis as unknown as { ClipboardEvent?: unknown }).ClipboardEvent ??= class
  extends Event {
  readonly clipboardData: DataTransfer | null;

  constructor(
    type: string,
    init?: EventInit & { clipboardData?: DataTransfer | null },
  ) {
    super(type, init);
    this.clipboardData = init?.clipboardData ?? null;
  }
};

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
