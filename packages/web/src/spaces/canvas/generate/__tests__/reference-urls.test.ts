// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { mentionedImageUrls } from '@web/spaces/canvas/generate/reference-urls';

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
    // It reaching the payload as undefined would be worse than dropping it;
    // that it drops SILENTLY is tracked separately (#1932).
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
