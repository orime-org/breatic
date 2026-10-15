// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document Space taking up the cards the reader pressed for it
 * (inner#1509, design §5.4 step 3 · §5.7).
 *
 * The project page has opened this document; here every card waiting on it is
 * landed one after another in the order it was pressed, and how each ended is
 * reported back to the card. A "View" press writes nothing: it shows where the
 * change is, or, when the change is no longer in the document (the reader
 * undid it), tells the card the change is gone. Each change to the document
 * is counted, so a card reads again whether its change is still there.
 * Nothing is taken while there is no editor yet or
 * while the connection has not said whether it may write. When the editor
 * cannot be built at all -- this build is too old for the document, or the
 * document was refused before any content arrived -- every card waiting on it
 * is told it failed.
 */

import * as React from 'react';

import type { WriteAccess } from '@web/data/yjs/use-socket';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { landedAt, landProposal, type Landed } from '@web/spaces/document/document-proposal-landing';
import { pendingFor, useDocumentProposals } from '@web/stores/document-proposals';

/**
 * Lands the cards waiting on one document.
 * @param spaceId - The document Space.
 * @param handle - Its editor, or null while there is none.
 * @param writeAccess - What the connection said about writing.
 * @param unbuildable - Whether this document's editor cannot be built.
 * @returns Where the latest landing is in the body, if any.
 */
export function useDocumentProposalPickup(
  spaceId: string,
  handle: DocumentEditorHandle | null,
  writeAccess: WriteAccess,
  unbuildable: boolean,
): Landed | null {
  const pending = useDocumentProposals((s) => s.pending);
  const [landed, setLanded] = React.useState<Landed | null>(null);
  // One loop at a time: a second run of the effect (StrictMode, or a press
  // arriving mid-landing) leaves the presses to the loop already running.
  const busy = React.useRef(false);

  React.useEffect(() => {
    if (handle === null) return undefined;
    const { bump } = useDocumentProposals.getState();
    bump(spaceId);
    return handle.editor.onChange(() => {
      bump(spaceId);
    });
  }, [handle, spaceId]);

  React.useEffect(() => {
    if (unbuildable) {
      useDocumentProposals.getState().reportSpace(spaceId, 'failed');
      return;
    }
    if (handle === null || writeAccess === 'unknown' || busy.current) return;
    busy.current = true;
    const { report } = useDocumentProposals.getState();
    void (async () => {
      for (;;) {
        const next = pendingFor(spaceId)[0];
        if (next === undefined) break;
        const id = next.proposal.proposalId;
        if (next.action === 'view') {
          const at = landedAt(handle, next.proposal);
          report(id, at === null ? 'gone' : 'applied');
          if (at !== null) setLanded(at);
          continue;
        }
        const result = await landProposal(handle, next.proposal, next.action, writeAccess === 'granted').catch(
          () => ({ outcome: 'failed' }) as const,
        );
        report(id, result.outcome, 'leftOut' in result ? result.leftOut : 0);
        if (result.outcome === 'applied') {
          const { outcome: _outcome, leftOut: _leftOut, ...at } = result;
          setLanded(at);
        }
      }
      busy.current = false;
    })();
  }, [handle, pending, spaceId, unbuildable, writeAccess]);

  return landed;
}
