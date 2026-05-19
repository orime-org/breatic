import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-clean DOM after each test to prevent leakage across tests.
afterEach(() => {
  cleanup();
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
