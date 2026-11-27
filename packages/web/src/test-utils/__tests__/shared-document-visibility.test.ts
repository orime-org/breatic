// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Every file in this package runs in one process and shares one jsdom
 * document (vitest.config.mts). A test that steers the tab's visibility puts
 * its own `visibilityState` and `hidden` on that document; left standing at
 * hidden, it hands every later file a hidden tab, and code that syncs only a
 * visible tab (`chatLive`) never syncs (inner#2168). vitest.setup.ts takes
 * them back after every test, so a test can end any way it likes.
 *
 * The cases run in order: the first leaves the tab hidden, the second reads
 * what the next test, or the next file, would see.
 */
import { describe, expect, it } from 'vitest';

describe('the shared document after a test that hid the tab', () => {
  it('a test leaves the tab hidden', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    expect(document.visibilityState).toBe('hidden');
  });

  it('the next test sees the visible tab jsdom starts with', () => {
    expect(document.visibilityState).toBe('visible');
    expect(document.hidden).toBe(false);
  });
});
