// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  matchGroupShortcut,
  planGroupShortcut,
} from '@web/spaces/canvas/canvas-group-shortcut';
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

describe('planGroupShortcut — swallow the chord, run only when it applies', () => {
  it('Cmd+G with a groupable selection: swallow + run group', () => {
    expect(planGroupShortcut('group', 'group')).toEqual({
      preventDefault: true,
      run: 'group',
    });
  });

  it('Cmd+G when the selection mixes a group with loose nodes (offer none): swallow but NO-OP', () => {
    // The reported bug: Cmd+G here used to fall through to the browser's native
    // Cmd+G (find-again). B decision — swallow the chord, do nothing.
    expect(planGroupShortcut('group', 'none')).toEqual({
      preventDefault: true,
      run: null,
    });
  });

  it('Cmd+Shift+G on a selected group: swallow + run ungroup', () => {
    expect(planGroupShortcut('ungroup', 'ungroup')).toEqual({
      preventDefault: true,
      run: 'ungroup',
    });
  });

  it('Cmd+Shift+G when nothing is ungroupable (offer none): swallow but NO-OP', () => {
    expect(planGroupShortcut('ungroup', 'none')).toEqual({
      preventDefault: true,
      run: null,
    });
  });

  it('Cmd+G on a single selected group (offer ungroup, not group): swallow but NO-OP', () => {
    // The chord is still a grouping chord (swallow it), but group does not apply
    // when the offer is ungroup — don't run the wrong action.
    expect(planGroupShortcut('group', 'ungroup')).toEqual({
      preventDefault: true,
      run: null,
    });
  });

  it('a non-grouping chord (action null) passes through untouched', () => {
    expect(planGroupShortcut(null, 'group')).toEqual({
      preventDefault: false,
      run: null,
    });
  });
});
