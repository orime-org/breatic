// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document Space taking up the cards pressed for it (inner#1509, design
 * §5.4 step 3 · §5.7): each landed in the order it was pressed and its ending
 * reported, none taken while the connection's access is unsettled, and every
 * one failed when the editor cannot be built.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentProposal } from '@breatic/shared';

import { useDocumentProposals } from '@web/stores/document-proposals';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const landProposal = vi.hoisted(() => vi.fn());
const landedAt = vi.hoisted(() => vi.fn());
vi.mock('@web/spaces/document/document-proposal-landing', () => ({ landProposal, landedAt }));

const { useDocumentProposalPickup } = await import('@web/spaces/document/use-document-proposal-pickup');

const onChange = vi.hoisted(() => vi.fn());
const HANDLE = { editor: { onChange }, undoManager: {} } as never;

/**
 * A proposal for a document.
 * @param proposalId - Its id.
 * @param spaceId - Its document.
 * @returns The proposal.
 */
function proposal(proposalId: string, spaceId = 'd1'): DocumentProposal {
  return { proposalId, spaceId, spaceName: 'S', kind: 'insert', blockId: null, body: 'x', title: 't', heading: '', original: '', blockType: null, lossy: false };
}

const cards = (): ReturnType<typeof useDocumentProposals.getState>['cards'] => useDocumentProposals.getState().cards;

beforeEach(() => {
  useDocumentProposals.getState().reset();
  landProposal.mockReset();
  landedAt.mockReset();
  toast.warning.mockReset();
  toast.error.mockReset();
  onChange.mockReset();
  onChange.mockReturnValue(() => undefined);
});

describe('taking up the cards pressed for this document', () => {
  it('lands each in the order pressed, reports how it ended, and leaves other documents alone', async () => {
    landProposal.mockImplementation((_h: unknown, p: DocumentProposal) =>
      Promise.resolve(p.proposalId === 'p1' ? { outcome: 'changed' } : { outcome: 'applied', how: 'write', blockId: 'b9' }),
    );
    useDocumentProposals.getState().start(proposal('p2'), 'write');
    useDocumentProposals.getState().start(proposal('p1'), 'comment');
    useDocumentProposals.getState().start(proposal('p3', 'd2'), 'write');

    const { result } = renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1).toBeUndefined();
      expect(toast.warning).toHaveBeenCalledWith('This passage has changed since the proposal.');
    });
    expect(landProposal.mock.calls.map(([, p, action, writable]) => [(p as DocumentProposal).proposalId, action, writable])).toEqual([
      ['p2', 'write', true],
      ['p1', 'comment', true],
    ]);
    expect(cards().p2?.state).toBe('applied');
    expect(cards().p3?.state).toBe('working');
    expect(result.current).toEqual({ how: 'write', blockId: 'b9' });
  });

  it('takes up a card pressed after the document is already open', async () => {
    landProposal.mockResolvedValue({ outcome: 'applied', how: 'write', blockId: 'b1' });
    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });

    await waitFor(() => {
      expect(cards().p1?.state).toBe('applied');
    });
  });

  it('lands on a read-only connection as not writable', async () => {
    landProposal.mockResolvedValue({ outcome: 'readOnly' });
    useDocumentProposals.getState().start(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'denied', false));

    await waitFor(() => {
      expect(cards().p1).toBeUndefined();
      expect(toast.warning).toHaveBeenCalledWith('You can only view this Document right now.');
    });
    expect(landProposal.mock.calls[0]?.[3]).toBe(false);
  });

  it('waits while the connection has not said whether it may write, or there is no editor yet', async () => {
    useDocumentProposals.getState().start(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'unknown', false));
    renderHook(() => useDocumentProposalPickup('d1', null, 'granted', false));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(landProposal).not.toHaveBeenCalled();
    expect(cards().p1?.state).toBe('working');
  });

  it('fails every card waiting on a document whose editor cannot be built', async () => {
    useDocumentProposals.getState().start(proposal('p1'), 'write');
    useDocumentProposals.getState().start(proposal('p2'), 'comment');

    renderHook(() => useDocumentProposalPickup('d1', null, 'granted', true));

    await waitFor(() => {
      expect([cards().p1, cards().p2]).toEqual([undefined, undefined]);
      expect(toast.error).toHaveBeenCalledTimes(2);
    });
    expect(landProposal).not.toHaveBeenCalled();
  });

  it('reports a landing that threw as failed', async () => {
    landProposal.mockRejectedValue(new Error('boom'));
    useDocumentProposals.getState().start(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1).toBeUndefined();
      expect(toast.error).toHaveBeenCalledWith('Could not insert. Try again.');
    });
  });
});

describe('a card shown again (inner#1509 review round 1)', () => {
  it('shows a landed proposal and writes nothing', async () => {
    landedAt.mockReturnValue({ how: 'write', blockId: 'b-shown' });
    useDocumentProposals.getState().view(proposal('p1'), 'write');

    const { result } = renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1).toEqual({ state: 'applied', action: 'write' });
    });
    expect(landProposal).not.toHaveBeenCalled();
    expect(result.current).toEqual({ how: 'write', blockId: 'b-shown' });
  });

  it('hands the body the thread a comment card is shown at, for the panel to open on it', async () => {
    landedAt.mockReturnValue({ how: 'comment', blockId: 'b-shown', threadId: 't-shown' });
    useDocumentProposals.getState().view(proposal('p1'), 'comment');

    const { result } = renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(result.current).toEqual({ how: 'comment', blockId: 'b-shown', threadId: 't-shown' });
    });
  });

  it('hands the body the thread a comment just landed as, without how it was reported', async () => {
    landProposal.mockResolvedValue({ outcome: 'applied', how: 'comment', blockId: 'b1', threadId: 't1', leftOut: 0 });
    useDocumentProposals.getState().start(proposal('p1'), 'comment');

    const { result } = renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(result.current).toEqual({ how: 'comment', blockId: 'b1', threadId: 't1' });
    });
  });

  it('says the change is gone when it was taken back, and writes nothing', async () => {
    landedAt.mockReturnValue(null);
    useDocumentProposals.getState().view(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1).toBeUndefined();
      expect(toast.warning).toHaveBeenCalledWith('This change is no longer in the Document.');
    });
    expect(landProposal).not.toHaveBeenCalled();
  });
});

describe('the document changing', () => {
  it('is counted once the editor is there and on each change', () => {
    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));
    expect(useDocumentProposals.getState().docVersion.d1).toBe(1);

    (onChange.mock.calls[0]?.[0] as () => void)();

    expect(useDocumentProposals.getState().docVersion.d1).toBe(2);
  });
});

describe('media left out of a landing (review round 6)', () => {
  it('are counted in a toast once the press lands', async () => {
    landProposal.mockResolvedValue({ outcome: 'applied', how: 'write', blockId: 'b', leftOut: 2 });
    useDocumentProposals.getState().start(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith('2 images, videos or audio are outside links and will not be added.');
    });
  });
});
