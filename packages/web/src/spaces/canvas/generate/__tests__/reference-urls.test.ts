// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which references travel with a submit — the rule both Generate panels read.
 *
 * It began as two copies, character for character down to the sanitiser and
 * its reason, and moved here when the video panel's copy was found (#1927).
 * Tested on its own because it is now the only place either panel decides
 * what reaches the provider. Since #2156 each mentioned row travels in the
 * list of its own kind, under the param the model reads that kind from.
 */

import type { ReferencePool } from '@breatic/shared';
import { describe, it, expect } from 'vitest';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/data/yjs/node-view';
import { focusRefId } from '@web/spaces/canvas/generate/derive-references';
import {
  mentionDurations,
  mentionTokens,
  mentionedReferenceUrls,
  poolCounts,
  poolParams,
} from '@web/spaces/canvas/generate/reference-urls';

/**
 * A canvas node carrying whatever a case needs it to.
 * @param id - Node id.
 * @param data - The node's view data.
 * @returns The node view pair the derivation reads.
 */
function node(id: string, data: NodeView): Pick<CanvasNodeView, 'id' | 'data'> {
  return { id, data };
}

/** An image node with a URL. */
const IMAGE_A = node('a', { kind: 'image', status: 'idle', content: 'https://cdn/a.png' });
/** A second image node, so order is observable. */
const IMAGE_B = node('b', { kind: 'image', status: 'idle', content: 'https://cdn/b.png' });
/** A video node. */
const CLIP = node('v', { kind: 'video', status: 'idle', content: 'https://cdn/v.mp4' });
/** An audio node. */
const TRACK = node('s', { kind: 'audio', status: 'idle', content: 'https://cdn/s.mp3' });

/**
 * Rail rows for the given source ids, in rail order.
 * @param ids - Source node ids.
 * @returns The minimal rows the derivation reads.
 */
function rows(...ids: string[]): { sourceNodeId: string }[] {
  return ids.map((sourceNodeId) => ({ sourceNodeId }));
}

/**
 * The URLs a set of mentioned rows sends, with no crops.
 * @param ids - The rows, in rail order.
 * @param mentioned - The ids the prompt mentions.
 * @param nodes - The canvas nodes.
 * @returns The URLs, by kind.
 */
function mentioned(
  ids: string[],
  mentioned: string[],
  nodes: Array<Pick<CanvasNodeView, 'id' | 'data'>>,
): ReturnType<typeof mentionedReferenceUrls> {
  return mentionedReferenceUrls({
    references: rows(...ids),
    focusImages: [],
    atMentioned: new Set(mentioned),
    nodes,
  });
}

describe('mentionedReferenceUrls — rows', () => {
  it('sends the mentioned rows, and only those', () => {
    // Connecting an image offers it; mentioning it uses it. A connected image
    // nobody mentioned must not be paid for in every generation.
    expect(mentioned(['a', 'b'], ['b'], [IMAGE_A, IMAGE_B]).image).toEqual(['https://cdn/b.png']);
  });

  it('keeps rail order, not mention order', () => {
    expect(mentioned(['a', 'b'], ['b', 'a'], [IMAGE_A, IMAGE_B]).image).toEqual([
      'https://cdn/a.png',
      'https://cdn/b.png',
    ]);
  });

  it('sorts each row into the list of its own kind', () => {
    expect(mentioned(['a', 'v', 's'], ['a', 'v', 's'], [IMAGE_A, CLIP, TRACK])).toEqual({
      image: ['https://cdn/a.png'],
      video: ['https://cdn/v.mp4'],
      audio: ['https://cdn/s.mp3'],
    });
  });

  it('sends nothing for a text row, an empty one, a malformed one or a missing one', () => {
    const text = node('t', { kind: 'text', status: 'idle' });
    const empty = node('e', { kind: 'image', status: 'idle', content: '' });
    const malformed = node('m', {
      kind: 'image',
      status: 'idle',
      content: { url: 'x' } as unknown as string,
    });
    expect(
      mentioned(['t', 'e', 'm', 'ghost'], ['t', 'e', 'm', 'ghost'], [text, empty, malformed]),
    ).toEqual({ image: [], video: [], audio: [] });
  });
});

describe('mentionedReferenceUrls — crops', () => {
  /** A crop stored on the panel's own node. */
  const CROP = { id: 'c1', url: 'https://cdn/crop-1.png' };
  /** A second crop, so crop order is observable too. */
  const CROP_2 = { id: 'c2', url: 'https://cdn/crop-2.png' };

  it('puts crops after node rows, in rail order', () => {
    expect(
      mentionedReferenceUrls({
        references: rows('a', 'b'),
        focusImages: [CROP],
        atMentioned: new Set(['a', 'b', focusRefId(CROP.id)]),
        nodes: [IMAGE_A, IMAGE_B],
      }).image,
    ).toEqual(['https://cdn/a.png', 'https://cdn/b.png', CROP.url]);
  });

  it('keeps crops in the order the node stores them, and only the mentioned ones', () => {
    expect(
      mentionedReferenceUrls({
        references: [],
        focusImages: [CROP, CROP_2],
        atMentioned: new Set([focusRefId(CROP_2.id)]),
        nodes: [],
      }).image,
    ).toEqual([CROP_2.url]);
  });

  it('keeps a crop apart from a node whose id happens to equal its own', () => {
    expect(
      mentionedReferenceUrls({
        references: rows('c1'),
        focusImages: [CROP],
        atMentioned: new Set(['c1']),
        nodes: [node('c1', { kind: 'image', status: 'idle', content: 'https://cdn/node-c1.png' })],
      }).image,
    ).toEqual(['https://cdn/node-c1.png']);
  });
});

describe('the pool in a task', () => {
  const urls = { image: ['https://cdn/a.png'], video: ['https://cdn/v.mp4'], audio: [] };
  const seedance: ReferencePool = {
    image: { param: 'images', cap: 30 },
    video: { param: 'videos', cap: 10 },
    audio: { param: 'audios', cap: 10 },
  };

  it('sends each kind under the param the model reads it from, and no empty list', () => {
    expect(poolParams(seedance, urls)).toEqual({
      images: ['https://cdn/a.png'],
      videos: ['https://cdn/v.mp4'],
    });
    expect(poolParams({ image: { param: 'elements', cap: 3 } }, urls)).toEqual({
      elements: ['https://cdn/a.png'],
    });
  });

  it('leaves behind a kind the model takes nothing of', () => {
    expect(poolParams({ image: { param: 'images', cap: undefined } }, urls)).toEqual({
      images: ['https://cdn/a.png'],
    });
  });

  it('counts each kind against its own cap', () => {
    expect(poolCounts(seedance, urls)).toEqual([
      { kind: 'image', count: 1, cap: 30 },
      { kind: 'video', count: 1, cap: 10 },
      { kind: 'audio', count: 0, cap: 10 },
    ]);
  });
});

describe('mentionTokens — how each mentioned chip is written into the prompt', () => {
  /** A pool that names its chips per kind, counted from 1. */
  const h3: ReferencePool = {
    image: { param: 'images', cap: 9, mention: '<Picture {n}>' },
    video: { param: 'videos', cap: 3, mention: '<Video {n}>' },
  };
  const nodes = [IMAGE_A, IMAGE_B, CLIP, TRACK];

  it('numbers each kind on its own, in rail order, the way the lists are sent', () => {
    // The rail reads a, v, b: pictures are counted apart from clips, and the
    // number is the place in the list that goes to the vendor.
    const tokens = mentionTokens(h3, {
      references: rows('a', 'v', 'b'),
      focusImages: [],
      atMentioned: new Set(['b', 'v', 'a']),
      nodes,
    });
    expect(tokens).toEqual({
      a: '<Picture 1>',
      v: '<Video 1>',
      b: '<Picture 2>',
    });
  });

  it('counts a crop after the node rows, since it is sent after them', () => {
    const tokens = mentionTokens(h3, {
      references: rows('a'),
      focusImages: [{ id: 'c1', url: 'https://cdn/c1.png' }],
      atMentioned: new Set(['a', focusRefId('c1')]),
      nodes,
    });
    expect(tokens[focusRefId('c1')]).toBe('<Picture 2>');
  });

  it('counts from 0 where the model says {i}', () => {
    const gemini: ReferencePool = { image: { param: 'images', cap: 10, mention: '<IMAGE_REF_{i}>' } };
    const tokens = mentionTokens(gemini, {
      references: rows('a', 'b'),
      focusImages: [],
      atMentioned: new Set(['a', 'b']),
      nodes,
    });
    expect(tokens).toEqual({ a: '<IMAGE_REF_0>', b: '<IMAGE_REF_1>' });
  });

  it('writes nothing for what is not sent: unmentioned, not taken, or unnamed', () => {
    // A row nobody mentioned skips its number; the track is a kind this model
    // takes nothing of; the clip travels but its model names no spelling.
    const quiet: ReferencePool = {
      image: { param: 'images', cap: undefined, mention: 'image {n}' },
      video: { param: 'videos', cap: undefined, mention: undefined },
    };
    const tokens = mentionTokens(quiet, {
      references: rows('a', 'b', 'v', 's'),
      focusImages: [],
      atMentioned: new Set(['b', 'v', 's']),
      nodes,
    });
    expect(tokens).toEqual({ b: 'image 1' });
  });
});

describe('mentionDurations — how long the mentioned clips and tracks run', () => {
  const pool: ReferencePool = {
    image: { param: 'images', cap: undefined },
    video: { param: 'videos', cap: undefined },
    audio: { param: 'audios', cap: undefined },
  };
  const clip = (id: string, duration?: number): Pick<CanvasNodeView, 'id' | 'data'> =>
    node(id, { kind: 'video', status: 'idle', content: `https://cdn/${id}.mp4`, duration });
  const track = (id: string, duration?: number): Pick<CanvasNodeView, 'id' | 'data'> =>
    node(id, { kind: 'audio', status: 'idle', content: `https://cdn/${id}.mp3`, duration });

  it('lists each kind\'s lengths in the order its files are sent, under its param', () => {
    const durations = mentionDurations(pool, {
      references: rows('v2', 'a', 'v1', 's'),
      focusImages: [],
      atMentioned: new Set(['v1', 'v2', 'a', 's']),
      nodes: [clip('v1', 4), clip('v2', 9.5), IMAGE_A, track('s', 12)],
    });
    expect(durations).toEqual({ videos: [9.5, 4], audios: [12] });
  });

  it('leaves out a kind while any of its files has no known length', () => {
    // A partial list would be priced as if the unknown clip were free.
    const durations = mentionDurations(pool, {
      references: rows('v1', 'v2'),
      focusImages: [],
      atMentioned: new Set(['v1', 'v2']),
      nodes: [clip('v1', 4), clip('v2')],
    });
    expect(durations).toEqual({});
  });
});
