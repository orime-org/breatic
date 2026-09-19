// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { STORAGE_KEYS } from '@web/lib/storage-keys';

/**
 * Whether this browser has held a session before — design §6.2, the preload gate.
 *
 * Read before `/auth/me` can answer, to decide whether a page behind the auth
 * gate is worth fetching early. Never a permission check: the gate itself is
 * `ProtectedRoute` and the server, and being wrong here costs one chunk.
 *
 * Unreadable storage answers no, which is the side that costs a round trip
 * rather than a download the reader is about to be bounced away from.
 * @returns True when a session has been seen in this browser.
 */
export function hasSeenSession(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.sessionSeen) !== null;
  } catch {
    return false;
  }
}

/**
 * Record whether this browser holds a session, for the next cold load.
 *
 * The single writer for the preload gate's state (design §6.2). It is called
 * from the two places
 * that own the fact it mirrors — `useCurrentUserStore`'s `setUser` and `clear`
 * — so every event in that table is covered: the boot ping answering either
 * way, a sign-in, and a sign-out.
 * @param seen - True when the app now holds a user.
 */
export function rememberSession(seen: boolean): void {
  try {
    if (seen) {
      localStorage.setItem(STORAGE_KEYS.sessionSeen, '1');
    } else {
      localStorage.removeItem(STORAGE_KEYS.sessionSeen);
    }
  } catch {
    // Storage is unavailable; the reader pays one uncached chunk.
  }
}
