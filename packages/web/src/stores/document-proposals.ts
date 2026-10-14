// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each document proposal card's state (inner#1509, design §5.7).
 *
 * A card's state is written in three places only: `start` when the reader
 * presses it, `view` when they press "View" on a card that landed, and
 * `report` when the press ends -- the project page
 * reports a document that is gone or a tab closed before the press was taken
 * up, the document Space reports the landing. Cards are kept by proposal id,
 * so several cards can wait on one document at once, and the document takes
 * them up in the order they were pressed.
 *
 * Nothing is stored: a reload shows every card as it first was, and a card
 * that already landed is known from the document itself.
 */

import { create } from 'zustand';
import type { DocumentProposal } from '@breatic/shared';

/** What the reader pressed: put it on as a comment, or write it into the body. */
export type LandingAction = 'comment' | 'write';

/** Where a card stands. */
export type DocumentProposalCardState =
  | 'working'
  | 'applied'
  | 'changed'
  | 'blockGone'
  | 'readOnly'
  | 'spaceGone'
  | 'failed';

/**
 * How a press ended. `reset`: a "View" press found the change no longer in
 * the document, so the card goes back to how it first was.
 */
export type DocumentProposalOutcome = Exclude<DocumentProposalCardState, 'working'> | 'reset';

/** A press waiting for its document: landing it, or only showing where it landed. */
export interface PendingDocumentProposal {
  proposal: DocumentProposal;
  action: LandingAction | 'view';
  /** When it was pressed, relative to the other presses. */
  order: number;
}

/** Every card's state, and the presses still waiting. */
interface DocumentProposalsState {
  cards: Readonly<Partial<Record<string, { state: DocumentProposalCardState; action: LandingAction }>>>;
  pending: Readonly<Partial<Record<string, PendingDocumentProposal>>>;
  /** How many presses there have been, for their order. */
  pressed: number;
  /** How many times each document has changed since it was opened here, for cards to read it again. */
  docVersion: Readonly<Partial<Record<string, number>>>;
  /** A press: ignored while the same card is working. */
  start: (proposal: DocumentProposal, action: LandingAction) => void;
  /** A "View" press on a card that landed the way given; writes nothing. */
  view: (proposal: DocumentProposal, landed: LandingAction) => void;
  /** One document changed. */
  bump: (spaceId: string) => void;
  /** How a press ended: ignored for a card that is not working. */
  report: (proposalId: string, outcome: DocumentProposalOutcome) => void;
  /** The same ending for every press waiting on one document. */
  reportSpace: (spaceId: string, outcome: DocumentProposalOutcome) => void;
  reset: () => void;
}

/**
 * The state with one waiting press ended.
 * @param s - The state.
 * @param proposalId - The card.
 * @param outcome - How it ended.
 * @returns The changes.
 */
function ended(
  s: DocumentProposalsState,
  proposalId: string,
  outcome: DocumentProposalOutcome,
): Pick<DocumentProposalsState, 'cards' | 'pending'> {
  const waiting = s.pending[proposalId];
  if (waiting === undefined) return { cards: s.cards, pending: s.pending };
  const { [proposalId]: _gone, ...pending } = s.pending;
  const { [proposalId]: card, ...others } = s.cards;
  if (outcome === 'reset' || card === undefined) return { cards: others, pending };
  return { cards: { ...others, [proposalId]: { state: outcome, action: card.action } }, pending };
}

export const useDocumentProposals = create<DocumentProposalsState>()((set) => ({
  cards: {},
  pending: {},
  pressed: 0,
  docVersion: {},
  start: (proposal, action) =>
    set((s) => {
      const id = proposal.proposalId;
      if (s.pending[id] !== undefined) return s;
      return {
        cards: { ...s.cards, [id]: { state: 'working', action } },
        pending: { ...s.pending, [id]: { proposal, action, order: s.pressed } },
        pressed: s.pressed + 1,
      };
    }),
  view: (proposal, landed) =>
    set((s) => {
      const id = proposal.proposalId;
      if (s.pending[id] !== undefined) return s;
      return {
        cards: { ...s.cards, [id]: { state: 'applied', action: landed } },
        pending: { ...s.pending, [id]: { proposal, action: 'view', order: s.pressed } },
        pressed: s.pressed + 1,
      };
    }),
  bump: (spaceId) => set((s) => ({ docVersion: { ...s.docVersion, [spaceId]: (s.docVersion[spaceId] ?? 0) + 1 } })),
  report: (proposalId, outcome) => set((s) => ended(s, proposalId, outcome)),
  reportSpace: (spaceId, outcome) =>
    set((s) =>
      Object.values(s.pending)
        .filter((p): p is PendingDocumentProposal => p?.proposal.spaceId === spaceId)
        .reduce<Pick<DocumentProposalsState, 'cards' | 'pending'>>(
          (acc, p) => ended({ ...s, ...acc }, p.proposal.proposalId, outcome),
          { cards: s.cards, pending: s.pending },
        ),
    ),
  reset: () => set({ cards: {}, pending: {}, pressed: 0, docVersion: {} }),
}));

/**
 * The presses waiting on one document, in the order they were made.
 * @param spaceId - The document.
 * @returns The presses.
 */
export function pendingFor(spaceId: string): PendingDocumentProposal[] {
  return Object.values(useDocumentProposals.getState().pending)
    .filter((p): p is PendingDocumentProposal => p?.proposal.spaceId === spaceId)
    .sort((a, b) => a.order - b.order);
}
