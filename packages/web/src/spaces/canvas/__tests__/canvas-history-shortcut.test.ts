// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';

/** Build the minimal keyboard-event shape the matcher reads. */
function ev(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
} {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
  };
}

describe('matchHistoryShortcut (double-platform mac + windows)', () => {
  it('undo: Cmd+Z (mac) and Ctrl+Z (windows) both match undo', () => {
    expect(matchHistoryShortcut(ev('z', { meta: true }))).toBe('undo');
    expect(matchHistoryShortcut(ev('z', { ctrl: true }))).toBe('undo');
  });

  it('redo: Cmd+Shift+Z (mac) and Ctrl+Shift+Z (windows) both match redo', () => {
    expect(matchHistoryShortcut(ev('z', { meta: true, shift: true }))).toBe(
      'redo',
    );
    expect(matchHistoryShortcut(ev('z', { ctrl: true, shift: true }))).toBe(
      'redo',
    );
  });

  it('redo: Ctrl+Y (windows-only convention) matches redo', () => {
    expect(matchHistoryShortcut(ev('y', { ctrl: true }))).toBe('redo');
  });

  it('handles the shift-uppercased key (Cmd+Shift+Z reports key "Z")', () => {
    expect(matchHistoryShortcut(ev('Z', { meta: true, shift: true }))).toBe(
      'redo',
    );
    expect(matchHistoryShortcut(ev('Z', { meta: true }))).toBe('undo');
  });

  it('requires a modifier: a bare z / y is not a shortcut', () => {
    expect(matchHistoryShortcut(ev('z'))).toBeNull();
    expect(matchHistoryShortcut(ev('y'))).toBeNull();
  });

  it('ignores unrelated modified keys', () => {
    expect(matchHistoryShortcut(ev('a', { meta: true }))).toBeNull();
    expect(matchHistoryShortcut(ev('s', { ctrl: true }))).toBeNull();
  });

  it('Cmd+Y on mac falls through to redo (harmless cross-platform overlap)', () => {
    // mac has no Cmd+Y redo convention, but accepting it costs nothing and
    // keeps the matcher platform-agnostic (we key off modifier identity, not
    // the OS). Documented so a future reader knows it is intentional.
    expect(matchHistoryShortcut(ev('y', { meta: true }))).toBe('redo');
  });
});
