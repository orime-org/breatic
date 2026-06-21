// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Match the duplicate keyboard shortcut: Cmd+D on macOS, Ctrl+D on Windows /
 * Linux. Accepts either modifier via `metaKey || ctrlKey` (mirroring
 * {@link matchGroupShortcut}), and rejects the Shift variant so it doesn't
 * collide with other chords. Drives both the keydown handler and the menu's
 * shortcut hint, so the hint matches the key that actually works.
 * @param event - The keydown event.
 * @returns True when the duplicate chord (mod + D, no Shift) is pressed.
 */
export function matchDuplicateShortcut(event: KeyboardEvent): boolean {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.shiftKey) return false;
  return event.key.toLowerCase() === 'd';
}
