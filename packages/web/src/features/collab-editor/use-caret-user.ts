// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The identity this client publishes at its caret for other collaborators.
 *
 * Shared by every collaborative editor in the app (the canvas prompt editor
 * and the document body), so a person shows up the same way wherever their
 * cursor appears.
 *
 * It is the user id, and only the user id (#1882). Peers resolve the display
 * name from the project member roster — server data, current by construction —
 * and derive the colour from the same id, so both ends compute it identically
 * without anyone publishing it. Publishing identity was what let one account
 * show up under two different names in two tabs: each tab broadcast its own
 * snapshot of the store, and whichever wrote last won.
 */

import * as React from 'react';

import { useCurrentUserStore } from '@web/stores/current-user';

/** A caret identity as it travels over awareness. */
export interface CaretUserIdentity {
  /** The collaborator's user id — everything else is derived from it. */
  id: string;
}

/**
 * Build this user's caret identity, stable across renders.
 *
 * Memoised on the id alone, so a rename or an avatar change does not produce a
 * new object: the identity on the wire genuinely has not changed, and a new
 * reference would re-publish awareness and re-run every effect that depends on
 * it for nothing.
 * @returns The identity, or null while no user is resolved (the caret layer
 *   stays unmounted until then).
 */
export function useCaretUser(): CaretUserIdentity | null {
  const userId = useCurrentUserStore((s) => s.user?.id);
  return React.useMemo(
    () => (userId === undefined ? null : { id: userId }),
    [userId],
  );
}
