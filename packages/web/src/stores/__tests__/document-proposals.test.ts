// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each document proposal card's state (inner#1509, design §5.7): a press
 * starts it, one report ends it, and every card keeps its own -- several can
 * be waiting on the same document at once.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentProposal } from '@breatic/shared';

import { pendingFor, useDocumentProposals } from '@web/stores/document-proposals';

/**
 * A proposal for a Space.
 * @param proposalId - Its id.
 * @param spaceId - Its document.
 * @returns The proposal.
 */
function proposal(proposalId: string, spaceId = 'd1'): DocumentProposal {
  return {
    proposalId,
    spaceId,
    spaceName: 'Storyboard',
    kind: 'insert',
    blockId: null,
    body: 'x',
    title: 't',
    heading: '',
    original: '',
    blockType: null,
    lossy: false,
  };
}

const store = (): ReturnType<typeof useDocumentProposals.getState> => useDocumentProposals.getState();

beforeEach(() => {
  store().reset();
});

describe('a card', () => {
  it('is working once pressed, and ends with the one report it gets', () => {
    store().start(proposal('p1'), 'write');
    expect(store().cards.p1).toEqual({ state: 'working', action: 'write' });

    store().report('p1', 'applied');
    expect(store().cards.p1).toEqual({ state: 'applied', action: 'write' });
    expect(pendingFor('d1')).toEqual([]);
  });

  it('ignores a second press while it is working', () => {
    store().start(proposal('p1'), 'comment');
    store().start(proposal('p1'), 'write');

    expect(store().cards.p1).toEqual({ state: 'working', action: 'comment' });
    expect(pendingFor('d1')).toHaveLength(1);
  });

  it('can be pressed again after it failed', () => {
    store().start(proposal('p1'), 'write');
    store().report('p1', 'failed');
    store().start(proposal('p1'), 'write');

    expect(store().cards.p1?.state).toBe('working');
  });

  it('takes no report for a card with no press waiting', () => {
    store().report('p1', 'applied');

    expect(store().cards.p1).toBeUndefined();
  });
});

describe('the cards waiting on a document', () => {
  it('are each kept, in the order they were pressed, apart from those of another document', () => {
    store().start(proposal('p2'), 'write');
    store().start(proposal('p1'), 'comment');
    store().start(proposal('p3', 'd2'), 'write');

    expect(pendingFor('d1').map((p) => p.proposal.proposalId)).toEqual(['p2', 'p1']);
    expect(pendingFor('d2').map((p) => p.proposal.proposalId)).toEqual(['p3']);
  });

  it('are all reported at once when their document goes away', () => {
    store().start(proposal('p1'), 'write');
    store().start(proposal('p2'), 'write');
    store().start(proposal('p3', 'd2'), 'write');

    store().reportSpace('d1', 'failed');

    expect([store().cards.p1?.state, store().cards.p2?.state, store().cards.p3?.state]).toEqual(['failed', 'failed', 'working']);
  });
});

describe('showing a landed card again (inner#1509 review round 1)', () => {
  it('waits as a view, keeping the card as landed', () => {
    store().view(proposal('p1'), 'write');

    expect(store().cards.p1).toEqual({ state: 'applied', action: 'write' });
    expect(pendingFor('d1')[0]).toMatchObject({ action: 'view' });
  });

  it('stays as landed when the change is still there', () => {
    store().view(proposal('p1'), 'comment');
    store().report('p1', 'applied');

    expect(store().cards.p1).toEqual({ state: 'applied', action: 'comment' });
  });

  it('puts the card back as it first was when told to reset', () => {
    store().view(proposal('p1'), 'write');
    store().report('p1', 'reset');

    expect(store().cards.p1).toBeUndefined();
    expect(pendingFor('d1')).toEqual([]);
  });
});

describe('a document changing', () => {
  it('counts up for that document alone', () => {
    store().bump('d1');
    store().bump('d1');
    store().bump('d2');

    expect(store().docVersion).toEqual({ d1: 2, d2: 1 });
  });
});
