// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The project page sending each pressed document card to its document
 * (inner#1509, design §5.4 step 2 · §5.7).
 *
 * The project page holds the tab strip, so it is the one that opens or
 * switches to the card's document, and the one that knows when that document
 * is gone or its tab was closed before the document took the card up -- both
 * are reported here. Judged only once the project's Spaces have arrived: an
 * unsynced project reads as one with no Spaces, and every card would look
 * like it was for a document that is gone.
 */

import * as React from 'react';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useDocumentProposals } from '@web/stores/document-proposals';

/**
 * Sends pressed document cards to their documents.
 * @param spaces - The project's Spaces.
 * @param openIds - The Spaces whose tabs are open.
 * @param activeId - The Space in front, if any.
 * @param open - Opens a Space's tab, or switches to it.
 * @param ready - Whether the project's Spaces have arrived.
 */
export function useDocumentProposalRouting(
  spaces: readonly ProjectSpace[],
  openIds: readonly string[],
  activeId: string | null,
  open: (spaceId: string) => void,
  ready: boolean,
): void {
  const pending = useDocumentProposals((s) => s.pending);
  // Cards whose document has been opened for them: from here on, their tab
  // going away is a card the document will never take up.
  const routed = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (!ready) return;
    const { report } = useDocumentProposals.getState();
    for (const waiting of Object.values(pending)) {
      if (waiting === undefined) continue;
      const { proposalId, spaceId } = waiting.proposal;
      const space = spaces.find((s) => s.id === spaceId);
      if (space?.type !== 'document') {
        report(proposalId, 'spaceGone');
      } else if (!routed.current.has(proposalId)) {
        routed.current.add(proposalId);
        if (activeId !== spaceId) open(spaceId);
      } else if (!openIds.includes(spaceId)) {
        report(proposalId, 'failed');
      }
    }
    for (const id of routed.current) if (pending[id] === undefined) routed.current.delete(id);
  }, [activeId, open, openIds, pending, ready, spaces]);
}
