// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach } from 'vitest';

import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

/**
 * Override `navigator.platform` so each test can exercise the mac vs windows
 * branch deterministically (jsdom's default platform is environment-dependent).
 * @param value - The platform string to report.
 */
function setPlatform(value: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    value,
    configurable: true,
  });
}

describe('formatShortcut', () => {
  afterEach(() => setPlatform(''));

  it('mac: uses the Cmd / Shift glyphs with no separators', () => {
    setPlatform('MacIntel');
    expect(formatShortcut({ mod: true, key: 'V' })).toBe('⌘V');
    expect(formatShortcut({ mod: true, key: 'C' })).toBe('⌘C');
    expect(formatShortcut({ mod: true, key: 'D' })).toBe('⌘D');
    expect(formatShortcut({ mod: true, key: 'G' })).toBe('⌘G');
    expect(formatShortcut({ mod: true, shift: true, key: 'G' })).toBe('⌘⇧G');
    expect(formatShortcut({ key: 'Delete' })).toBe('⌫');
  });

  it('windows: uses Ctrl / Shift names joined with "+"', () => {
    setPlatform('Win32');
    expect(formatShortcut({ mod: true, key: 'V' })).toBe('Ctrl+V');
    expect(formatShortcut({ mod: true, shift: true, key: 'G' })).toBe(
      'Ctrl+Shift+G',
    );
    expect(formatShortcut({ key: 'Delete' })).toBe('Del');
  });
});
