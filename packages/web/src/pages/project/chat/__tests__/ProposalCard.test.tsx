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
import type { CanvasProposal, ModelCatalog, ProposalNode } from '@breatic/shared';

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
      // Written by the check before the card ever sees a proposal, and what
      // the card reads to work out which node a mark is about. Left off, every
      // to-do in here would be filed the way an unjudged proposal files them.
      takesFrom: 'pool',
      takesPrompt: true,
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
    {
      name: 'slow-model',
      display_name: 'Slow Model',
      cost_per_call: 4,
      generation_time: 30,
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

describe('a flow that is more than one thing', () => {
  /** Copy standing beside a generation, with a place the reader rewrites. */
  const COPY: CanvasProposal = {
    nodes: [
      {
        role: 'written',
        type: 'text',
        name: 'Your copy',
        prompt: [
          { text: 'A pour-over kettle,\nslow and warm, for ' },
          { slot: { kind: 'tweak', label: 'your brand', note: 'Put your own brand in' } },
          { text: '.' },
        ],
      },
      ...PAIR.nodes,
    ],
    edges: [{ fromIndex: 1, toIndex: 2 }],
    rationale: 'Copy to publish, and the photo on white',
    groupName: 'Kettle listing',
  };

  it('draws the words in full, beside what gets generated', () => {
    // The reader judges this version here. Given a title they would have to
    // place it, read it, and undo a node they never wanted.
    listModels.mockResolvedValue(CATALOG);
    renderCard(true, COPY);

    expect(screen.getByTestId('proposal-card')).toBeTruthy();
    expect(screen.getByTestId('proposal-words').textContent).toBe(
      'A pour-over kettle,\nslow and warm, for [\u270f\ufe0f your brand].',
    );
  });

  it('names the node each body of words belongs to', () => {
    // The to-dos under the card carry node names, and with two bodies drawn
    // one above the other an unnamed body leaves the reader matching an
    // instruction against whichever text they guess it is about.
    listModels.mockResolvedValue(CATALOG);
    const second = COPY.nodes[0] as ProposalNode;
    renderCard(true, {
      ...COPY,
      nodes: [...COPY.nodes, { ...second, name: 'Your subtitle' }],
      groupName: 'Kettle listing',
    });

    const heads = screen.getAllByTestId('proposal-words-name').map((el) => el.textContent);
    expect(heads).toEqual(['Your copy', 'Your subtitle']);
  });

  it('draws nothing about a model the catalog does not carry', () => {
    listModels.mockResolvedValue(CATALOG);
    renderCard(true, {
      ...PAIR,
      nodes: PAIR.nodes.map((n) =>
        n.role === 'generate' ? { ...n, model: 'no-such-model' } : n,
      ),
    });

    expect(screen.queryByText(/Some Model/)).toBeNull();
  });

  it('holds back the model line when the generations run on different ones', async () => {
    // The note is one field about one model. With two in the flow it says
    // something about neither.
    listModels.mockResolvedValue(CATALOG);
    const two: CanvasProposal = {
      ...PAIR,
      nodes: [
        PAIR.nodes[1]!,
        { ...PAIR.nodes[1]!, name: 'At 45', model: 'other-model' },
      ],
      edges: [],
    };
    const client = renderCard(true, two);
    await waitFor(() => expect(client.getQueryData(['models'])).toBeTruthy());

    expect(screen.queryByText(/Keeps the shape/)).toBeNull();
  });

  it('quotes what all of the generations cost, not one of them', async () => {
    listModels.mockResolvedValue(CATALOG);
    const three: CanvasProposal = {
      ...PAIR,
      nodes: [
        PAIR.nodes[0]!,
        PAIR.nodes[1]!,
        { ...PAIR.nodes[1]!, name: 'At 45' },
        { ...PAIR.nodes[1]!, name: 'Overhead' },
      ],
      edges: [
        { fromIndex: 0, toIndex: 1 },
        { fromIndex: 0, toIndex: 2 },
        { fromIndex: 0, toIndex: 3 },
      ],
    };
    renderCard(true, three);

    // Three runs of a model the catalog prices at 4, so twelve -- and the
    // wait is one run's, drawn as an each because all three take it.
    await waitFor(() => expect(screen.getByText('12')).toBeTruthy());
    expect(screen.getByText(/12s . 3/)).toBeTruthy();
  });

  it('quotes one number for the wait where the runs are not the same length', async () => {
    // Twelve seconds beside thirty drawn as "30 s x 2" says the picture takes
    // half a minute. With no per-run number to multiply, the longest stands
    // on its own.
    listModels.mockResolvedValue(CATALOG);
    const mixed: CanvasProposal = {
      ...PAIR,
      nodes: [
        PAIR.nodes[0]!,
        PAIR.nodes[1]!,
        { ...PAIR.nodes[1]!, name: 'The clip', model: 'slow-model' },
      ],
      edges: [
        { fromIndex: 0, toIndex: 1 },
        { fromIndex: 0, toIndex: 2 },
      ],
    };
    renderCard(true, mixed);

    await waitFor(() => expect(screen.getByText('30s')).toBeTruthy());
    expect(screen.queryByText(/30 s . 2/)).toBeNull();
  });

  it('names the node a lone to-do belongs to when the group holds more', () => {
    // Two nodes on screen and one line under them. Unheaded, the reader
    // cannot tell which of the two it is about; a proposal of one node needs
    // no header, because there is nothing to tell it apart from.
    listModels.mockResolvedValue(CATALOG);
    renderCard(true, PAIR);

    const group = screen.getAllByTestId('proposal-todo-group')[0];
    expect(group?.textContent).toContain('On white');
  });

  it('stacks the chips of one layer, the way the demo draws them', () => {
    // Three takes of one thing stand under each other, so the eye reads them
    // as three of a kind rather than as a chain running left to right.
    listModels.mockResolvedValue(CATALOG);
    const same = (name: string): ProposalNode => ({
      role: 'generate', type: 'image', name, mode: 'i2i', model: 'some-model',
      takesFrom: 'pool', takesPrompt: true,
      prompt: [{ text: 'white ground' }],
    });
    renderCard(true, {
      ...PAIR,
      nodes: [PAIR.nodes[0]!, same('Front'), same('At 45'), same('Overhead')],
      edges: [{ fromIndex: 0, toIndex: 1 }, { fromIndex: 0, toIndex: 2 }, { fromIndex: 0, toIndex: 3 }],
    });

    const chip = screen.getByText('Overhead');
    const layer = chip.parentElement;
    expect(layer?.className).toContain('flex-col');
  });

  it('names the nodes when one line has to be carried out on several', () => {
    // Three takes, each wanting the same thing picked in its own panel. The
    // line merges into one -- said three times it reads as three jobs -- and
    // the names beside it are what says it has to be done three times.
    listModels.mockResolvedValue(CATALOG);
    const same = (name: string): ProposalNode => ({
      role: 'generate', type: 'image', name, mode: 'i2i', model: 'some-model',
      prompt: [
        { text: 'white ground' },
        { slot: { kind: 'tweak', label: 'a ratio', note: 'Pick a ratio in the panel' } },
      ],
    });
    const three: CanvasProposal = {
      ...PAIR,
      nodes: [same('Front'), same('At 45'), same('Overhead')],
      edges: [],
    };
    renderCard(true, three);

    expect(screen.getByText('Front · At 45 · Overhead')).toBeTruthy();
  });

  it('names the node each thing left to do belongs to', () => {
    listModels.mockResolvedValue(CATALOG);
    const mixed: CanvasProposal = {
      ...PAIR,
      nodes: [
        {
          role: 'written',
          type: 'text',
          name: 'Your copy',
          prompt: [
            { text: 'A kettle for ' },
            { slot: { kind: 'tweak', label: 'your brand', note: 'Put your own brand in' } },
          ],
        },
        PAIR.nodes[0]!,
        PAIR.nodes[1]!,
      ],
      edges: [{ fromIndex: 1, toIndex: 2 }],
    };
    renderCard(true, mixed);

    expect(screen.getAllByTestId('proposal-divider')).toHaveLength(1);
    const groups = screen.getAllByTestId('proposal-todo-group');
    expect(groups).toHaveLength(2);
    // One says rewrite something once it is placed, the other says put
    // material in before pressing Generate -- different moments, different
    // places, and the node name is what tells them apart. The second is
    // headed by the generation, which is the only one reading that empty
    // node and the panel the reader is standing at.
    expect(groups[0]?.textContent).toContain('Your copy');
    expect(groups[1]?.textContent).toContain('On white');
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
