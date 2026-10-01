// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a card says about a flow, before the reader presses it (#263).
 *
 * A proposal used to build one thing, so the card had one shape to draw, one
 * list of things left to do, and one price. A flow has several of each, and
 * every one of them read the first generation node and stopped -- a card
 * quoting one press of three, and a little diagram saying the copy was fed
 * into the picture.
 */

import { describe, it, expect } from 'vitest';
import type { CanvasProposal, ModelCatalog, ProposalNode } from '@breatic/shared';

import { nameableFeeders } from '@breatic/shared';

import { costOf, creditsOf, shapeOf, todosOf } from '@web/pages/project/chat/proposal-card';

/** An empty node waiting for the reader's material. */
const empty = (name: string): ProposalNode => ({ role: 'source', type: 'image', name });

/** A node waiting for the reader to press Generate, with its own marks. */
const generates = (name: string, model = 'flat-model', notes: string[] = []): ProposalNode => ({
  role: 'generate',
  type: 'image',
  name,
  mode: 'i2i',
  model,
  // What the check writes onto every generation it lets through, read off the
  // catalog: an i2i model takes its material through the reference pool and
  // draws a prompt box. A fixture without them is a proposal the check never
  // produced.
  poolKinds: ['image'],
  takesPrompt: true,
  prompt: [
    { text: 'white ground' },
    ...notes.map((note) => ({
      slot: { kind: 'tweak' as const, label: 'a choice', note },
    })),
  ],
});

/** A node carrying words already written. */
const written = (name: string, notes: string[] = []): ProposalNode => ({
  role: 'written',
  type: 'text',
  name,
  prompt: [
    { text: 'a pour-over kettle' },
    ...notes.map((note) => ({
      slot: { kind: 'tweak' as const, label: 'your brand', note },
    })),
  ],
});

/** A proposal out of nodes and index pairs. */
const flow = (
  nodes: ProposalNode[],
  edges: Array<[number, number]> = [],
): CanvasProposal => ({
  nodes,
  edges: edges.map(([fromIndex, toIndex]) => ({ fromIndex, toIndex })),
  rationale: '',
});

/** 4 credits a call, whatever the run. */
const FLAT = { base_price: 40_000, formula: '', discount_rate: 100 };

/** The two lines the card prints under a generation, as the caller passes them in. */
const LINES = { prompt: 'PROMPT READY', settings: 'SETTINGS READY' };

/** A catalog with two per-call models and one priced by its source's length. */
const CATALOG = {
  image: [
    { name: 'flat-model', display_name: 'Flat', takes_prompt: true, params: {}, pricing: FLAT, generation_time: 12 },
    { name: 'slow-model', display_name: 'Slow', takes_prompt: true, params: {}, pricing: FLAT, generation_time: 30 },
    {
      name: 'metered-model',
      display_name: 'Metered',
      takes_prompt: true,
      params: { video: { description: '', default: null, fill: 'canvas', accepts: 'video' } },
      pricing: {
        base_price: 20_000,
        formula: '{"total_price": base_price * $ceil(get_duration(video))}',
        discount_rate: 100,
      },
      generation_time: 30,
    },
  ],
  video: [],
  audio: [],
  tts: [],
  three_d: [],
  understand: [],
  total: 3,
  credit_multiplier: 1,
} as unknown as ModelCatalog;

describe('the little diagram of what gets built', () => {
  it('keeps a node wired to nothing out of the chain it is drawn beside', () => {
    // The copy is not the prompt for the picture -- nothing wires it in -- and
    // one chain would read as though it were.
    const proposal = flow(
      [written('Your copy'), empty('Your photo'), generates('On white')],
      [[1, 2]],
    );

    const groups = shapeOf(proposal);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((layer) => layer.map((c) => c.label))).toEqual([['Your copy']]);
    expect(groups[1]?.map((layer) => layer.map((c) => c.label))).toEqual([
      ['Your photo'],
      ['On white'],
    ]);
  });

  it('puts one source feeding three generations in one layer, not a chain', () => {
    const proposal = flow(
      [empty('Your photo'), generates('Front'), generates('At 45'), generates('Overhead')],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );

    const groups = shapeOf(proposal);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((layer) => layer.map((c) => c.label))).toEqual([
      ['Your photo'],
      ['Front', 'At 45', 'Overhead'],
    ]);
  });

  it('marks the node the reader fills in, wherever it sits', () => {
    const proposal = flow([empty('Your photo'), generates('On white')], [[0, 1]]);

    const groups = shapeOf(proposal);

    expect(groups[0]?.[0]?.[0]?.empty).toBe(true);
    expect(groups[0]?.[1]?.[0]?.empty).toBe(false);
  });
});

describe('what is left for the reader', () => {
  it('hangs each note under the node it is about', () => {
    const proposal = flow([
      written('Your copy', ['Put your own brand in']),
      generates('On white', 'flat-model', ['Pick a ratio']),
    ]);

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['Your copy'], notes: ['Put your own brand in'] },
      { nodes: ['On white'], notes: ['Pick a ratio', 'PROMPT READY'] },
    ]);
  });

  it('hangs the material note under the generation when only it reads that node', () => {
    // §6.2 of the design and the demo both draw it there: one generation, one
    // empty node, and the reader does both to-dos at that panel. Filed under
    // the empty node instead, a two-node group draws three to-do groups where
    // the demo draws two.
    const proposal = flow(
      [
        empty('Your photo'),
        {
          ...generates('On white'),
          prompt: [
            { text: 'white ground' },
            { slot: { kind: 'asset', label: 'your photo', note: 'Drop your photo in' } },
          ],
        },
      ],
      [[0, 1]],
    );

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['On white'], notes: ['Drop your photo in', 'PROMPT READY'] },
    ]);
  });

  it('files a slot-fed generation\'s material note under the generation', () => {
    // Through a slot the reader picks by clicking, so no mention is written
    // and there is no empty node for the note to hang under -- the bracket
    // names the slot, and the panel it is picked in is this generation's.
    const proposal = flow(
      [
        empty('Your photo'),
        {
          ...generates('The clip'),
          poolKinds: [],
          prompt: [
            { text: 'pan across' },
            { slot: { kind: 'asset', label: 'your photo', note: 'Pick it in the first slot' } },
          ],
        },
      ],
      [],
    );

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['The clip'], notes: ['Pick it in the first slot', 'PROMPT READY'] },
    ]);
  });

  it('keeps two marks in one prompt as two things to do', () => {
    // Two slots on one panel, and the model wrote the same words about each.
    // Merged into one line the reader sees one job and two brackets.
    const same = { kind: 'asset' as const, label: 'a frame', note: 'Pick a frame' };
    const proposal = flow([
      {
        ...generates('The tween'),
        poolKinds: [],
        prompt: [{ text: 'morph' }, { slot: same }, { slot: same }],
      },
    ]);

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['The tween'], notes: ['Pick a frame', 'Pick a frame', 'PROMPT READY'] },
    ]);
  });

  it('says once what goes in an empty node three generations share', () => {
    // Every one of the three marks the same empty node, so the note about it
    // is one note -- written three times it reads as three photos to find.
    const drop = { kind: 'asset' as const, label: 'your photo', note: 'Drop your photo in' };
    const angle = (name: string): ProposalNode => ({
      ...generates(name),
      prompt: [{ text: 'white ground' }, { slot: drop }],
    });
    const proposal = flow(
      [empty('Your photo'), angle('Front'), angle('At 45'), angle('Overhead')],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['Your photo'], notes: ['Drop your photo in'] },
      { nodes: ['Front', 'At 45', 'Overhead'], notes: ['PROMPT READY'] },
    ]);
  });

  it('files each mark under the node the canvas will point it at', () => {
    // The k-th mark belongs to the k-th empty node in NODE order, which is
    // what the canvas writes the mention against. Reading the edge list
    // instead files the notes under whichever node the model happened to
    // wire first, and the reader puts their material in the wrong box.
    const drop = (label: string): ProposalNode['prompt'] => [
      { slot: { kind: 'asset', label, note: `Drop the ${label} in` } },
    ];
    // Both generations read both empty nodes, so the notes hang under the
    // nodes themselves and the pairing is on screen to be got wrong.
    const proposal = flow(
      [
        empty('Your photo'),
        empty('Your logo'),
        {
          ...generates('The banner'),
          prompt: [...(drop('photo') ?? []), ...(drop('logo') ?? [])],
        },
        {
          ...generates('The square'),
          prompt: [...(drop('photo') ?? []), ...(drop('logo') ?? [])],
        },
      ],
      // Listed back to front: nothing makes a model list its edges in the
      // order it listed its nodes.
      [
        [1, 2],
        [0, 2],
        [1, 3],
        [0, 3],
      ],
    );

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['Your photo'], notes: ['Drop the photo in'] },
      { nodes: ['Your logo'], notes: ['Drop the logo in'] },
      { nodes: ['The banner', 'The square'], notes: ['PROMPT READY'] },
    ]);
  });

  it('says once what three nodes ask for in the same words', () => {
    // Three angles all wanting a ratio picked is one line of instruction, not
    // three. Written out per node it reads as three separate jobs.
    const angle = (name: string): ProposalNode =>
      generates(name, 'flat-model', ['Pick a ratio']);
    const proposal = flow([angle('Front'), angle('At 45'), angle('Overhead')]);

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['Front', 'At 45', 'Overhead'], notes: ['Pick a ratio', 'PROMPT READY'] },
    ]);
  });

  it('leaves a mark pointing upstream out of the to-dos: it asks the reader for nothing', () => {
    // It names the node this sentence means, which is already true the moment
    // the flow lands. A line under "what is left" would be a job with nothing
    // in it.
    const points: ProposalNode = {
      ...generates('At 45'),
      prompt: [
        { text: 'in the light of ' },
        { slot: { kind: 'ref', label: 'the first', note: 'Nothing to do' } },
      ],
    };
    const proposal = flow([generates('Front'), points], [[0, 1]]);

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['Front', 'At 45'], notes: ['PROMPT READY'] },
    ]);
  });

  it('gives words already written no line of their own', () => {
    const proposal = flow([written('Your copy'), generates('On white')]);

    expect(todosOf(proposal, LINES)).toEqual([{ nodes: ['On white'], notes: ['PROMPT READY'] }]);
  });
});

describe('where each generation\'s prompt is found (#289)', () => {
  // The prompt the agent wrote lives in the generation panel, and a reader
  // new to the canvas does not know a right-click opens it. Every generation
  // says so under its own name, last, after whatever the agent asked of them.
  it('tells the reader a written prompt is waiting in the panel', () => {
    const proposal = flow([empty('Your photo'), generates('On white')], [[0, 1]]);

    expect(todosOf(proposal, LINES)).toEqual([{ nodes: ['On white'], notes: ['PROMPT READY'] }]);
  });

  it('says the settings are ready where the model draws no prompt box', () => {
    // A talking-head model takes a portrait and a recording, no prompt: the
    // panel draws no box, so "the prompt is written" would send the reader
    // looking for something that is not there.
    const proposal = flow([{ ...generates('Talking head'), takesPrompt: false }]);

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['Talking head'], notes: ['SETTINGS READY'] },
    ]);
  });

  it('says the settings are ready when the generation carries no prompt', () => {
    const proposal = flow([{ ...generates('On white'), prompt: [] }]);

    expect(todosOf(proposal, LINES)).toEqual([{ nodes: ['On white'], notes: ['SETTINGS READY'] }]);
  });

  it('puts the line after the agent\'s own to-dos for that node', () => {
    const proposal = flow([generates('On white', 'flat-model', ['Pick a ratio'])]);

    expect(todosOf(proposal, LINES)[0]?.notes.at(-1)).toBe('PROMPT READY');
  });

  it('counts a storyboard\'s shots as the prompt the panel holds (#2218)', () => {
    const shots = [{ prompt: [{ text: 'a boat' }], duration: 5 }];
    const proposal = flow([{ ...generates('Clip'), prompt: [], shots }]);

    expect(todosOf(proposal, LINES)).toEqual([{ nodes: ['Clip'], notes: ['PROMPT READY'] }]);
  });

  it('lists a to-do marked inside a shot (#2218)', () => {
    const shots = [{ prompt: [{ slot: { kind: 'tweak' as const, label: 'a mood', note: 'Pick a mood' } }], duration: 5 }];
    const proposal = flow([{ ...generates('Clip'), prompt: [], shots }]);

    expect(todosOf(proposal, LINES)).toEqual([{ nodes: ['Clip'], notes: ['Pick a mood', 'PROMPT READY'] }]);
  });

  it('gives an empty node and written words no such line', () => {
    const proposal = flow([empty('Your photo'), written('Your copy')]);

    expect(todosOf(proposal, LINES)).toEqual([]);
  });
});

describe('what one press costs', () => {
  it('adds up every generation the placed group will run', async () => {
    const proposal = flow([generates('Front'), generates('At 45'), generates('Overhead')]);

    expect(costOf(CATALOG, proposal)).toEqual({ seconds: 12, runs: 3, sameLength: true });
    expect(await creditsOf(CATALOG, proposal)).toEqual({ credits: 12, bound: 'exact' });
  });

  it('says the runs are not the same length when the models differ', () => {
    // "12 s x 2" says both runs take twelve seconds, and one of them takes
    // thirty. The card draws the multiplied form only where an "each" exists.
    const proposal = flow([generates('Front'), generates('The clip', 'slow-model')]);

    expect(costOf(CATALOG, proposal)).toEqual({ seconds: 30, runs: 2, sameLength: false });
  });

  it('gives a lower bound when a run is priced by a source not yet picked', async () => {
    // The empty node's clip has no length yet, so its run prices at the least
    // it can cost.
    const proposal = flow([generates('Front'), generates('Long one', 'metered-model')]);

    expect(await creditsOf(CATALOG, proposal)).toEqual({ credits: 4, bound: 'at_least' });
  });

  it('counts only what generates, not the words placed beside it', async () => {
    const proposal = flow([written('Your copy'), generates('Front'), generates('At 45')]);

    expect(costOf(CATALOG, proposal)).toEqual({ seconds: 12, runs: 2, sameLength: true });
    expect(await creditsOf(CATALOG, proposal)).toEqual({ credits: 8, bound: 'exact' });
  });

  it('says nothing at all about a model the catalog does not carry', async () => {
    const proposal = flow([generates('Front'), generates('Mystery', 'no-such-model')]);

    expect(costOf(CATALOG, proposal)).toBeUndefined();
    expect(await creditsOf(CATALOG, proposal)).toBeUndefined();
  });

  it('says nothing about a flow with nothing that generates', async () => {
    // The check turns that shape away, so the card never draws one. Held here
    // because the card does not re-check what it is handed, and a total of
    // zero credits would read as free.
    expect(costOf(CATALOG, flow([written('Your copy')]))).toBeUndefined();
    expect(await creditsOf(CATALOG, flow([written('Your copy')]))).toBeUndefined();
  });
});

describe('what a wired source does to the price', () => {
  // Priced like Seedance: a run with a reference clip takes the other branch.
  const BRANCHING = {
    ...CATALOG,
    video: [
      {
        name: 'branching-model',
        display_name: 'Branching',
        takes_prompt: true,
        params: {
          refs: {
            description: '',
            upstream: 'reference_videos',
            default: null,
            fill: 'pool',
            type: 'list',
            accepts: 'video',
            optional: true,
          },
        },
        pricing: {
          base_price: 40_000,
          formula: '{"total_price": $count(reference_videos) > 0 ? 100000 : base_price}',
          discount_rate: 100,
        },
        generation_time: 30,
      },
    ],
  } as unknown as ModelCatalog;

  const clipRun: ProposalNode = {
    role: 'generate',
    type: 'video',
    name: 'The clip',
    mode: 't2v',
    model: 'branching-model',
    poolKinds: ['video'],
    takesPrompt: true,
    prompt: [{ text: 'follow it' }],
  };

  it('prices a run with the clip its prompt marks, as the run will be sent', async () => {
    const marked: ProposalNode = {
      ...clipRun,
      prompt: [{ text: 'follow ' }, { slot: { kind: 'asset', label: 'your clip', note: 'Drop it in' } }],
    };
    const proposal = flow([{ role: 'source', type: 'video', name: 'Your clip' }, marked], [[0, 1]]);

    expect(await creditsOf(BRANCHING, proposal)).toEqual({ credits: 10, bound: 'exact' });
  });

  it('prices a clip wired in but never marked as not sent', async () => {
    const proposal = flow([{ role: 'source', type: 'video', name: 'Your clip' }, clipRun], [[0, 1]]);

    expect(await creditsOf(BRANCHING, proposal)).toEqual({ credits: 4, bound: 'exact' });
  });

  it('prices the same run without the wire on the other branch', async () => {
    expect(await creditsOf(BRANCHING, flow([clipRun]))).toEqual({ credits: 4, bound: 'exact' });
  });
});

describe('a proposal stored before the check answered these questions', () => {
  it('names no feeder at all, rather than guessing which way it took', () => {
    // A row stored before the two catalog facts travelled on the node. What
    // the panel would accept turns on them, so a guess either writes a
    // mention it refuses or drops one the pool needs.
    const proposal = flow(
      [
        generates('The first take'),
        { ...generates('On white'), poolKinds: undefined, takesPrompt: undefined },
      ],
      [[0, 1]],
    );

    expect(nameableFeeders(proposal, 1)).toEqual({ sources: [], upstream: [], slotted: [] });
  });

  it('holds the place of a feeder the panel cannot mention', () => {
    // The k-th mark is about the k-th node wired in, and the marks are written
    // against the whole run. Dropping the one that cannot be mentioned would
    // slide every mark after it onto the wrong node.
    const proposal = flow(
      [
        { role: 'source', type: 'video', name: 'Your clip' },
        { role: 'source', type: 'image', name: 'Your still' },
        generates('The cut'),
      ],
      [[0, 2], [1, 2]],
    );

    expect(nameableFeeders(proposal, 2)).toEqual({ sources: [null, 1], upstream: [], slotted: [] });
  });
});
