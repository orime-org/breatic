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
import type { CanvasProposal, ModelCatalog, ModelEntry, ProposalNode } from '@breatic/shared';

import { nameableFeeders } from '@breatic/shared';

import { nameOf, shapeOf, todosOf } from '@web/pages/project/chat/proposal-card';

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

/** The two lines the card prints under a generation, as the caller passes them in. */
const LINES = { prompt: 'PROMPT READY', settings: 'SETTINGS READY' };

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

  it('files what goes in a shared empty node under each generation, said once for the three', () => {
    // The reader @s the node in each generation's own panel, so each of them
    // lists it; three that ask for the same thing in the same words share one
    // group.
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
      { nodes: ['Front', 'At 45', 'Overhead'], notes: ['Drop your photo in', 'PROMPT READY'] },
    ]);
  });

  it('files every mark under the generation whose prompt carries it, in prompt order', () => {
    // No mark is paired with a node: the reader @s by hand in that panel.
    const drop = (label: string): ProposalNode['prompt'] => [
      { slot: { kind: 'asset', label, note: `Drop the ${label} in` } },
    ];
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
      [
        [1, 2],
        [0, 2],
        [1, 3],
        [0, 3],
      ],
    );

    expect(todosOf(proposal, LINES)).toEqual([
      { nodes: ['The banner', 'The square'], notes: ['Drop the photo in', 'Drop the logo in', 'PROMPT READY'] },
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

  it('lists a note by its own words, under its generation', () => {
    // A note has no card line of its own: what it says is the to-do. On a
    // model drawing no prompt box, this line is the only place it appears.
    const noted: ProposalNode = {
      ...generates('The clip'),
      takesPrompt: false,
      prompt: [{ slot: { kind: 'note', label: 'Pick the first frame in the panel' } }],
    };

    expect(todosOf(flow([noted]), LINES)).toEqual([
      { nodes: ['The clip'], notes: ['Pick the first frame in the panel', 'SETTINGS READY'] },
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

describe('the model a flow runs on, by name', () => {
  /**
   * A video model entry.
   * @param name - Its id.
   * @param mode - The modes it serves.
   * @param variant - What tells it apart from a namesake.
   * @returns The entry.
   */
  function entry(name: string, mode: string[], variant: string): ModelEntry {
    return { name, display_name: 'Gemini Omni 1.1 Flash', variant, modality: 'video', mode } as unknown as ModelEntry;
  }
  const catalog = {
    image: [],
    video: [entry('g-t2v', ['t2v', 'multi_shot'], 'Text-to-Video'), entry('g-ref', ['ref', 'multi_shot'], 'Reference')],
    audio: [],
    tts: [],
    three_d: [],
  } as unknown as ModelCatalog;

  it('is named as the mode\'s picker names it', () => {
    expect(nameOf(catalog, 'g-ref', 'multi_shot')).toBe('Gemini Omni 1.1 Flash Reference');
    expect(nameOf(catalog, 'g-ref', 'ref')).toBe('Gemini Omni 1.1 Flash');
  });

  it('falls back to the id for a model the catalog does not carry', () => {
    expect(nameOf(catalog, 'gone', 'ref')).toBe('gone');
  });
});
