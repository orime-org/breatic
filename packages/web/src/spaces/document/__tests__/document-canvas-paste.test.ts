// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a canvas clipboard becomes in the body (inner#1351 + inner#1390 design
 * §4.3, §5.2, §5.3): the order, the kind of each item, its name and caption,
 * where its bytes come from, and how many could not be pasted.
 */

import { describe, it, expect } from 'vitest';

import type { ClipboardNode, ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { planCanvasPaste, routeAddress } from '@web/spaces/document/document-canvas-paste';

const OURS = 'https://cdn.example/2026-10-14/a.png';

/**
 * A text body snapshot holding these lines.
 * @param lines - One paragraph per line.
 * @returns The snapshot.
 */
function body(...lines: string[]): unknown {
  return {
    $y: 'xml',
    children: lines.map((line) => ({ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: line }] }] })),
  };
}

/**
 * A clipboard node.
 * @param id - Its id.
 * @param type - Its type.
 * @param x - Its left.
 * @param y - Its top.
 * @param data - Its data.
 * @param extra - Other fields.
 * @returns The node.
 */
function node(
  id: string,
  type: ClipboardNode['type'],
  x: number,
  y: number,
  data: Record<string, unknown> = {},
  extra: Partial<ClipboardNode> = {},
): ClipboardNode {
  return { id, type, position: { x, y }, data, ...extra };
}

/**
 * A payload holding these nodes, in this clipboard order.
 * @param nodes - The nodes.
 * @returns The payload.
 */
function payload(...nodes: ClipboardNode[]): ClipboardPayload {
  return { version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] } as ClipboardPayload;
}

/**
 * The plan's items, each reduced to a short label for order checks.
 * @param p - The payload.
 * @returns Labels in order.
 */
function order(p: ClipboardPayload): string[] {
  return planCanvasPaste(p).items.map((item) => (item.kind === 'text' ? item.lines.join('/') : item.name));
}

describe('what each node becomes', () => {
  it('our image, video and audio become media blocks named and captioned by the node, sized as it is, sourced by registration', () => {
    const plan = planCanvasPaste(
      payload(
        node('i', 'image', 0, 0, { name: 'Hero', content: OURS, mediaWidth: 640, mediaHeight: 480 }, { height: 100 }),
        node('v', 'video', 0, 200, { name: 'Teaser', content: 'https://cdn.example/v.mp4', coverUrl: 'https://cdn.example/v.jpg' }, { height: 100 }),
        node('a', 'audio', 0, 400, { name: 'Voice', content: 'https://cdn.example/a.mp3' }, { height: 100 }),
      ),
    );
    expect(plan.items).toEqual([
      {
        kind: 'media',
        type: 'image',
        name: 'Hero',
        caption: 'Hero',
        mediaWidth: 640,
        mediaHeight: 480,
        source: { kind: 'ours', url: OURS },
      },
      {
        kind: 'media',
        type: 'video',
        name: 'Teaser',
        caption: 'Teaser',
        source: { kind: 'ours', url: 'https://cdn.example/v.mp4', coverUrl: 'https://cdn.example/v.jpg' },
      },
      { kind: 'media', type: 'audio', name: 'Voice', caption: 'Voice', source: { kind: 'ours', url: 'https://cdn.example/a.mp3' } },
    ]);
    expect(plan.notPasted).toBe(0);
  });

  it('an external picture from the Agent is fetched from its address', () => {
    const plan = planCanvasPaste(
      payload(node('x', 'image', 0, 0, { name: 'Found', content: 'https://imgs.example/x.jpg' }, { external: true })),
    );
    expect(plan.items).toEqual([
      { kind: 'media', type: 'image', name: 'Found', caption: 'Found', source: { kind: 'address', url: 'https://imgs.example/x.jpg' } },
    ]);
  });

  it('a text node becomes its lines, character for character, with nothing read as markdown', () => {
    const plan = planCanvasPaste(payload(node('t', 'text', 0, 0, { body: body('_x_ and *y*', '# not a heading', '') })));
    expect(plan.items).toEqual([{ kind: 'text', lines: ['_x_ and *y*', '# not a heading', ''] }]);
  });

  it('a node with no content yet counts as not pasted, and so does an empty text node', () => {
    const plan = planCanvasPaste(
      payload(
        node('i', 'image', 0, 0, { name: 'Pending' }),
        node('t', 'text', 0, 300, { body: body() }),
        node('ok', 'image', 0, 600, { name: 'Ok', content: OURS }),
      ),
    );
    expect(plan.items.map((i) => (i.kind === 'media' ? i.name : 'text'))).toEqual(['Ok']);
    expect(plan.notPasted).toBe(2);
  });

  it('an external address that cannot be fetched counts as not pasted', () => {
    const plan = planCanvasPaste(
      payload(node('x', 'image', 0, 0, { name: 'Plain', content: 'http://imgs.example/x.jpg' }, { external: true })),
    );
    expect(plan.items).toEqual([]);
    expect(plan.notPasted).toBe(1);
  });

  it('groups and stickies are not content: their members land, they neither land nor count', () => {
    const plan = planCanvasPaste(
      payload(
        node('g', 'group', 0, 0, { name: 'Group' }, { width: 600, height: 400 }),
        node('m', 'image', 10, 10, { name: 'Member', content: OURS }, { parentId: 'g' }),
        node('s', 'annotation', 0, 500, { text: 'note' }),
      ),
    );
    expect(plan.items.map((i) => (i.kind === 'media' ? i.name : 'text'))).toEqual(['Member']);
    expect(plan.notPasted).toBe(0);
  });
});

describe('reading order', () => {
  it('reads row by row, left to right, whatever the clipboard order', () => {
    const p = payload(
      node('c', 'text', 0, 300, { body: body('C') }, { height: 100 }),
      node('b', 'text', 400, 0, { body: body('B') }, { height: 100 }),
      node('a', 'text', 0, 0, { body: body('A') }, { height: 100 }),
    );
    expect(order(p)).toEqual(['A', 'B', 'C']);
  });

  it('a row is everything whose top falls within the first node\'s height, so staggered columns do not chain into one row', () => {
    const p = payload(
      node('a', 'text', 0, 0, { body: body('A') }, { height: 100 }),
      node('b', 'text', 400, 90, { body: body('B') }, { height: 100 }),
      node('c', 'text', 0, 150, { body: body('C') }, { height: 100 }),
      node('d', 'text', 400, 180, { body: body('D') }, { height: 100 }),
    );
    expect(order(p)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a node never measured counts as the new-node height', () => {
    const p = payload(
      node('a', 'text', 0, 0, { body: body('A') }),
      node('b', 'text', 400, 150, { body: body('B') }),
      node('c', 'text', 0, 193, { body: body('C') }),
    );
    expect(order(p)).toEqual(['A', 'B', 'C']);
  });

  it('two nodes with the same left keep their clipboard order', () => {
    const p = payload(
      node('b', 'text', 0, 10, { body: body('B') }, { height: 100 }),
      node('a', 'text', 0, 0, { body: body('A') }, { height: 100 }),
    );
    expect(order(p)).toEqual(['B', 'A']);
  });
});

describe('where an outside address goes', () => {
  it.each([
    ['https://imgs.example/x.jpg', 'fetch'],
    ['data:image/png;base64,AAAA', 'file'],
    ['blob:https://app.example/123', 'file'],
    ['http://imgs.example/x.jpg', 'skip'],
    ['ftp://imgs.example/x.jpg', 'skip'],
    ['not a url', 'skip'],
  ] as const)('%s → %s', (url, route) => {
    expect(routeAddress(url)).toBe(route);
  });
});
