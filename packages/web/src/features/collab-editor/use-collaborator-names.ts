// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Resolving a collaborator's display name from the project member roster.
 *
 * Awareness carries a user id and nothing else (#1882), so whoever renders a
 * remote caret has to turn that id into a name. The roster is the place: it
 * comes from the server, where a person's name is their personal studio's
 * name, so it is current by construction and cannot disagree between two tabs
 * the way a broadcast snapshot did.
 *
 * The caret renderer lives inside ProseMirror, outside React, and the caret
 * extension is configured once when the editor is built — an editor that
 * survives Space-tab switches by design and is never rebuilt. So it cannot be
 * handed data; it is handed a function whose reference never changes and which
 * reads whatever the roster holds at call time.
 */

import * as React from 'react';

import type { Member } from '@web/data/api/members';
import type { ResolveCollaboratorName } from '@web/features/collab-editor/caret-render';

/**
 * Look a display name up in a roster snapshot.
 *
 * A blank name counts as unresolved. The roster merge fills
 * `name: profile?.name ?? ''` for a member whose profile query has not landed,
 * so "not listed" and "listed with nothing in it" arrive through the same door
 * and mean the same thing to a caret: nothing to put on a label.
 * @param members - The roster as currently known.
 * @param userId - The collaborator to name.
 * @returns The display name, or null when it cannot be resolved.
 */
export function resolveNameFrom(
  members: readonly Member[],
  userId: string,
): string | null {
  const found = members.find((m) => m.userId === userId);
  const name = found?.name.trim();
  return name ? name : null;
}

/**
 * A resolver whose reference is stable for the lifetime of the component while
 * the roster behind it keeps moving.
 *
 * The stability is the load-bearing part. The caret extension keeps the
 * function it was given at construction; a resolver rebuilt on every roster
 * change would leave the extension calling a closure over the first roster it
 * ever saw — and it would look fine right up until the first rename.
 * @param members - The roster as currently known.
 * @returns A stable resolver reading the latest roster.
 */
export function useResolverRef(
  members: readonly Member[],
): ResolveCollaboratorName {
  const membersRef = React.useRef(members);
  membersRef.current = members;
  return React.useCallback(
    (userId: string) => resolveNameFrom(membersRef.current, userId),
    [],
  );
}
