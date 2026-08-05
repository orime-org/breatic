// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The identity this client publishes at its caret for other collaborators.
 *
 * Shared by every collaborative editor in the app (the canvas prompt editor
 * and the document body), so a person shows up under the same name and colour
 * wherever their cursor appears.
 */

import * as React from 'react';

import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import { useCurrentUserStore } from '@web/stores/current-user';

/** A caret identity as it travels over awareness. */
export interface CaretUserIdentity {
  /** Display name shown beside the remote caret. */
  name: string;
  /**
   * A concrete 6-digit hex. This is what the wire carries because
   * y-prosemirror validates `user.color` against that format and warns on
   * every caret update otherwise.
   */
  color: string;
  /**
   * The palette hue receivers actually render from — it resolves to a theme
   * token, so a caret stays legible in whichever theme the VIEWER is using.
   */
  hue: string;
}

/**
 * Build this user's caret identity, stable across renders.
 *
 * The colour is derived from the user id, so the same person keeps the same
 * caret colour across sessions and across every editor in the app.
 * @returns The identity, or null while no user is resolved (the caret layer
 *   stays unmounted until then).
 */
export function useCaretUser(): CaretUserIdentity | null {
  const currentUser = useCurrentUserStore((s) => s.user);
  return React.useMemo(() => {
    if (!currentUser) return null;
    const hue = userPaletteHue(currentUser.id);
    return {
      name: currentUser.name || currentUser.email,
      color: resolvePaletteHex(hue),
      hue,
    };
  }, [currentUser]);
}
