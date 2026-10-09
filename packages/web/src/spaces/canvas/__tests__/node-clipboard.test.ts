// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  CLIPBOARD_MARKER,
  serializeClipboard,
  parseClipboard,
  cloneForPaste,
  captureClipboard,
  clipboardBoundingBox,
  externalParentAbs,
  pasteOffsetFor,
  stepPastOccupied,
  textToNode,
  type ClipboardNode,
  type ClipboardPayload,
} from '@web/spaces/canvas/node-clipboard';

/** Where the captured nodes are copied from. */
const SOURCE = { studioId: 'st-a', projectId: 'p-a', spaceId: 'space-a' };

/**
 * A payload holding the given nodes and edges.
 * @param nodes - The nodes.
 * @param extra - Edges, picked ids or source.
 * @returns The payload.
 */
function payload(nodes: ClipboardNode[], extra: Partial<ClipboardPayload> = {}): ClipboardPayload {
  return { version: 2, source: SOURCE, picked: nodes.map((n) => n.id), nodes, edges: [], ...extra };
}

/**
 * A content clipboard node.
 * @param id - Its id.
 * @param type - Its type.
 * @param position - Its absolute position.
 * @param data - Its data snapshot.
 * @param rest - Parent, size.
 * @returns The node.
 */
function node(
  id: string,
  type: ClipboardNode['type'],
  position: { x: number; y: number },
  data: Record<string, unknown> = {},
  rest: Partial<ClipboardNode> = {},
): ClipboardNode {
  return { id, type, position, data, ...rest };
}

/** A data reader for capture: every node's stored data, by id. */
const dataOf = (store: Record<string, Record<string, unknown>>) => (id: string): Record<string, unknown> =>
  store[id] ?? {};

describe('clipboard format (version 2)', () => {
  it('round-trips through the marker', () => {
    const p = payload([node('a', 'text', { x: 1, y: 2 }, { name: 'A' })]);
    const text = serializeClipboard(p);
    expect(text.startsWith(CLIPBOARD_MARKER)).toBe(true);
    expect(parseClipboard(text)).toEqual(p);
  });

  it('reads plain text, non-JSON, an unversioned array and an unknown version as not ours', () => {
    expect(parseClipboard('just some pasted text')).toBeNull();
    expect(parseClipboard(`${CLIPBOARD_MARKER}not json`)).toBeNull();
    expect(parseClipboard(`${CLIPBOARD_MARKER}[{"type":"text","position":{"x":0,"y":0}}]`)).toBeNull();
    expect(parseClipboard(`${CLIPBOARD_MARKER}{"version":3,"nodes":[],"edges":[]}`)).toBeNull();
  });
});

describe('captureClipboard', () => {
  it('captures a top-level node with its whole stored data and the source', () => {
    const data = { name: 'Hero', content: 'a.png', locked: true, taskCounts: { done: 2 }, prompts: { $y: 'map', entries: {} } };
    const out = captureClipboard(
      ['n'],
      [{ id: 'n', type: 'image', position: { x: 5, y: 6 } }],
      dataOf({ n: data }),
      [],
      SOURCE,
    );
    expect(out).toEqual({
      version: 2,
      source: SOURCE,
      picked: ['n'],
      nodes: [{ id: 'n', type: 'image', position: { x: 5, y: 6 }, data }],
      edges: [],
    });
  });

  it('records a content node size from its measured size', () => {
    const out = captureClipboard(
      ['n'],
      [{ id: 'n', type: 'image', position: { x: 5, y: 6 }, measured: { width: 300, height: 200 } }],
      dataOf({}),
      [],
      SOURCE,
    );
    expect(out.nodes[0]?.width).toBe(300);
    expect(out.nodes[0]?.height).toBe(200);
  });

  it('captures a lone group member at its absolute position, keeping parentId', () => {
    const out = captureClipboard(
      ['m'],
      [
        { id: 'g', type: 'group', position: { x: 100, y: 100 } },
        { id: 'm', type: 'text', parentId: 'g', position: { x: 20, y: 30 } },
      ],
      dataOf({}),
      [],
      SOURCE,
    );
    expect(out.nodes).toEqual([{ id: 'm', type: 'text', position: { x: 120, y: 130 }, parentId: 'g', data: {} }]);
  });

  it('captures a group, then each member once, with the group size from its data', () => {
    const out = captureClipboard(
      ['g', 'm1'],
      [
        { id: 'g', type: 'group', position: { x: 100, y: 100 } },
        { id: 'm1', type: 'text', parentId: 'g', position: { x: 20, y: 30 } },
        { id: 'm2', type: 'image', parentId: 'g', position: { x: 60, y: 40 } },
      ],
      dataOf({ g: { name: 'My Group', width: 300, height: 200 } }),
      [],
      SOURCE,
    );
    expect(out.nodes.map((n) => [n.id, n.position, n.parentId])).toEqual([
      ['g', { x: 100, y: 100 }, undefined],
      ['m1', { x: 120, y: 130 }, 'g'],
      ['m2', { x: 160, y: 140 }, 'g'],
    ]);
    expect(out.nodes[0]?.width).toBe(300);
    expect(out.nodes[0]?.height).toBe(200);
    expect(out.picked).toEqual(['g', 'm1']);
  });

  it('captures a sticky with its replies, for the Agent box', () => {
    const replies = { $y: 'array', items: [{ $y: 'map', entries: { id: 'r1' } }] };
    const out = captureClipboard(
      ['s'],
      [{ id: 's', type: 'annotation', position: { x: 0, y: 0 } }],
      dataOf({ s: { content: 'note', replies } }),
      [],
      SOURCE,
    );
    expect(out.nodes[0]).toMatchObject({ type: 'annotation', data: { replies } });
  });

  it('keeps edges between copied nodes and edges from an upstream node into a copied one', () => {
    const edges = [
      { id: 'a->b', source: 'a', target: 'b', createdAt: 1 },
      { id: 'u->b', source: 'u', target: 'b', createdAt: 2 },
      { id: 'b->x', source: 'b', target: 'x', createdAt: 3 },
    ];
    const out = captureClipboard(
      ['a', 'b'],
      [
        { id: 'a', type: 'image', position: { x: 0, y: 0 } },
        { id: 'b', type: 'image', position: { x: 0, y: 0 } },
      ],
      dataOf({}),
      edges,
      SOURCE,
    );
    expect(out.edges.map((e) => e.id)).toEqual(['a->b', 'u->b']);
  });
});

describe('externalParentAbs', () => {
  it('maps a member whose group is not in the payload to the existing group', () => {
    const p = payload([node('m', 'text', { x: 120, y: 130 }, {}, { parentId: 'g' })]);
    expect(
      externalParentAbs(p.nodes, [
        { id: 'g', type: 'group', position: { x: 100, y: 100 } },
        { id: 'm', type: 'text', parentId: 'g', position: { x: 20, y: 30 } },
      ]),
    ).toEqual(new Map([['g', { x: 100, y: 100 }]]));
  });

  it('leaves out a locked existing group, so the lone-member clone stays top-level', () => {
    const p = payload([node('m', 'text', { x: 120, y: 130 }, {}, { parentId: 'g' })]);
    expect(
      externalParentAbs(p.nodes, [
        { id: 'g', type: 'group', position: { x: 100, y: 100 }, data: { locked: true } },
      ]),
    ).toEqual(new Map());
  });

  it('is empty when the member group is in the payload', () => {
    const p = payload([
      node('g', 'group', { x: 100, y: 100 }),
      node('m', 'text', { x: 120, y: 130 }, {}, { parentId: 'g' }),
    ]);
    expect(externalParentAbs(p.nodes, [])).toEqual(new Map());
  });
});

describe('cloneForPaste', () => {
  it('mints fresh ids, shifts positions and carries every content field', () => {
    const p = payload([
      node('a', 'image', { x: 10, y: 20 }, { name: 'Hero', content: 'a.png', mode: 'i2i', params: { q: 1 } }),
      node('b', 'text', { x: 30, y: 40 }, { name: 'Note' }),
    ]);
    const { nodes } = cloneForPaste(p, 'u-7', { dx: 24, dy: 24 });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.id).not.toBe('a');
    expect(nodes[0]?.id).not.toBe(nodes[1]?.id);
    expect(nodes[0]?.position).toEqual({ x: 34, y: 44 });
    expect(nodes[1]?.position).toEqual({ x: 54, y: 64 });
    expect(nodes[0]?.data).toMatchObject({ name: 'COPY-Hero', content: 'a.png', mode: 'i2i', params: { q: 1 }, createdBy: 'u-7' });
    expect(typeof nodes[0]?.data.createdAt).toBe('number');
  });

  it('copies content only: no lock, task counts or failure message (R2-F)', () => {
    const p = payload([
      node('g', 'group', { x: 0, y: 0 }, { locked: true, width: 100, height: 100 }),
      node('m', 'image', { x: 10, y: 10 }, { locked: true, taskCounts: { done: 1 }, errorMessage: 'boom' }, { parentId: 'g' }),
    ]);
    for (const clone of cloneForPaste(p, 'u-1', { dx: 0, dy: 0 }).nodes) {
      expect(clone.data.locked).toBe(false);
      expect(clone.data).not.toHaveProperty('taskCounts');
      expect(clone.data).not.toHaveProperty('errorMessage');
    }
  });

  it('skips stickies on the canvas', () => {
    const p = payload([node('s', 'annotation', { x: 0, y: 0 }), node('a', 'image', { x: 0, y: 0 })]);
    expect(cloneForPaste(p, 'u', { dx: 0, dy: 0 }).nodes.map((n) => n.type)).toEqual(['image']);
  });

  it('rehomes members to the fresh group and keeps their relative layout', () => {
    const p = payload([
      node('g', 'group', { x: 100, y: 100 }, { name: 'My Group', width: 300, height: 200 }),
      node('m1', 'text', { x: 120, y: 130 }, { name: 'Note' }, { parentId: 'g' }),
    ]);
    const [group, member] = cloneForPaste(p, 'u-1', { dx: 24, dy: 24 }).nodes;
    expect(group?.position).toEqual({ x: 124, y: 124 });
    expect(group?.data.width).toBe(300);
    expect(group?.data.name).toBe('COPY-My Group');
    expect(member?.parentId).toBe(group?.id);
    expect(member?.position).toEqual({ x: 20, y: 30 });
    expect(member?.data.name).toBe('Note');
  });

  it('rejoins a lone member to its existing group, prefixed as a root', () => {
    const p = payload([node('m', 'text', { x: 120, y: 130 }, { name: 'Note' }, { parentId: 'g' })]);
    const [clone] = cloneForPaste(p, 'u-1', { dx: 24, dy: 24 }, { externalParentAbs: new Map([['g', { x: 100, y: 100 }]]) }).nodes;
    expect(clone?.parentId).toBe('g');
    expect(clone?.position).toEqual({ x: 44, y: 54 });
    expect(clone?.data.name).toBe('COPY-Note');
  });

  it('makes a lone member top-level when its group is not given', () => {
    const p = payload([node('m', 'text', { x: 120, y: 130 }, {}, { parentId: 'g' })]);
    const [clone] = cloneForPaste(p, 'u-1', { dx: 24, dy: 24 }).nodes;
    expect(clone?.parentId).toBeUndefined();
    expect(clone?.position).toEqual({ x: 144, y: 154 });
  });

  it('pastes an external picture as an empty node with its name, no COPY- prefix', () => {
    const p = payload([node('x', 'image', { x: 0, y: 0 }, { name: 'found', content: 'https://elsewhere/a.png' }, { external: true })], { source: undefined });
    const [clone] = cloneForPaste(p, 'u', { dx: 0, dy: 0 }).nodes;
    expect(clone?.data.name).toBe('found');
    expect(clone?.data).not.toHaveProperty('content');
  });
});

describe('cloneForPaste — edges (design 5.5)', () => {
  const nodes = [node('a', 'image', { x: 0, y: 0 }), node('b', 'image', { x: 0, y: 0 })];
  const edges = [
    { id: 'a->b', source: 'a', target: 'b', createdAt: 5 },
    { id: 'u->b', source: 'u', target: 'b', createdAt: 5 },
  ];

  it('rebuilds edges between copies and keeps an upstream edge when the upstream node is there', () => {
    const out = cloneForPaste(payload(nodes, { edges }), 'u', { dx: 0, dy: 0 }, { keepUpstream: (id) => id === 'u' });
    const a = out.idMap.get('a') as string;
    const b = out.idMap.get('b') as string;
    expect(out.edges.map((e) => [e.source, e.target, e.id])).toEqual([
      [a, b, `${a}->${b}`],
      ['u', b, `u->${b}`],
    ]);
  });

  it('drops the upstream edge elsewhere', () => {
    const out = cloneForPaste(payload(nodes, { edges }), 'u', { dx: 0, dy: 0 });
    expect(out.edges).toHaveLength(1);
  });

  it('writes strictly increasing createdAt in the original order, so the rail keeps its order', () => {
    const out = cloneForPaste(payload(nodes, { edges }), 'u', { dx: 0, dy: 0 }, { keepUpstream: () => true });
    const [first, second] = out.edges;
    expect(first?.source).toBe(out.idMap.get('a'));
    expect((second?.createdAt ?? 0) > (first?.createdAt ?? 0)).toBe(true);
  });
});

describe('cloneForPaste — mentions in prompts (design 5.6)', () => {
  /**
   * A prompt holding one mention of the given source.
   * @param sourceNodeId - What the mention points at.
   * @returns The prompts tag.
   */
  const prompts = (sourceNodeId: string): Record<string, unknown> => ({
    $y: 'map',
    entries: {
      t2i: {
        $y: 'xml',
        children: [{ el: 'paragraph', attrs: {}, children: [{ el: 'referenceMention', attrs: { sourceNodeId, label: 'Up' }, children: [] }] }],
      },
    },
  });
  /**
   * The first paragraph of a clone's prompt.
   * @param data - The clone's data.
   * @returns The paragraph's children.
   */
  const firstParagraph = (data: Record<string, unknown>): unknown[] =>
    ((data.prompts as { entries: Record<string, { children: Array<{ children: unknown[] }> }> }).entries.t2i?.children[0]?.children) ?? [];

  it('points a mention of a copied node at its copy', () => {
    const p = payload([node('up', 'image', { x: 0, y: 0 }), node('b', 'image', { x: 0, y: 0 }, { prompts: prompts('up') })]);
    const out = cloneForPaste(p, 'u', { dx: 0, dy: 0 });
    const clone = out.nodes.find((n) => n.id === out.idMap.get('b'));
    expect(firstParagraph(clone?.data ?? {})).toEqual([
      { el: 'referenceMention', attrs: { sourceNodeId: out.idMap.get('up'), label: 'Up' }, children: [] },
    ]);
  });

  it('keeps a focus mention and a kept upstream mention', () => {
    const p = payload([node('b', 'image', { x: 0, y: 0 }, { prompts: prompts('focus:c1') })]);
    const kept = cloneForPaste(p, 'u', { dx: 0, dy: 0 });
    expect(JSON.stringify(kept.nodes[0]?.data)).toContain('focus:c1');
    const up = payload([node('b', 'image', { x: 0, y: 0 }, { prompts: prompts('u') })], {
      edges: [{ id: 'u->b', source: 'u', target: 'b', createdAt: 1 }],
    });
    expect(JSON.stringify(cloneForPaste(up, 'u', { dx: 0, dy: 0 }, { keepUpstream: () => true }).nodes[0]?.data)).toContain('"sourceNodeId":"u"');
  });

  it('turns a dangling mention into plain "@name" text', () => {
    const p = payload([node('b', 'image', { x: 0, y: 0 }, { prompts: prompts('gone') })]);
    const out = cloneForPaste(p, 'u', { dx: 0, dy: 0 });
    expect(firstParagraph(out.nodes[0]?.data ?? {})).toEqual([{ text: [{ insert: '@Up' }] }]);
  });
});

describe('textToNode', () => {
  it('builds a text node carrying the pasted text', () => {
    const n = textToNode('pasted words', { x: 5, y: 6 }, 'u-9');
    expect(n.type).toBe('text');
    expect(n.data.content).toBe('pasted words');
    expect(n.data.name).toBe('Text');
  });
});

describe('pasteOffsetFor — viewport-aware placement (R2-H)', () => {
  const viewport = { x: 0, y: 0, width: 1000, height: 800 };
  /**
   * A payload of one node copied on Space "here", covering `box`.
   * @param box - Its top-left and optional size.
   * @param box.x - Left.
   * @param box.y - Top.
   * @param box.width - Width.
   * @param box.height - Height.
   * @returns The payload.
   */
  const copied = (box: { x: number; y: number; width?: number; height?: number }): ClipboardPayload =>
    payload([node('a', 'image', { x: box.x, y: box.y }, {}, { width: box.width ?? 0, height: box.height ?? 0 })], {
      source: { ...SOURCE, spaceId: 'here' },
    });

  it('pastes beside a source in view', () => {
    expect(pasteOffsetFor(copied({ x: 500, y: 400 }), viewport, 'here')).toEqual({ dx: 24, dy: 24 });
  });

  it('recenters a source fully off-screen', () => {
    expect(pasteOffsetFor(copied({ x: 1200, y: 400 }), viewport, 'here')).toEqual({ dx: 500 - 1200, dy: 0 });
  });

  it('pastes beside a source still partly in view', () => {
    expect(pasteOffsetFor(copied({ x: 900, y: 400, width: 200, height: 100 }), viewport, 'here')).toEqual({ dx: 24, dy: 24 });
  });

  it('centres the bounding box, not its top-left', () => {
    expect(pasteOffsetFor(copied({ x: 5000, y: 5000, width: 300, height: 200 }), viewport, 'here')).toEqual({
      dx: 500 - 5150,
      dy: 400 - 5100,
    });
  });

  it('falls back to the nudge on a zero-area viewport', () => {
    expect(pasteOffsetFor(copied({ x: 999, y: 999 }), { x: 0, y: 0, width: 0, height: 0 }, 'here')).toEqual({ dx: 24, dy: 24 });
  });

  it('recenters with a non-origin viewport', () => {
    expect(pasteOffsetFor(copied({ x: 0, y: 0 }), { x: 2000, y: 1000, width: 1000, height: 800 }, 'here')).toEqual({ dx: 2500, dy: 1400 });
  });

  it('centres a payload copied on another Space, or with no source', () => {
    const there = payload([node('a', 'image', { x: 500, y: 0 }, {}, { width: 100, height: 100 })], { source: { ...SOURCE, spaceId: 'there' } });
    expect(pasteOffsetFor(there, viewport, 'here')).toEqual({ dx: -50, dy: 350 });
    expect(pasteOffsetFor({ ...there, source: undefined }, viewport, 'here')).toEqual({ dx: -50, dy: 350 });
  });
});

describe('clipboardBoundingBox', () => {
  it('unions position and size across all nodes', () => {
    expect(
      clipboardBoundingBox([
        node('a', 'image', { x: 0, y: 0 }, {}, { width: 100, height: 50 }),
        node('b', 'text', { x: 200, y: 100 }, {}, { width: 80, height: 40 }),
      ]),
    ).toEqual({ x: 0, y: 0, width: 280, height: 140 });
  });

  it('falls back to the empty-node footprint for a node with no size', () => {
    expect(clipboardBoundingBox([node('a', 'text', { x: 10, y: 20 })])).toEqual({ x: 10, y: 20, width: 288, height: 192 });
  });
});

describe('stepPastOccupied (inner#1235 A20)', () => {
  it('stays put on a free spot', () => {
    expect(stepPastOccupied([{ x: 0, y: 0 }], [{ x: 100, y: 100 }])).toEqual({ dx: 0, dy: 0 });
  });

  it('steps down and right until the spot is free', () => {
    expect(stepPastOccupied([{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 24, y: 24 }, { x: 60, y: 0 }])).toEqual({ dx: 48, dy: 48 });
  });

  it('counts a node less than a step away as on the spot', () => {
    expect(stepPastOccupied([{ x: 0, y: 0 }], [{ x: 10, y: -10 }])).toEqual({ dx: 24, dy: 24 });
  });

  it('steps the whole batch when any one node would land on a taken spot', () => {
    expect(stepPastOccupied([{ x: 0, y: 0 }, { x: 400, y: 300 }], [{ x: 400, y: 300 }])).toEqual({ dx: 24, dy: 24 });
  });
});
