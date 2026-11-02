// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The project page sending a pressed document card to its document
 * (inner#1509, design §5.4 step 2 · §5.7): the tab opened or switched to, a
 * Space that is gone or is not a document reported at once, and a card whose
 * tab was closed before the document took it up reported as failed.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentProposal } from '@breatic/shared';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useDocumentProposalRouting } from '@web/pages/project/use-document-proposal-routing';
import { useDocumentProposals } from '@web/stores/document-proposals';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const DOC: ProjectSpace = { id: 'd1', name: 'Storyboard', type: 'document', createdAt: 1 };
const CANVAS: ProjectSpace = { id: 'c1', name: 'Cast', type: 'canvas', createdAt: 2 };

/**
 * A proposal for a Space.
 * @param proposalId - Its id.
 * @param spaceId - Its Space.
 * @returns The proposal.
 */
function proposal(proposalId: string, spaceId = 'd1'): DocumentProposal {
  return { proposalId, spaceId, spaceName: 'S', kind: 'insert', blockId: null, body: 'x', title: 't', heading: '', original: '', blockType: null, lossy: false };
}

const cards = (): ReturnType<typeof useDocumentProposals.getState>['cards'] => useDocumentProposals.getState().cards;

interface Props {
  spaces: readonly ProjectSpace[];
  openIds: readonly string[];
  activeId: string | null;
  ready: boolean;
}

/**
 * Runs the hook with props that can change.
 * @param initial - The first props.
 * @returns The open callback and a way to rerender.
 */
function run(initial: Props): { open: ReturnType<typeof vi.fn>; rerender: (next: Props) => void } {
  const open = vi.fn();
  const { rerender } = renderHook((p: Props) => useDocumentProposalRouting(p.spaces, p.openIds, p.activeId, open, p.ready), {
    initialProps: initial,
  });
  return { open, rerender };
}

beforeEach(() => {
  useDocumentProposals.getState().reset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe('a pressed document card', () => {
  it('opens its document, once', () => {
    const { open, rerender } = run({ spaces: [DOC, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });
    rerender({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'd1', ready: true });

    expect(open.mock.calls).toEqual([['d1']]);
    expect(cards().p1?.state).toBe('working');
  });

  it('opens nothing for a document already in front', () => {
    const { open } = run({ spaces: [DOC], openIds: ['d1'], activeId: 'd1', ready: true });

    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });

    expect(open).not.toHaveBeenCalled();
  });

  it('says the document is gone when the Space is not in the project, or is not a document', () => {
    run({ spaces: [CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
      useDocumentProposals.getState().start(proposal('p2', 'c1'), 'write');
    });

    expect([cards().p1, cards().p2]).toEqual([undefined, undefined]);
    expect(toast.warning).toHaveBeenCalledWith('This Document has been deleted.');
  });

  it('waits for the project\'s Spaces to arrive before judging', () => {
    const { open, rerender } = run({ spaces: [], openIds: [], activeId: null, ready: false });

    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });
    expect(cards().p1?.state).toBe('working');

    rerender({ spaces: [DOC], openIds: [], activeId: null, ready: true });
    expect(open.mock.calls).toEqual([['d1']]);
  });

  it('fails when its tab is closed before the document took it up', () => {
    const { rerender } = run({ spaces: [DOC], openIds: ['d1'], activeId: 'd1', ready: true });
    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });

    rerender({ spaces: [DOC], openIds: [], activeId: null, ready: true });

    expect(cards().p1).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith('Could not insert. Try again.');
  });

  it('keeps a landing press waiting when the reader switches away from its document', () => {
    const { rerender } = run({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'd1', ready: true });
    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });

    rerender({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'c1', ready: true });

    expect(cards().p1?.state).toBe('working');
    expect(useDocumentProposals.getState().pending.p1).toBeDefined();
  });

  it('says the document is gone when it is deleted before the document took it up', () => {
    const { rerender } = run({ spaces: [DOC], openIds: ['d1'], activeId: 'd1', ready: true });
    act(() => {
      useDocumentProposals.getState().start(proposal('p1'), 'write');
    });

    rerender({ spaces: [], openIds: [], activeId: null, ready: true });

    expect(cards().p1).toBeUndefined();
    expect(toast.warning).toHaveBeenCalledWith('This Document has been deleted.');
  });
});

describe('a locate or View press whose document the reader leaves (inner#1646)', () => {
  const pending = (): ReturnType<typeof useDocumentProposals.getState>['pending'] => useDocumentProposals.getState().pending;

  /**
   * Presses a read-only action on card p1.
   * @param action - Locate, or View on a card that landed as a write.
   */
  function press(action: 'locate' | 'view'): void {
    act(() => {
      if (action === 'locate') useDocumentProposals.getState().locate(proposal('p1'));
      else useDocumentProposals.getState().view(proposal('p1'), 'write');
    });
  }

  it.each(['locate', 'view'] as const)('ends a %s quietly once its document was in front and the reader switched away', (action) => {
    const { open, rerender } = run({ spaces: [DOC, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });
    press(action);
    expect(open.mock.calls).toEqual([['d1']]);

    // The open has not taken effect yet: the canvas is still in front.
    rerender({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'c1', ready: true });
    expect(pending().p1).toBeDefined();

    rerender({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'd1', ready: true });
    expect(pending().p1).toBeDefined();

    rerender({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'c1', ready: true });
    expect(pending().p1).toBeUndefined();
    expect(cards().p1).toEqual(action === 'view' ? { state: 'applied', action: 'write' } : undefined);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['locate', 'view'] as const)('ends a %s quietly when it was pressed with the document in front and the reader switched away', (action) => {
    const { rerender } = run({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'd1', ready: true });
    press(action);

    rerender({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'c1', ready: true });

    expect(pending().p1).toBeUndefined();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['locate', 'view'] as const)('ends a %s quietly when the reader closes its document\'s tab', (action) => {
    const { rerender } = run({ spaces: [DOC, CANVAS], openIds: ['c1', 'd1'], activeId: 'd1', ready: true });
    press(action);

    rerender({ spaces: [DOC, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    expect(pending().p1).toBeUndefined();
    expect(cards().p1).toEqual(action === 'view' ? { state: 'applied', action: 'write' } : undefined);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('ends a locate quietly when the tab is closed before the open took effect', () => {
    const { rerender } = run({ spaces: [DOC, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });
    press('locate');

    rerender({ spaces: [DOC, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    expect(pending().p1).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still says the document is gone when it is deleted while a locate waits', () => {
    const { rerender } = run({ spaces: [DOC], openIds: ['d1'], activeId: 'd1', ready: true });
    press('locate');

    rerender({ spaces: [], openIds: [], activeId: null, ready: true });

    expect(pending().p1).toBeUndefined();
    expect(toast.warning).toHaveBeenCalledWith('This Document has been deleted.');
  });
});
