// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each document proposal card's state (inner#1509, design §5.7).
 *
 * A card's state is written by `start` when the reader presses it, `view`
 * when they press "View" on a card that landed, and `report` (or
 * `reportSpace` for every press on one document) when the press ends -- the
 * project page reports a document that is gone or a tab closed before the
 * press was taken up, the document Space reports the landing; `reset` clears
 * them all when the project is left. Cards are kept by proposal id,
 * so several cards can wait on one document at once, and the document takes
 * them up in the order they were pressed.
 *
 * A card holds only where it stands: working, or landed. A press that did not
 * land is told with a toast, here where it is reported, and the card goes
 * back to how it first was so it can be pressed again (design §5.7).
 *
 * Nothing is stored: a reload shows every card as it first was, and a card
 * that already landed is known from the document itself.
 */

import { create } from 'zustand';
import { t, type DocumentProposal } from '@breatic/shared';

import { toast } from '@web/lib/toast';

/** What the reader pressed: put it on as a comment, or write it into the body. */
export type LandingAction = 'comment' | 'write';

/** Where a card stands. */
export type DocumentProposalCardState = 'working' | 'applied';

/**
 * How a press ended. `gone`: a "View" press found the change no longer in
 * the document. `mediaOnly`: nothing was left to write once the media whose
 * address is not in our storage were left out.
 */
export type DocumentProposalOutcome =
  | 'applied'
  | 'changed'
  | 'blockGone'
  | 'readOnly'
  | 'spaceGone'
  | 'gone'
  | 'mediaOnly'
  | 'failed';

/** The warning a press that was stopped is told with: nothing broke, it was not done. */
const WARNING_KEY: Readonly<Record<'changed' | 'blockGone' | 'readOnly' | 'spaceGone' | 'gone', string>> = {
  changed: 'chat.documentProposal.changed',
  blockGone: 'chat.documentProposal.blockGone',
  readOnly: 'chat.documentProposal.readOnly',
  spaceGone: 'chat.documentProposal.spaceGone',
  gone: 'chat.documentProposal.gone',
};

/** What a press puts in the document: a comment either way, else the rewrite or the insert itself. */
export type PressKind = 'comment' | 'rewrite' | 'insert';

/**
 * What a press puts in the document.
 * @param proposal - The proposal.
 * @param action - What was pressed.
 * @returns The kind of change.
 */
export function pressKind(proposal: DocumentProposal, action: LandingAction): PressKind {
  return action === 'comment' ? 'comment' : proposal.kind === 'insert' ? 'insert' : 'rewrite';
}

/** The error a press whose writing failed is told with, by what was pressed. */
const FAILED_KEY: Readonly<Record<PressKind, string>> = {
  comment: 'chat.documentProposal.failedComment',
  rewrite: 'chat.documentProposal.failedRewrite',
  insert: 'chat.documentProposal.failedInsert',
};

/**
 * Tells the reader how a press ended, when it is anything a toast says.
 * @param proposal - The proposal pressed.
 * @param action - What it was pressed to do.
 * @param outcome - How it ended.
 * @param leftOut - How many media were left out of what it wrote.
 */
function tell(proposal: DocumentProposal, action: LandingAction, outcome: DocumentProposalOutcome, leftOut: number): void {
  if (outcome === 'failed') {
    toast.error(t(FAILED_KEY[pressKind(proposal, action)]));
  } else if (outcome === 'applied' || outcome === 'mediaOnly') {
    if (leftOut > 0) toast.warning(t('chat.documentProposal.mediaLeftOut', { count: leftOut }));
  } else {
    toast.warning(t(WARNING_KEY[outcome]));
  }
}

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
  /** A press: ignored while a press of the same card is waiting. */
  start: (proposal: DocumentProposal, action: LandingAction) => void;
  /** A "View" press on a card that landed the way given; writes nothing. */
  view: (proposal: DocumentProposal, landed: LandingAction) => void;
  /** One document changed. */
  bump: (spaceId: string) => void;
  /** How a press ended, and how many media it left out: ignored for a card with no press waiting. */
  report: (proposalId: string, outcome: DocumentProposalOutcome, leftOut?: number) => void;
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
  if (card === undefined || outcome !== 'applied') return { cards: others, pending };
  return { cards: { ...others, [proposalId]: { state: 'applied', action: card.action } }, pending };
}

export const useDocumentProposals = create<DocumentProposalsState>()((set, get) => ({
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
  report: (proposalId, outcome, leftOut = 0) => {
    const { pending, cards } = get();
    const waiting = pending[proposalId];
    const card = cards[proposalId];
    if (waiting === undefined) return;
    // A View press that could not reach its document wrote nothing and the
    // change is still there: the card stays landed. When the editor could not
    // be built the document Space shows why; a tab closed first ends the
    // press with nothing to say.
    if (waiting.action === 'view' && outcome === 'failed') {
      set((s) => {
        const { [proposalId]: _gone, ...rest } = s.pending;
        return { pending: rest };
      });
      return;
    }
    set((s) => ended(s, proposalId, outcome));
    if (card !== undefined) tell(waiting.proposal, card.action, outcome, leftOut);
  },
  reportSpace: (spaceId, outcome) => {
    for (const p of pendingFor(spaceId)) get().report(p.proposal.proposalId, outcome);
  },
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
