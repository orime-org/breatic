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
      { node: 'Your copy', notes: ['Put your own brand in'] },
      { node: 'On white', notes: ['Pick a ratio'] },
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
      { node: 'Your photo', notes: ['Drop your photo in'] },
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
  it('adds up every generation, since one press runs all of them', () => {
    const proposal = flow([generates('Front'), generates('At 45'), generates('Overhead')]);

    expect(costOf(CATALOG, proposal)).toEqual({ credits: 12, seconds: 12, runs: 3 });
  });

  it('gives the wait alone when a model charges by what it is given', () => {
    // A metered model has no per-call price at all, so a total including it
    // would be a number nobody can arrive at.
    const proposal = flow([generates('Front'), generates('Long one', 'metered-model')]);

    expect(costOf(CATALOG, proposal)).toEqual({ seconds: 30, runs: 2 });
  });

  it('counts only what generates, not the words placed beside it', () => {
    const proposal = flow([written('Your copy'), generates('Front'), generates('At 45')]);

    expect(costOf(CATALOG, proposal)).toEqual({ credits: 8, seconds: 12, runs: 2 });
  });

  it('says nothing at all about a model the catalog does not carry', () => {
    const proposal = flow([generates('Front'), generates('Mystery', 'no-such-model')]);

    expect(costOf(CATALOG, proposal)).toBeUndefined();
  });

  it('says nothing about a flow with nothing that generates', () => {
    expect(costOf(CATALOG, flow([written('Your copy')]))).toBeUndefined();
  });
});
