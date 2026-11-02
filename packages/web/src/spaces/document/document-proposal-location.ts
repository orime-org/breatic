// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { peekDocumentEditor, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { landedAt, type Landed, type SourceTarget } from '@web/spaces/document/document-proposal-landing';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import type { PendingDocumentProposal } from '@web/stores/document-proposals';

/**
 * An immutable result published by one valid execution for one document:
 * where a proposal landed, or where a locate press found it points (inner#1646).
 */
export type ProposalLocation = Readonly<(Landed | SourceTarget) & {
  /** The canonical name of the document holding the result. */
  documentName: string;
  /** The cache handle that accepted the result. */
  handle: DocumentEditorHandle;
  /** The request that was valid at publication, including its proposal. */
  pending: PendingDocumentProposal;
  /** The execution that held publication rights when this object was made. */
  owner: object;
}>;

/**
 * Checks whether a published result is still consumable by its document.
 * Normal reporting and execution completion do not revoke a published result.
 * @param location - The previously published result.
 * @param editor - The editor consuming it.
 * @returns Whether its current document still holds the corresponding trace; a located proposal is checked against its handle only.
 */
export function isCurrentProposalLocation(location: ProposalLocation | null, editor: ToolEditor): boolean {
  if (
    location === null ||
    location.handle.editor !== editor ||
    peekDocumentEditor(location.documentName) !== location.handle
  ) return false;
  // Where a located proposal points is read from the document when it is drawn.
  if (location.how === 'source') return true;
  const at = landedAt(location.handle, location.pending.proposal);
  if (at === null || at.how !== location.how) return false;
  return at.how === 'comment'
    ? location.how === 'comment' && at.threadId === location.threadId
    : at.blockId === location.blockId;
}
