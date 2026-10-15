// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each document proposal card's state (inner#1509, design §5.7): a press
 * starts it, one report ends it, and every card keeps its own -- several can
 * be waiting on the same document at once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentProposal } from '@breatic/shared';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

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
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe('a card', () => {
  it('is working once pressed, and ends with the one report it gets', () => {
    store().start(proposal('p1'), 'write');
    expect(store().cards.p1).toEqual({ state: 'working', action: 'write' });

    store().report('p1', 'applied');
    expect(store().cards.p1).toEqual({ state: 'applied', action: 'write' });
    expect(pendingFor('d1')).toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
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
    expect(store().cards.p1).toBeUndefined();

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

    expect([store().cards.p1?.state, store().cards.p2?.state, store().cards.p3?.state]).toEqual([undefined, undefined, 'working']);
    expect(toast.error).toHaveBeenCalledTimes(2);
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

  it('says with a toast that the change is gone, and goes back to how it first was', () => {
    store().view(proposal('p1'), 'write');
    store().report('p1', 'gone');

    expect(store().cards.p1).toBeUndefined();
    expect(pendingFor('d1')).toEqual([]);
    expect(toast.warning).toHaveBeenCalledWith('This change is no longer in the Document.');
  });

  it('can be pressed again once its change is gone', () => {
    store().view(proposal('p1'), 'write');
    store().report('p1', 'gone');
    store().start(proposal('p1'), 'write');

    expect(store().cards.p1).toEqual({ state: 'working', action: 'write' });
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

describe('how a press that did not land is told (inner#1509, design §5.7)', () => {
  it.each([
    ['changed', 'This passage has changed since the proposal.'],
    ['blockGone', 'This passage has been deleted.'],
    ['readOnly', 'You can only view this Document right now.'],
    ['spaceGone', 'This Document has been deleted.'],
  ] as const)('warns with a toast when it is %s, leaving the card to be pressed again', (outcome, line) => {
    store().start(proposal('p1'), 'write');
    store().report('p1', outcome);

    expect(toast.warning).toHaveBeenCalledWith(line);
    expect(toast.error).not.toHaveBeenCalled();
    expect(store().cards.p1).toBeUndefined();
  });

  it.each([
    ['comment', 'comment', 'Could not add the comment. Try again.'],
    ['rewrite', 'write', 'Could not replace the passage. Try again.'],
    ['insert', 'write', 'Could not insert. Try again.'],
  ] as const)('raises an error toast naming what a failed %s press was', (kind, action, line) => {
    store().start({ ...proposal('p1'), kind }, action);
    store().report('p1', 'failed');

    expect(toast.error).toHaveBeenCalledWith(line);
  });

  it('says how many media were left out, with the card landed', () => {
    store().start(proposal('p1'), 'write');
    store().report('p1', 'applied', 2);

    expect(store().cards.p1).toEqual({ state: 'applied', action: 'write' });
    expect(toast.warning).toHaveBeenCalledWith('2 images, videos or audio are outside links and will not be added.');
  });

  it('says the media were left out when nothing else was to land', () => {
    store().start(proposal('p1'), 'write');
    store().report('p1', 'mediaOnly', 1);

    expect(store().cards.p1).toBeUndefined();
    expect(toast.warning).toHaveBeenCalledWith('1 image, video or audio is an outside link and will not be added.');
  });
});

describe('a View press that could not reach its document (review round 6)', () => {
  it('keeps the card landed and says nothing about writing', () => {
    store().view(proposal('p1'), 'comment');
    store().report('p1', 'failed');

    expect(store().cards.p1).toEqual({ state: 'applied', action: 'comment' });
    expect(pendingFor('d1')).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
