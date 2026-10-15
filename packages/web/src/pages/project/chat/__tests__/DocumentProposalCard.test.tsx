// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The card for a document proposal (inner#1509, design §5.3 · §5.7): it says
 * which document and passage, what the comment, rewrite or insert is, and
 * offers the press that lands it; then it says how the press ended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DocumentProposal } from '@breatic/shared';

import { DocumentProposalCard } from '@web/pages/project/chat/DocumentProposalCard';
import { useDocumentProposals } from '@web/stores/document-proposals';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const landedHow = vi.hoisted(() => vi.fn<() => 'comment' | 'write' | null>(() => null));
const landedAt = vi.hoisted(() =>
  vi.fn(() => {
    const how = landedHow();
    return how === null ? null : { how, blockId: 'b' };
  }),
);
const peek = vi.hoisted(() => vi.fn<(name: string) => unknown>(() => undefined));
vi.mock('@web/spaces/document/document-proposal-landing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/spaces/document/document-proposal-landing')>()),
  landedAt,
}));
vi.mock('@web/spaces/document/document-editor-cache', () => ({ peekDocumentEditor: peek }));

const PROJECT = '11111111-1111-4111-8111-111111111111';

const BASE: DocumentProposal = {
  proposalId: '33333333-3333-4333-8333-333333333333',
  spaceId: '44444444-4444-4444-8444-444444444444',
  spaceName: 'Storyboard',
  kind: 'comment',
  blockId: 'b2',
  quote: 'He pushes the door open',
  body: 'The conflict comes too soon.',
  title: 'Scene 2 moves too fast',
  heading: 'Scene 2',
  original: 'He pushes the door open and sees her bags packed.',
  blockType: 'paragraph',
  lossy: false,
};

/**
 * Draws the card inside a project route.
 * @param proposal - The proposal.
 */
function draw(proposal: DocumentProposal): void {
  render(
    <MemoryRouter initialEntries={[`/project/demo-${PROJECT}`]}>
      <Routes>
        <Route path='/project/:projectId' element={<DocumentProposalCard proposal={proposal} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useDocumentProposals.getState().reset();
  landedHow.mockReturnValue(null);
  peek.mockReturnValue(undefined);
  toast.warning.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('a comment card', () => {
  it('names the document and passage, quotes it, and offers one press', async () => {
    draw(BASE);

    expect(screen.getByText('Scene 2 moves too fast')).toBeTruthy();
    expect(screen.getByTestId('document-proposal-where').textContent).toBe('Document “Storyboard” · Scene 2');
    expect(screen.getByTestId('document-proposal-quote').textContent).toBe('He pushes the door open');
    expect(screen.getByText('The conflict comes too soon.')).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Add comment']);

    await userEvent.click(buttons[0]!);
    expect(useDocumentProposals.getState().pending[BASE.proposalId]).toMatchObject({ action: 'comment' });
  });
});

describe('a rewrite card', () => {
  const REWRITE: DocumentProposal = {
    ...BASE,
    kind: 'rewrite',
    quote: undefined,
    original: 'Morning light falls slowly on the table.',
    body: 'Morning light falls on the table.',
  };

  it('shows what is taken out and what is put in, and offers both presses', async () => {
    const { quote: _quote, ...rewrite } = REWRITE;
    draw(rewrite);

    await waitFor(() => {
      expect(screen.getByTestId('document-proposal-removed').textContent).toContain('slowly');
    });
    expect(screen.queryByTestId('document-proposal-added')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Add comment', 'Replace']);
    expect(screen.queryByTestId('document-proposal-lossy')).toBeNull();
  });

  it('compares Chinese word by word, not character by character', async () => {
    const { quote: _quote, ...rewrite } = { ...REWRITE, original: '我们明天出发。', body: '你们明天出发。' };
    draw(rewrite);

    await waitFor(() => {
      expect(screen.getByTestId('document-proposal-removed').textContent).toBe('我们');
    });
    expect(screen.getByTestId('document-proposal-added').textContent).toBe('你们');
  });

  it.each([
    ['an empty block', ''],
    ['a table whose cells are all empty', '\n\n\n'],
  ])('offers no comment on %s, which has no words to hang it on', (_label, original) => {
    const { quote: _quote, ...rewrite } = { ...REWRITE, original };
    draw(rewrite);

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Replace']);
  });

  it('shows the whole passage out and the whole rewrite in when the two are too far apart to compare word by word (review round 3)', async () => {
    const original = Array.from({ length: 3000 }, (_, i) => `镜头${String(i % 97)}`).join('');
    const body = Array.from({ length: 3000 }, (_, i) => `shot ${String(i % 89)}`).join(' ');
    const { quote: _quote, ...rewrite } = { ...REWRITE, original, body };
    draw(rewrite);

    await waitFor(
      () => {
        expect(screen.getByTestId('document-proposal-removed').textContent).toBe(original);
      },
      { timeout: 5000 },
    );
    expect(screen.getAllByTestId('document-proposal-removed')).toHaveLength(1);
    expect(screen.getByTestId('document-proposal-added').textContent).toBe(body);
  }, 15000);

  it('offers no comment when the rewrite has no words of its own (review round 4)', async () => {
    const { quote: _quote, ...rewrite } = { ...REWRITE, body: '---' };
    draw(rewrite);

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Replace']);
  });

  it('holds its write button until the body is read (review round 4)', async () => {
    const { quote: _quote, ...insert } = { ...BASE, kind: 'insert' as const, body: 'Text.' };
    draw(insert);

    expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('says the passage loses formatting Markdown cannot hold', () => {
    const { quote: _quote, ...rewrite } = { ...REWRITE, lossy: true };
    draw(rewrite);

    expect(screen.getByTestId('document-proposal-lossy').textContent).toBe(
      'The formatting and comments in this passage will be replaced.',
    );
  });

  it('stops saying the passage will be replaced once it has been', async () => {
    const { quote: _quote, ...rewrite } = { ...REWRITE, lossy: true };
    draw(rewrite);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    act(() => {
      useDocumentProposals.getState().report(rewrite.proposalId, 'applied');
    });

    expect(screen.getByTestId('document-proposal-status').textContent).toBe('Replaced');
    expect(screen.queryByTestId('document-proposal-lossy')).toBeNull();
  });
});

describe('an insert card', () => {
  it('says where it goes and shows the table it adds', () => {
    const { quote: _quote, ...insert } = { ...BASE, kind: 'insert' as const, blockId: null, original: '', heading: 'Scene 3', body: '| Shot | Size |\n|---|---|\n| 1 | Wide |' };
    draw(insert);

    expect(screen.getByTestId('document-proposal-where').textContent).toBe('Insert into Document “Storyboard” · End');
    expect(screen.getByText('Wide')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Insert']);
    expect(screen.queryByTestId('document-proposal-anchor')).toBeNull();
  });

  it('names a passage with no words by its kind (review round 3)', () => {
    const { quote: _quote, ...insert } = { ...BASE, kind: 'insert' as const, original: '\n', blockType: 'image', body: 'She waits.' };
    draw(insert);

    expect(screen.getByTestId('document-proposal-anchor').textContent).toBe('Image');
  });

  it('offers its press whatever media the body holds, which are judged when it lands', async () => {
    const { quote: _quote, ...insert } = { ...BASE, kind: 'insert' as const, body: '![a](https://elsewhere.example/a.png)' };
    draw(insert);

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('shows the passage it goes after', () => {
    const { quote: _quote, ...insert } = { ...BASE, kind: 'insert' as const, body: 'She waits.' };
    draw(insert);

    expect(screen.getByTestId('document-proposal-anchor-label').textContent).toBe('Goes after this passage');
    expect(screen.getByTestId('document-proposal-anchor').textContent).toBe(BASE.original);
  });
});

describe('after a press', () => {
  it('waits on the pressed button with the other one held', async () => {
    const { quote: _quote, ...rewrite } = { ...BASE, kind: 'rewrite' as const };
    draw(rewrite);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(false);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));

    expect(screen.getByRole('button', { name: 'Replace' }).getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['changed', 'This passage has changed since the proposal.'],
    ['blockGone', 'This passage has been deleted.'],
    ['readOnly', 'You can only view this Document right now.'],
    ['spaceGone', 'This Document has been deleted.'],
  ] as const)('tells %s with a toast and offers the press again', async (outcome, line) => {
    draw(BASE);
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    act(() => {
      useDocumentProposals.getState().report(BASE.proposalId, outcome);
    });

    expect(toast.warning).toHaveBeenCalledWith(line);
    expect(screen.queryByTestId('document-proposal-status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('tells with a toast that its change is no longer in the Document, and offers the press again', async () => {
    draw(BASE);
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    act(() => {
      useDocumentProposals.getState().report(BASE.proposalId, 'applied');
    });
    await userEvent.click(screen.getByRole('button', { name: 'View in Document' }));
    act(() => {
      useDocumentProposals.getState().report(BASE.proposalId, 'gone');
    });

    expect(toast.warning).toHaveBeenCalledWith('This change is no longer in the Document.');
    expect(screen.queryByTestId('document-proposal-status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('tells a failure with an error toast and can be pressed again', async () => {
    draw(BASE);
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    act(() => {
      useDocumentProposals.getState().report(BASE.proposalId, 'failed');
    });

    expect(toast.error).toHaveBeenCalledWith('Could not add the comment. Try again.');
    expect(screen.queryByTestId('document-proposal-status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says it landed, and showing it asks only to be shown, waiting on that button', async () => {
    draw(BASE);
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    act(() => {
      useDocumentProposals.getState().report(BASE.proposalId, 'applied');
    });

    expect(screen.getByTestId('document-proposal-status').textContent).toBe('Comment added');
    await userEvent.click(screen.getByRole('button', { name: 'View in Document' }));
    expect(useDocumentProposals.getState().pending[BASE.proposalId]).toMatchObject({ action: 'view' });
    expect(screen.getByRole('button', { name: 'View in Document' }).getAttribute('aria-busy')).toBe('true');
  });
});

describe('a card drawn again', () => {
  it('knows from the open document that it already landed, and how', () => {
    peek.mockReturnValue({ editor: {} });
    landedHow.mockReturnValue('write');
    const { quote: _quote, ...rewrite } = { ...BASE, kind: 'rewrite' as const };

    draw(rewrite);

    expect(peek).toHaveBeenCalledWith(`project-${PROJECT}/document-${BASE.spaceId}`);
    expect(screen.getByTestId('document-proposal-status').textContent).toBe('Replaced');
  });
});

describe('a landed card whose document changes', () => {
  it('goes back to how it first was when the open document no longer holds the change', () => {
    const { quote: _quote, ...rewrite } = { ...BASE, kind: 'rewrite' as const };
    peek.mockReturnValue({ editor: {} });
    landedHow.mockReturnValue('write');
    draw(rewrite);
    expect(screen.getByTestId('document-proposal-status').textContent).toBe('Replaced');

    landedHow.mockReturnValue(null);
    act(() => {
      useDocumentProposals.getState().bump(BASE.spaceId);
    });

    expect(screen.queryByTestId('document-proposal-status')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Add comment', 'Replace']);
  });

  it('trusts the open document over a landing reported earlier', async () => {
    peek.mockReturnValue({ editor: {} });
    draw(BASE);
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    act(() => {
      useDocumentProposals.getState().report(BASE.proposalId, 'applied');
    });

    expect(screen.queryByTestId('document-proposal-status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
