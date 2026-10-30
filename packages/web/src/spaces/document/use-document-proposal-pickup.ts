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

import { readDocConnection, type WriteAccess } from '@web/data/yjs/collab-socket';
import { peekDocumentEditor, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { requestCommentLocation } from '@web/spaces/document/document-comment-selection';
import { landedAt, landProposal, type ProposalAdmission } from '@web/spaces/document/document-proposal-landing';
import type { ProposalLocation } from '@web/spaces/document/document-proposal-location';
import { pendingFor, useDocumentProposals, type PendingDocumentProposal } from '@web/stores/document-proposals';

/** The execution holding this handle's serial queue. */
interface PickupOwner {
  readonly handle: DocumentEditorHandle;
  readonly name: string;
}

/**
 * Lands the cards waiting on one document.
 * @param spaceId - The document Space.
 * @param handle - Its editor, or null while there is none.
 * @param writeAccess - What the connection said about writing.
 * @param unbuildable - Whether this document's editor cannot be built.
 * @param name - The canonical document connection and cache name.
 * @returns Where the latest landing is in the body, if any.
 */
export function useDocumentProposalPickup(
  spaceId: string,
  handle: DocumentEditorHandle | null,
  writeAccess: WriteAccess,
  unbuildable: boolean,
  name: string,
): ProposalLocation | null {
  const pending = useDocumentProposals((s) => s.pending);
  const [landed, setLanded] = React.useState<ProposalLocation | null>(null);
  const busy = React.useRef<PickupOwner | null>(null);
  const context = React.useRef({ handle, name, spaceId, unbuildable });
  context.current = { handle, name, spaceId, unbuildable };

  React.useEffect(() => {
    setLanded((current) => current !== null && (
      current.documentName !== name ||
      peekDocumentEditor(name) !== current.handle ||
      (handle !== null && current.handle !== handle) ||
      unbuildable
    ) ? null : current);
  }, [handle, name, unbuildable]);

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
    if (
      handle === null ||
      writeAccess === 'unknown' ||
      (busy.current?.handle === handle && busy.current.name === name)
    ) return;
    const connection = readDocConnection(name);
    if (connection === null || !connection.hasEverSynced || connection.writeAccess === 'unknown') return;
    const owner: PickupOwner = { handle, name };
    busy.current = owner;
    const { report } = useDocumentProposals.getState();

    /**
     * Reads execution identity independently of hidden component mirrors.
     * @returns Whether the captured handle and provider still own this queue.
     */
    const ownsDocument = (): boolean => {
      const current = context.current;
      const live = readDocConnection(name);
      return busy.current === owner &&
        current.name === name && current.spaceId === spaceId &&
        !current.unbuildable &&
        (current.handle === null || current.handle === handle) &&
        peekDocumentEditor(name) === handle &&
        live !== null && live.provider === connection.provider &&
        live.document === connection.document && live.hasEverSynced;
    };

    /**
     * Checks publication rights for the exact request now being completed.
     * @param request - The request captured before asynchronous preparation.
     * @returns Whether this completion still owns the pending request.
     */
    const canComplete = (request: PendingDocumentProposal): boolean =>
      ownsDocument() && useDocumentProposals.getState().pending[request.proposal.proposalId] === request;

    void (async () => {
      try {
        while (ownsDocument()) {
          const next = pendingFor(spaceId)[0];
          if (next === undefined) break;
          const id = next.proposal.proposalId;

          /**
           * Reads commit-time admission from current connection facts.
           * @returns Admission for this exact pending request.
           */
          const readAdmission = (): ProposalAdmission => {
            if (!canComplete(next)) return { available: false, writeAccess: 'unknown' };
            return { available: true, writeAccess: readDocConnection(name)!.writeAccess };
          };

          const result = next.action === 'view'
            ? { outcome: landedAt(handle, next.proposal) === null ? 'gone' : 'applied' } as const
            : await landProposal(handle, next.proposal, next.action, readAdmission).catch(
              () => ({ outcome: 'failed' }) as const,
            );
          if (!canComplete(next)) continue;
          let outcome = result.outcome;
          if (outcome === 'applied') {
            const at = landedAt(handle, next.proposal);
            if (at === null) {
              outcome = 'gone';
            } else {
              const location: ProposalLocation = Object.freeze({
                ...at, documentName: name, handle, pending: next, owner,
              });
              if (location.how === 'comment') requestCommentLocation(handle.editor, location);
              setLanded(location);
            }
          }
          report(id, outcome, 'leftOut' in result ? result.leftOut : 0);
        }
      } finally {
        if (busy.current === owner) busy.current = null;
      }
    })();
  }, [handle, name, pending, spaceId, unbuildable, writeAccess]);

  return landed;
}
