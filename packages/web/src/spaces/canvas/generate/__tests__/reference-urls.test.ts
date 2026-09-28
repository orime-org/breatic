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
