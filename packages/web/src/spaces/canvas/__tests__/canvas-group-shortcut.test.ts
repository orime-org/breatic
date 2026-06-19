// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { matchGroupShortcut } from '@web/spaces/canvas/canvas-group-shortcut';
import type { ShortcutEvent } from '@web/spaces/canvas/canvas-history-shortcut';

/** Build a shortcut event, defaulting the modifiers to off. */
function ev(over: Partial<ShortcutEvent>): ShortcutEvent {
  return { key: 'g', metaKey: false, ctrlKey: false, shiftKey: false, ...over };
}

describe('matchGroupShortcut — keyboard → group/ungroup', () => {
  it('maps Cmd+G (mac) to group', () => {
    expect(matchGroupShortcut(ev({ key: 'g', metaKey: true }))).toBe('group');
  });

  it('maps Ctrl+G (windows) to group', () => {
    expect(matchGroupShortcut(ev({ key: 'g', ctrlKey: true }))).toBe('group');
  });

  it('maps Cmd+Shift+G to ungroup', () => {
    expect(
      matchGroupShortcut(ev({ key: 'g', metaKey: true, shiftKey: true })),
    ).toBe('ungroup');
  });

  it('maps Ctrl+Shift+G to ungroup', () => {
    expect(
      matchGroupShortcut(ev({ key: 'g', ctrlKey: true, shiftKey: true })),
    ).toBe('ungroup');
  });

  it('accepts an uppercase G (shift uppercases event.key)', () => {
    expect(
      matchGroupShortcut(ev({ key: 'G', metaKey: true, shiftKey: true })),
    ).toBe('ungroup');
  });

  it('ignores G without a modifier (a plain typed letter)', () => {
    expect(matchGroupShortcut(ev({ key: 'g' }))).toBeNull();
  });

  it('ignores other modified keys', () => {
    expect(matchGroupShortcut(ev({ key: 'z', metaKey: true }))).toBeNull();
  });
});
