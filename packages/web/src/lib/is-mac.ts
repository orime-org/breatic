// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the current platform is macOS / iOS (Cmd-based) vs Windows / Linux
 * (Ctrl-based). Reads `navigator.platform` (falling back to the user agent).
 * @returns True on macOS / iOS.
 */
export function isMac(): boolean {
  const id = navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(id);
}
