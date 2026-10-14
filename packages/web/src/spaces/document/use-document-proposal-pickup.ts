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
 * undid it), puts the card back as it first was. Each change to the document
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
import { landedAs, landProposal, revealBlockOf } from '@web/spaces/document/document-proposal-landing';
import { pendingFor, useDocumentProposals } from '@web/stores/document-proposals';

/** The block a card just landed, for the body to bring into view. */
export interface LandedBlock {
  blockId: string;
  /** Which card landed it, so landing the same block twice still reads as new. */
  proposalId: string;
}

/**
 * Lands the cards waiting on one document.
 * @param spaceId - The document Space.
 * @param handle - Its editor, or null while there is none.
 * @param writeAccess - What the connection said about writing.
 * @param unbuildable - Whether this document's editor cannot be built.
 * @returns The block the latest landing put in the body, if any.
 */
export function useDocumentProposalPickup(
  spaceId: string,
  handle: DocumentEditorHandle | null,
  writeAccess: WriteAccess,
  unbuildable: boolean,
): LandedBlock | null {
  const pending = useDocumentProposals((s) => s.pending);
  const [landed, setLanded] = React.useState<LandedBlock | null>(null);
  // Cards already taken up by this document, so a second run of the effect
  // (StrictMode, or a press arriving mid-landing) never lands one twice.
  const taken = React.useRef(new Set<string>());
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
      if (pendingFor(spaceId).length > 0) useDocumentProposals.getState().reportSpace(spaceId, 'failed');
      return;
    }
    if (handle === null || writeAccess === 'unknown' || busy.current) return;
    busy.current = true;
    const { report } = useDocumentProposals.getState();
    void (async () => {
      for (;;) {
        const next = pendingFor(spaceId).find((p) => !taken.current.has(p.proposal.proposalId));
        if (next === undefined) break;
        const id = next.proposal.proposalId;
        if (next.action === 'view') {
          const how = landedAs(handle, next.proposal);
          report(id, how === null ? 'reset' : 'applied');
          if (how !== null) setLanded({ blockId: revealBlockOf(next.proposal, how), proposalId: id });
          continue;
        }
        taken.current.add(id);
        const result = await landProposal(handle, next.proposal, next.action, writeAccess === 'granted').catch(
          () => ({ outcome: 'failed' }) as const,
        );
        report(id, result.outcome);
        taken.current.delete(id);
        if (result.outcome === 'applied') setLanded({ blockId: result.blockId, proposalId: id });
      }
      busy.current = false;
    })();
  }, [handle, pending, spaceId, unbuildable, writeAccess]);

  return landed;
}
