// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { matchDuplicateShortcut } from '@web/spaces/canvas/canvas-duplicate-shortcut';

/**
 * Build a minimal keydown event for the matcher.
 * @param over - Fields overriding the plain-`d` default.
 * @returns A keyboard event stand-in.
 */
function ev(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 'd',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...over,
  } as KeyboardEvent;
}

describe('matchDuplicateShortcut', () => {
  it('matches Cmd+D (mac) and Ctrl+D (windows)', () => {
    expect(matchDuplicateShortcut(ev({ metaKey: true }))).toBe(true);
    expect(matchDuplicateShortcut(ev({ ctrlKey: true }))).toBe(true);
    expect(matchDuplicateShortcut(ev({ metaKey: true, key: 'D' }))).toBe(true);
  });

  it('ignores plain D, the Shift variant, and other keys', () => {
    expect(matchDuplicateShortcut(ev({}))).toBe(false);
    expect(matchDuplicateShortcut(ev({ metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(matchDuplicateShortcut(ev({ metaKey: true, key: 'g' }))).toBe(false);
  });
});
