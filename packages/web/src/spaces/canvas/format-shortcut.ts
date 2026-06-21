// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** A keyboard shortcut descriptor for display in a menu. */
export interface ShortcutSpec {
  /** The platform modifier — Cmd on macOS, Ctrl on Windows / Linux. */
  mod?: boolean;
  /** Whether Shift is part of the chord. */
  shift?: boolean;
  /** The base key, e.g. `'V'`, `'C'`, `'G'`, or the special `'Delete'`. */
  key: string;
}

/**
 * Whether the current platform is macOS / iOS (Cmd-based) vs Windows / Linux
 * (Ctrl-based). Reads `navigator.platform` (falling back to the user agent).
 * @returns True on macOS / iOS.
 */
function isMac(): boolean {
  const id = navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(id);
}

/**
 * Format a keyboard shortcut for display in a context menu, platform-aware:
 * macOS uses the ⌘ / ⇧ glyphs with no separators (`⌘⇧G`), Windows / Linux uses
 * `Ctrl` / `Shift` joined by `+` (`Ctrl+Shift+G`). The special key `'Delete'`
 * renders as ⌫ (mac) / `Del` (win). Mirrors the both-platform input handling
 * (`metaKey || ctrlKey`) so the hint matches the key that actually works.
 * @param spec - The shortcut descriptor.
 * @returns The display string for the current platform.
 */
export function formatShortcut(spec: ShortcutSpec): string {
  const mac = isMac();
  const key = spec.key === 'Delete' ? (mac ? '⌫' : 'Del') : spec.key;
  const parts: string[] = [];
  if (spec.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (spec.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(key);
  return mac ? parts.join('') : parts.join('+');
}
