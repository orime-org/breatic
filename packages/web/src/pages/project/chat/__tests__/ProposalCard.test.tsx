// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The card that turns an agent's proposal into one press (#229).
 *
 * The reader it exists for does not know the canvas, so the card has to answer
 * everything before the press: what gets built, what it costs, and what is
 * left for them afterwards. Pressing posts the group to the canvas, which is
 * the only thing with a viewport to place it in -- and when no canvas is open
 * there is nobody holding that mailbox, which the reader has to be told rather
 * than left pressing a button that does nothing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CanvasProposal, ModelCatalog } from '@breatic/shared';

import { ProposalCard } from '@web/pages/project/chat/ProposalCard';
import { useCanvasStore } from '@web/stores/canvas';

const listModels = vi.fn();
vi.mock('@web/data/api', () => ({
  modelsApi: { list: () => listModels() },
}));

const warn = vi.fn();
vi.mock('@web/lib/toast', () => ({
  toast: { warning: (line: string) => warn(line) },
}));

/** A proposal of an empty node feeding one generation node. */
const PAIR: CanvasProposal = {
  nodes: [
    { role: 'source', type: 'image', name: 'Your product photo' },
    {
      role: 'generate',
      type: 'image',
      name: 'On white',
      mode: 'i2i',
      model: 'some-model',
      params: {},
      prompt: [
        { text: 'white ground, ' },
        {
          slot: {
            kind: 'asset',
            label: 'your product photo',
            note: 'Put your photo in the node on the left',
          },
        },
      ],
    },
  ],
  edges: [{ fromIndex: 0, toIndex: 1 }],
  modelNote: 'Keeps the shape, and it is quick',
  rationale: 'Two nodes: your photo, then the result',
};

/** The same group with the material picked in a toolbar slot, so nothing is wired. */
const SLOTTED: CanvasProposal = {
  ...PAIR,
  nodes: PAIR.nodes.map((n) =>
    n.role === 'generate' ? { ...n, type: 'video' as const, mode: 'i2v' } : n,
  ),
  edges: [],
};

/** A catalog that knows what the proposed model costs. */
const CATALOG = {
  image: [
    {
      name: 'some-model',
      display_name: 'Some Model',
      cost_per_call: 4,
      generation_time: 12,
    },
  ],
  video: [],
  audio: [],
  tts: [],
  three_d: [],
  understand: [],
  total: 1,
} as unknown as ModelCatalog;

/**
 * Render a card with a canvas listening or not.
 * @param listening - Whether a canvas is holding the mailbox.
 * @param proposal - The group the card draws.
 * @returns The query client, so a test can wait for the catalog to land.
 */
function renderCard(listening = true, proposal: CanvasProposal = PAIR): QueryClient {
  useCanvasStore.setState({
    pendingNodeCreate: null,
    canvasListening: listening,
    proposalOutcome: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProposalCard proposal={proposal} />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  listModels.mockReset();
  warn.mockReset();
});

describe('what the card says before it is pressed', () => {
  it('names each node it would build, marking the one the reader fills in', () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard();

    const chips = screen.getAllByTestId('proposal-chip');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Your product photo',
      'On white',
    ]);
    // The empty one is drawn as an outline, which is what says it holds
    // nothing yet; a solid chip would read as something already there.
    expect(chips[0]?.className).toContain('border-dashed');
    expect(chips[1]?.className).not.toContain('border-dashed');
  });


  it('draws an arrow only where the group is actually wired', () => {
    // The arrow says the node on its left feeds the one on its right. A mode
    // whose material is picked in a toolbar slot has no edge and no wiring to
    // do, and an arrow there tells the reader to connect something that
    // cannot be connected.
    listModels.mockResolvedValue(CATALOG);
    renderCard(true, PAIR);
    expect(screen.getAllByTestId('proposal-arrow')).toHaveLength(1);

    cleanup();
    renderCard(true, SLOTTED);
    expect(screen.queryByTestId('proposal-arrow')).toBeNull();
  });

  it('says what is left for the reader, taken from the prompt marks', () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard();

    expect(
      screen.getByText('Put your photo in the node on the left'),
    ).toBeTruthy();
  });

  it('quotes the price from the catalog, not from the model that proposed it', async () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard();

    // 4 and 12 are the catalog's numbers for this model; nothing in the
    // proposal carries either, which is the point.
    await waitFor(() => expect(screen.getByText('4')).toBeTruthy());
    expect(screen.getByText('12s')).toBeTruthy();
  });

  it('omits the credits when the model bills by what the reader gives it', async () => {
    // `cost_per_call` on a model that declares a `rate` is the balance gate's
    // floor, not a price -- the panel one press later computes the real one
    // from the duration or the script. A number the panel contradicts is
    // worse than no number.
    listModels.mockResolvedValue({
      ...CATALOG,
      image: [
        {
          name: 'some-model',
          cost_per_call: 5,
          generation_time: 12,
          rate: { credits: 1, per: 5, unit: 'seconds' },
        },
      ],
    });
    const client = renderCard();

    await waitFor(() => expect(client.getQueryData(['models'])).toBeDefined());
    expect(screen.queryByText('5')).toBeNull();
    // The wait is a declared number either way, so it still shows.
    expect(screen.getByText('12s')).toBeTruthy();
  });

  it('names the model the way the panel will name it', async () => {
    // The reader this card exists for has never seen a model id. One press
    // later the picker in the panel says "Some Model", and a card that said
    // "some-model" left them matching two names for one thing.
    listModels.mockResolvedValue(CATALOG);
    const client = renderCard();

    await waitFor(() => expect(client.getQueryData(['models'])).toBeDefined());
    expect(screen.getByText('Some Model')).toBeTruthy();
    expect(screen.queryByText('some-model')).toBeNull();
  });

  it('falls back to the id when the catalog does not carry that model', async () => {
    // Saying nothing about which model would leave the note beside it
    // ("keeps the shape, and it is quick") attached to nothing at all.
    listModels.mockResolvedValue({ ...CATALOG, image: [] });
    const client = renderCard();

    await waitFor(() => expect(client.getQueryData(['models'])).toBeDefined());
    expect(screen.getByText('some-model')).toBeTruthy();
  });

  it('omits the price when the catalog does not carry that model', async () => {
    listModels.mockResolvedValue({ ...CATALOG, image: [] });
    const client = renderCard();

    // Wait for the catalog itself, not for the request: with this model
    // missing the card looks exactly as it does while the catalog is still
    // coming, so a test that only waited for the call would pass on a card
    // that had not read it yet -- and on one that invented a price.
    await waitFor(() => expect(client.getQueryData(['models'])).toBeDefined());
    expect(screen.queryByText('12s')).toBeNull();
  });
});

describe('pressing it', () => {
  it('posts the whole group for the canvas to place', async () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard();

    await userEvent.click(screen.getByTestId('proposal-use'));

    const posted = useCanvasStore.getState().pendingNodeCreate;
    expect(posted).toEqual({ proposal: PAIR });
  });

  it('holds the button while the canvas builds, and lets go when it answers', async () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard();

    await userEvent.click(screen.getByTestId('proposal-use'));
    expect(screen.getByTestId<HTMLButtonElement>('proposal-use').disabled).toBe(true);

    act(() => useCanvasStore.getState().reportProposalOutcome('placed'));

    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>('proposal-use').disabled).toBe(false),
    );
    expect(screen.queryByTestId('proposal-failed')).toBeNull();
  });

  it('says so in place when the canvas could not build it, and can be pressed again', async () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard();

    await userEvent.click(screen.getByTestId('proposal-use'));
    act(() => useCanvasStore.getState().reportProposalOutcome('failed'));

    await waitFor(() => expect(screen.getByTestId('proposal-failed')).toBeTruthy());
    expect(screen.getByTestId<HTMLButtonElement>('proposal-use').disabled).toBe(false);
  });

  it('tells the reader to open a canvas when none is listening, and posts nothing', async () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard(false);

    await userEvent.click(screen.getByTestId('proposal-use'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().pendingNodeCreate).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>('proposal-use').disabled).toBe(false);
  });
});
