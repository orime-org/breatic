// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The page's visibility is part of the one document every file shares, so a
 * test that hides the tab and never shows it again hands every later file a
 * hidden page: the chat sync and the Studio page poll then never ask, and a
 * file far from the cause fails on an empty list (inner#2168). The shared
 * `afterEach` in `vitest.setup.ts` hands the next test a visible page.
 *
 * The two cases run in order: the first leaves the tab hidden, the second
 * reads what the next test starts with.
 */
import { describe, expect, it } from 'vitest';

describe('the page visibility a test leaves behind', () => {
  it('may be left hidden by a test', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    expect(document.visibilityState).toBe('hidden');
  });

  it('is visible again when the next test starts', () => {
    expect(document.visibilityState).not.toBe('hidden');
    expect(document.hidden).toBe(false);
  });
});
