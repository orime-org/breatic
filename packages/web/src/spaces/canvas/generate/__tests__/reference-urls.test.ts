// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which references travel with a submit — the rule both Generate panels read.
 *
 * It began as two copies, character for character down to the sanitiser and
 * its reason, and moved here when the video panel's copy was found (#1927).
 * Tested on its own because it is now the only place either panel decides
 * what reaches the provider.
 */

import { describe, it, expect } from 'vitest';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';
import { focusRefId } from '@web/spaces/canvas/generate/derive-references';
import {
  mentionedImageUrls,
  mentionedReferenceUrls,
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

/**
 * Rail rows for the given source ids, in rail order.
 * @param ids - Source node ids.
 * @returns The minimal rows the derivation reads.
 */
function rows(...ids: string[]): { sourceNodeId: string }[] {
  return ids.map((sourceNodeId) => ({ sourceNodeId }));
}

describe('mentionedImageUrls', () => {
  it('sends the mentioned rows, and only those', () => {
    // Connecting an image offers it; mentioning it uses it. A connected image
    // nobody mentioned must not be paid for in every generation.
    expect(
      mentionedImageUrls(rows('a', 'b'), new Set(['b']), [IMAGE_A, IMAGE_B]),
    ).toEqual(['https://cdn/b.png']);
  });

  it('keeps rail order, not mention order', () => {
    // The payload should read the way the panel does.
    expect(
      mentionedImageUrls(rows('a', 'b'), new Set(['b', 'a']), [IMAGE_A, IMAGE_B]),
    ).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
  });

  it('sends nothing when nothing is mentioned', () => {
    expect(mentionedImageUrls(rows('a', 'b'), new Set(), [IMAGE_A, IMAGE_B])).toEqual([]);
  });

  it('drops a mentioned row whose source is not an image', () => {
    // The rail carries text, audio and video rows too, and a text node's body
    // is not a URL — sending it would put a sentence where the upstream wants
    // a picture.
    const text = node('t', { kind: 'text', status: 'idle' });
    expect(mentionedImageUrls(rows('t'), new Set(['t']), [text])).toEqual([]);
  });

  it('drops a mentioned row whose source has no content yet', () => {
    // An image node that has not been generated or uploaded carries no URL.
    // It reaching the payload as undefined would be worse than dropping it.
    // Dropping it silently was once filed as a defect (#1932); user 2026-08-18
    // ruled it is not one — a reference is a LIVE projection, so a row whose
    // source is still empty is a row the user connected on purpose and will
    // fill in. That task is closed.
    const empty = node('e', { kind: 'image', status: 'idle' });
    expect(mentionedImageUrls(rows('e'), new Set(['e']), [empty])).toEqual([]);
  });

  it('drops a source whose content is not a string', () => {
    // Node content is collaborative Yjs data — untrusted, and outside the
    // catalog boundary. A malformed object is truthy, so a Boolean check
    // would let a non-URL through.
    const malformed = node('m', {
      kind: 'image',
      status: 'idle',
      content: { url: 'https://cdn/x.png' },
    } as unknown as NodeView);
    expect(mentionedImageUrls(rows('m'), new Set(['m']), [malformed])).toEqual([]);
  });

  it('drops a row whose source is gone from the board', () => {
    // A collaborator can delete the source between a mention and a click.
    expect(mentionedImageUrls(rows('ghost'), new Set(['ghost']), [IMAGE_A])).toEqual([]);
  });
});

describe('mentionedReferenceUrls', () => {
  /** A crop stored on the panel's own node. */
  const CROP = { id: 'c1', url: 'https://cdn/crop-1.png' };
  /** A second crop, so crop order is observable too. */
  const CROP_2 = { id: 'c2', url: 'https://cdn/crop-2.png' };

  it('裁剪排在节点参考之后 —— 载荷顺序跟着轨道顺序', () => {
    // 两个来源都提到了，才看得出谁在前。这条正是把两半合到一个函数里的理由：
    // 顺序是这个函数的契约，散在两个面板里各写一遍就没人钉着它。
    expect(
      mentionedReferenceUrls({
        references: rows('a', 'b'),
        focusImages: [CROP],
        atMentioned: new Set(['a', 'b', focusRefId(CROP.id)]),
        nodes: [IMAGE_A, IMAGE_B],
      }),
    ).toEqual(['https://cdn/a.png', 'https://cdn/b.png', CROP.url]);
  });

  it('裁剪之间保持它们在节点上的顺序', () => {
    expect(
      mentionedReferenceUrls({
        references: [],
        focusImages: [CROP, CROP_2],
        atMentioned: new Set([focusRefId(CROP.id), focusRefId(CROP_2.id)]),
        nodes: [],
      }),
    ).toEqual([CROP.url, CROP_2.url]);
  });

  it('没提到的裁剪不上路 —— 在池子里不等于用了它', () => {
    expect(
      mentionedReferenceUrls({
        references: [],
        focusImages: [CROP, CROP_2],
        atMentioned: new Set([focusRefId(CROP_2.id)]),
        nodes: [],
      }),
    ).toEqual([CROP_2.url]);
  });

  it('裁剪的池子 id 带命名空间，跟同名的节点 id 分得开', () => {
    // 一个 id 恰好等于某条裁剪 id 的节点被提到时，不该把那条裁剪也带上路。
    expect(
      mentionedReferenceUrls({
        references: rows('c1'),
        focusImages: [CROP],
        atMentioned: new Set(['c1']),
        nodes: [node('c1', { kind: 'image', status: 'idle', content: 'https://cdn/node-c1.png' })],
      }),
    ).toEqual(['https://cdn/node-c1.png']);
  });
});
