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

const landProposal = vi.hoisted(() => vi.fn());
const landedAs = vi.hoisted(() => vi.fn());
const revealBlockOf = vi.hoisted(() => vi.fn(() => 'b-shown'));
vi.mock('@web/spaces/document/document-proposal-landing', () => ({ landProposal, landedAs, revealBlockOf }));

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
  return { proposalId, spaceId, spaceName: 'S', kind: 'insert', blockId: null, body: 'x', title: 't', heading: '', original: '', lossy: false };
}

const cards = (): ReturnType<typeof useDocumentProposals.getState>['cards'] => useDocumentProposals.getState().cards;

beforeEach(() => {
  useDocumentProposals.getState().reset();
  landProposal.mockReset();
  landedAs.mockReset();
  onChange.mockReset();
  onChange.mockReturnValue(() => undefined);
});

describe('taking up the cards pressed for this document', () => {
  it('lands each in the order pressed, reports how it ended, and leaves other documents alone', async () => {
    landProposal.mockImplementation((_h: unknown, p: DocumentProposal) =>
      Promise.resolve(p.proposalId === 'p1' ? { outcome: 'changed' } : { outcome: 'applied', blockId: 'b9' }),
    );
    useDocumentProposals.getState().start(proposal('p2'), 'write');
    useDocumentProposals.getState().start(proposal('p1'), 'comment');
    useDocumentProposals.getState().start(proposal('p3', 'd2'), 'write');

    const { result } = renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1?.state).toBe('changed');
    });
    expect(landProposal.mock.calls.map(([, p, action, writable]) => [(p as DocumentProposal).proposalId, action, writable])).toEqual([
      ['p2', 'write', true],
      ['p1', 'comment', true],
    ]);
    expect(cards().p2?.state).toBe('applied');
    expect(cards().p3?.state).toBe('working');
    expect(result.current).toEqual({ blockId: 'b9', proposalId: 'p2' });
  });

  it('takes up a card pressed after the document is already open', async () => {
    landProposal.mockResolvedValue({ outcome: 'applied', blockId: 'b1' });
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
      expect(cards().p1?.state).toBe('readOnly');
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
      expect([cards().p1?.state, cards().p2?.state]).toEqual(['failed', 'failed']);
    });
    expect(landProposal).not.toHaveBeenCalled();
  });

  it('reports a landing that threw as failed', async () => {
    landProposal.mockRejectedValue(new Error('boom'));
    useDocumentProposals.getState().start(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1?.state).toBe('failed');
    });
  });
});

describe('a card shown again (inner#1509 review round 1)', () => {
  it('shows a landed proposal and writes nothing', async () => {
    landedAs.mockReturnValue('write');
    useDocumentProposals.getState().view(proposal('p1'), 'write');

    const { result } = renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1).toEqual({ state: 'applied', action: 'write' });
    });
    expect(landProposal).not.toHaveBeenCalled();
    expect(result.current).toEqual({ blockId: 'b-shown', proposalId: 'p1' });
  });

  it('puts back a card whose change was taken back, and writes nothing', async () => {
    landedAs.mockReturnValue(null);
    useDocumentProposals.getState().view(proposal('p1'), 'write');

    renderHook(() => useDocumentProposalPickup('d1', HANDLE, 'granted', false));

    await waitFor(() => {
      expect(cards().p1).toBeUndefined();
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
