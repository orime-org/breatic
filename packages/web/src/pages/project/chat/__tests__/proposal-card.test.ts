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

import { costOf, shapeOf, todosOf } from '@web/pages/project/chat/proposal-card';

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
  takesFrom: 'pool',
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

/** A catalog with one model charging per call and one charging by usage. */
const CATALOG = {
  image: [
    { name: 'flat-model', display_name: 'Flat', cost_per_call: 4, generation_time: 12 },
    { name: 'slow-model', display_name: 'Slow', cost_per_call: 4, generation_time: 30 },
    {
      name: 'metered-model',
      display_name: 'Metered',
      cost_per_call: 1,
      rate: { unit: 'second', credits: 2 },
      generation_time: 30,
    },
  ],
  video: [],
  audio: [],
  tts: [],
  three_d: [],
  understand: [],
  total: 2,
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

    expect(todosOf(proposal)).toEqual([
      { nodes: ['Your copy'], notes: ['Put your own brand in'] },
      { nodes: ['On white'], notes: ['Pick a ratio'] },
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

    expect(todosOf(proposal)).toEqual([
      { nodes: ['On white'], notes: ['Drop your photo in'] },
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
          takesFrom: 'slot',
          prompt: [
            { text: 'pan across' },
            { slot: { kind: 'asset', label: 'your photo', note: 'Pick it in the first slot' } },
          ],
        },
      ],
      [],
    );

    expect(todosOf(proposal)).toEqual([
      { nodes: ['The clip'], notes: ['Pick it in the first slot'] },
    ]);
  });

  it('keeps two marks in one prompt as two things to do', () => {
    // Two slots on one panel, and the model wrote the same words about each.
    // Merged into one line the reader sees one job and two brackets.
    const same = { kind: 'asset' as const, label: 'a frame', note: 'Pick a frame' };
    const proposal = flow([
      {
        ...generates('The tween'),
        takesFrom: 'slot',
        prompt: [{ text: 'morph' }, { slot: same }, { slot: same }],
      },
    ]);

    expect(todosOf(proposal)).toEqual([
      { nodes: ['The tween'], notes: ['Pick a frame', 'Pick a frame'] },
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

    expect(todosOf(proposal)).toEqual([
      { nodes: ['Your photo'], notes: ['Drop your photo in'] },
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

    expect(todosOf(proposal)).toEqual([
      { nodes: ['Your photo'], notes: ['Drop the photo in'] },
      { nodes: ['Your logo'], notes: ['Drop the logo in'] },
    ]);
  });

  it('says once what three nodes ask for in the same words', () => {
    // Three angles all wanting a ratio picked is one line of instruction, not
    // three. Written out per node it reads as three separate jobs.
    const angle = (name: string): ProposalNode =>
      generates(name, 'flat-model', ['Pick a ratio']);
    const proposal = flow([angle('Front'), angle('At 45'), angle('Overhead')]);

    expect(todosOf(proposal)).toEqual([
      { nodes: ['Front', 'At 45', 'Overhead'], notes: ['Pick a ratio'] },
    ]);
  });

  it('leaves a mark pointing upstream out: it asks the reader for nothing', () => {
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

    expect(todosOf(proposal)).toEqual([]);
  });

  it('leaves out a node whose prompt asks for nothing', () => {
    const proposal = flow([written('Your copy'), generates('On white')]);

    expect(todosOf(proposal)).toEqual([]);
  });
});

describe('what one press costs', () => {
  it('adds up every generation the placed group will run', () => {
    const proposal = flow([generates('Front'), generates('At 45'), generates('Overhead')]);

    expect(costOf(CATALOG, proposal)).toEqual({
      credits: 12,
      seconds: 12,
      runs: 3,
      sameLength: true,
    });
  });

  it('says the runs are not the same length when the models differ', () => {
    // "12 s x 2" says both runs take twelve seconds, and one of them takes
    // thirty. The card draws the multiplied form only where an "each" exists.
    const proposal = flow([generates('Front'), generates('The clip', 'slow-model')]);

    expect(costOf(CATALOG, proposal)).toEqual({
      credits: 8,
      seconds: 30,
      runs: 2,
      sameLength: false,
    });
  });

  it('gives the wait alone when a model charges by what it is given', () => {
    // A metered model has no per-call price at all, so a total including it
    // would be a number nobody can arrive at.
    const proposal = flow([generates('Front'), generates('Long one', 'metered-model')]);

    expect(costOf(CATALOG, proposal)).toEqual({ seconds: 30, runs: 2, sameLength: false });
  });

  it('counts only what generates, not the words placed beside it', () => {
    const proposal = flow([written('Your copy'), generates('Front'), generates('At 45')]);

    expect(costOf(CATALOG, proposal)).toEqual({
      credits: 8,
      seconds: 12,
      runs: 2,
      sameLength: true,
    });
  });

  it('says nothing at all about a model the catalog does not carry', () => {
    const proposal = flow([generates('Front'), generates('Mystery', 'no-such-model')]);

    expect(costOf(CATALOG, proposal)).toBeUndefined();
  });

  it('says nothing about a flow with nothing that generates', () => {
    // The check turns that shape away, so the card never draws one. Held here
    // because the card does not re-check what it is handed, and a total of
    // zero credits would read as free.
    expect(costOf(CATALOG, flow([written('Your copy')]))).toBeUndefined();
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
        { ...generates('On white'), takesFrom: undefined, takesPrompt: undefined },
      ],
      [[0, 1]],
    );

    expect(nameableFeeders(proposal, 1)).toEqual({ sources: [], upstream: [] });
  });
});
