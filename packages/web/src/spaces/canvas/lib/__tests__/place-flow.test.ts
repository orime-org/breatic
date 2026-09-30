// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a proposed flow arranges itself on the canvas (#263).
 *
 * The arrangement is the only thing on screen that says which node feeds
 * which: a reader looking at three nodes in a row reads them as three steps,
 * and one photo feeding three angles is not three steps. So the cases below
 * ask where the nodes end up relative to each other, never for the pixels.
 */

import { describe, it, expect } from 'vitest';
import type { CanvasProposal, ProposalNode } from '@breatic/shared';

import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import { estimateHeight, planFlowLayout } from '@web/spaces/canvas/lib/place-flow';

const AT = { x: 1000, y: 500 };

/** An empty node waiting for the reader's material. */
const empty = (name: string): ProposalNode => ({ role: 'source', type: 'image', name });

/** A node waiting for the reader to press Generate. */
const generates = (name: string): ProposalNode => ({
  role: 'generate',
  type: 'image',
  name,
  mode: 'i2i',
  model: 'a-model',
  prompt: [{ text: 'white ground' }],
});

/** A node carrying words already written. */
const written = (name: string, text: string): ProposalNode => ({
  role: 'written',
  type: 'text',
  name,
  prompt: [{ text }],
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

describe('where one node lands', () => {
  it('sits centred on the point the reader was looking at', () => {
    const [only] = planFlowLayout(flow([generates('Result')]), AT);
    if (!only) throw new Error('nothing was placed');

    expect(only.x + only.width / 2).toBe(AT.x);
    expect(only.y + only.height / 2).toBe(AT.y);
    expect(only.width).toBe(EMPTY_NODE_SIZE.width);
  });
});

describe('where a flow lays itself out', () => {
  it('puts what feeds a node to its left', () => {
    const placed = planFlowLayout(flow([empty('Yours'), generates('Result')], [[0, 1]]), AT);
    const [source, result] = placed;
    if (!source || !result) throw new Error('nothing was placed');

    expect(source.x).toBeLessThan(result.x);
    expect(source.x + source.width).toBeLessThanOrEqual(result.x);
    expect(source.width).toBe(EMPTY_NODE_SIZE.width);
  });

  it('stacks one source feeding three generations into a single column', () => {
    const placed = planFlowLayout(
      flow(
        [empty('Yours'), generates('One'), generates('Two'), generates('Three')],
        [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
      ),
      AT,
    );
    const [, one, two, three] = placed;
    if (!one || !two || !three) throw new Error('nothing was placed');

    expect(new Set([one.x, two.x, three.x]).size).toBe(1);
    expect(one.y).toBeLessThan(two.y);
    expect(two.y).toBeLessThan(three.y);
    expect(one.y + one.height).toBeLessThanOrEqual(two.y);
    expect(two.y + two.height).toBeLessThanOrEqual(three.y);
  });

  it('keeps a node carrying eleven lines clear of the one under it', () => {
    const long = 'A pour-over kettle, slow and warm.\n'.repeat(11);
    const placed = planFlowLayout(flow([written('Copy', long), empty('Yours')]), AT);
    const [copy, yours] = placed;
    if (!copy || !yours) throw new Error('nothing was placed');

    expect(copy.height).toBeGreaterThan(EMPTY_NODE_SIZE.height);
    expect(copy.y + copy.height).toBeLessThanOrEqual(yours.y);
  });

  it('centres the whole arrangement on the point, however it forks', () => {
    const placed = planFlowLayout(
      flow(
        [empty('Yours'), generates('One'), generates('Two')],
        [
          [0, 1],
          [0, 2],
        ],
      ),
      AT,
    );
    const left = Math.min(...placed.map((p) => p.x));
    const right = Math.max(...placed.map((p) => p.x + p.width));
    const top = Math.min(...placed.map((p) => p.y));
    const bottom = Math.max(...placed.map((p) => p.y + p.height));

    expect((left + right) / 2).toBe(AT.x);
    expect((top + bottom) / 2).toBe(AT.y);
    // A fork takes up two layers across and two rows down, so the arrangement
    // is wider and taller than the one node a degenerate answer would give.
    expect(right - left).toBeGreaterThan(EMPTY_NODE_SIZE.width);
    expect(bottom - top).toBeGreaterThan(EMPTY_NODE_SIZE.height);
  });

  it('gives a node three layers downstream three layers of room', () => {
    const placed = planFlowLayout(
      flow(
        [empty('Yours'), generates('One'), generates('Two'), generates('Three')],
        [
          [0, 1],
          [1, 2],
          [2, 3],
        ],
      ),
      AT,
    );
    const xs = placed.map((p) => p.x);

    expect(new Set(xs).size).toBe(4);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe('how tall a node is taken to be', () => {
  it('gives an empty node and a generation the standard footprint', () => {
    expect(estimateHeight(empty('Yours'))).toBe(EMPTY_NODE_SIZE.height);
    expect(estimateHeight(generates('Result'))).toBe(EMPTY_NODE_SIZE.height);
  });

  it('cuts a block on each break, not the two an editor writes', () => {
    // Thirteen short lines: thirteen 20px lines of `text-sm` plus the 12px of
    // padding `p-3` puts above and below. Counted the way a prompt box counts
    // them -- two breaks between blocks -- the same words would be twenty-five
    // lines and the node half again as tall.
    const thirteen = written('Copy', Array.from({ length: 13 }, () => 'x').join('\n'));

    expect(estimateHeight(thirteen)).toBe(13 * 20 + 24);
  });

  it('stops growing where the body starts to clip', () => {
    const endless = written('Copy', 'a line of words\n'.repeat(200));

    expect(estimateHeight(endless)).toBe(576);
  });

  it('counts a full-width character as twice a half-width one', () => {
    // CJK is drawn at the type size and Latin at half of it, so the same
    // count of characters wraps to twice as many lines.
    const cjk = written('Copy', '手冲壶'.repeat(200));
    const latin = written('Copy', 'abc'.repeat(200));

    expect(estimateHeight(cjk)).toBeGreaterThan(estimateHeight(latin));
  });
});
