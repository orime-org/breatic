// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which storage addresses a paste sends to the server, and how the answer is
 * written back (inner#1349, design 5.4 and 5.10).
 */

import { describe, it, expect } from 'vitest';

import { collectAddresses, historyItems, replaceAddresses } from '@web/spaces/canvas/paste-addresses';
import type { SnapshotNode } from '@web/data/yjs/canvas-space';

const BASE = 'https://resource-dev.breatic.cc';
const UUID = '18f58aed-b802-4243-a8ea-02d377de9679';
const IMG = `${BASE}/image/2026-10-01/1_${UUID}.png`;
const VID = `${BASE}/video/2026-10-01/2_${UUID}.mp4`;
const COVER = `${BASE}/video/2026-10-01/2_${UUID}_cover.png`;
const SLOT_VID = `${BASE}/video/2026-10-01/3_${UUID}.mp4`;
const SLOT_COVER = `${BASE}/video/2026-10-01/3_${UUID}_cover.png`;
const CROP = `${BASE}/image/2026-10-01/4_${UUID}.png`;

/**
 * A snapshot node.
 * @param id - Its id.
 * @param type - Its type.
 * @param data - Its data.
 * @returns The node.
 */
function n(id: string, type: string, data: Record<string, unknown>): SnapshotNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}

const mentionPrompt = (thumbnail: string): Record<string, unknown> => ({
  $y: 'map',
  entries: {
    i2v: {
      $y: 'xml',
      children: [
        { el: 'paragraph', attrs: {}, children: [{ el: 'referenceMention', attrs: { sourceNodeId: 'v', thumbnail, label: 'Clip' }, children: [] }] },
      ],
    },
  },
});

describe('collectAddresses', () => {
  it('pairs a video with its own cover and a slot object with its cover, and lists the rest', () => {
    const nodes = [
      n('v', 'video', { content: VID, coverUrl: COVER }),
      n('b', 'video', {
        content: IMG,
        slots: { sourceVideo: { url: SLOT_VID, cover: SLOT_COVER } },
        focusImages: { $y: 'array', items: [{ id: 'c', url: CROP }] },
        prompts: mentionPrompt(COVER),
      }),
      n('x', 'image', { content: 'https://example.com/cat.png' }),
    ];
    const out = collectAddresses(nodes);
    expect(out.pairs).toEqual(
      expect.arrayContaining([
        { url: VID, cover: COVER },
        { url: SLOT_VID, cover: SLOT_COVER },
      ]),
    );
    expect(out.pairs).toHaveLength(2);
    expect([...out.urls].sort()).toEqual([COVER, CROP, IMG].sort());
  });

  it('lists each address once', () => {
    const out = collectAddresses([n('a', 'image', { content: IMG }), n('b', 'image', { content: IMG })]);
    expect(out.urls).toEqual([IMG]);
  });
});

describe('replaceAddresses', () => {
  it('swaps every mapped string, attributes included, and drops a cover mapped to nothing', () => {
    const nodes = [
      n('v', 'video', { content: VID, coverUrl: COVER, prompts: mentionPrompt(COVER) }),
      n('b', 'video', { slots: { sourceVideo: { url: SLOT_VID, cover: SLOT_COVER } } }),
    ];
    const map = new Map<string, string | null>([
      [VID, 'https://b/v.mp4'],
      [COVER, null],
      [SLOT_VID, 'https://b/s.mp4'],
      [SLOT_COVER, 'https://b/s_cover.png'],
    ]);
    const [v, b] = replaceAddresses(nodes, map);
    expect(v?.data.content).toBe('https://b/v.mp4');
    expect(v?.data).not.toHaveProperty('coverUrl');
    expect(JSON.stringify(v?.data.prompts)).toContain('"thumbnail":null');
    expect(b?.data.slots).toEqual({ sourceVideo: { url: 'https://b/s.mp4', cover: 'https://b/s_cover.png' } });
  });

  it('leaves an address the map does not name as it is', () => {
    const [a] = replaceAddresses([n('a', 'image', { content: 'https://example.com/cat.png' })], new Map());
    expect(a?.data.content).toBe('https://example.com/cat.png');
  });
});

describe('historyItems', () => {
  it('describes media copies with their numbers and text copies with their words', () => {
    const items = historyItems([
      n('v', 'video', { content: VID, coverUrl: COVER, mediaWidth: 1920, mediaHeight: 1080, mimeType: 'video/mp4', size: 9, duration: 3 }),
      n('t', 'text', {
        body: {
          $y: 'xml',
          children: [
            { el: 'paragraph', attrs: {}, children: [{ text: [{ insert: 'hello ' }, { insert: 'world', attributes: { bold: true } }] }] },
            { el: 'paragraph', attrs: {}, children: [{ text: [{ insert: 'again' }] }] },
          ],
        },
      }),
      n('e', 'image', {}),
      n('g', 'group', {}),
    ]);
    expect(items).toEqual([
      { node_id: 'v', kind: 'media', content: VID, coverUrl: COVER, width: 1920, height: 1080, mimeType: 'video/mp4', size: 9, duration: 3 },
      { node_id: 't', kind: 'text', content: 'hello world\nagain' },
    ]);
  });

  it('gives an empty text body no history', () => {
    expect(historyItems([n('t', 'text', { body: { $y: 'xml', children: [{ el: 'paragraph', attrs: {}, children: [] }] } })])).toEqual([]);
  });
});
