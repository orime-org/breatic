// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fitting an open canvas into the limit by level of detail (inner#1413
 * design 6.7.3-6.7.5): every node goes whole, then slim, then with its texts
 * cut, then by name only, before any link or node is left out; at every step
 * the unselected nodes go first.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMessageSchema } from '@breatic/shared';
import type { ChatCanvasDetail } from '@breatic/shared';

import { fitCanvas, fitNodeOf } from '@web/pages/project/chat/canvas-fit';
import type { FitInput, FitNode } from '@web/pages/project/chat/canvas-fit';

const URL = 'https://assets.example.com/upload/2026-10-11/1791690000000_3e8b4deb.png';

/**
 * An image node shaped as a snapshot hands one over.
 * @param id - Its id.
 * @param createdAt - When it was made.
 * @param prompt - What it says.
 * @param extra - Other entry fields.
 * @returns The entry.
 */
function image(id: string, createdAt: number, prompt = 'a quiet street at night', extra: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return {
    id,
    type: 'image',
    position: { x: createdAt, y: 0 },
    data: {
      kind: 'image',
      name: `Shot ${id}`,
      createdAt,
      createdBy: '90000000-1111-2222-3333-444444444444',
      content: URL,
      prompts: { t2i: prompt },
      paramsByModel: { m1: { seed: 1, steps: 30 } },
    },
    current: { mode: 't2i', model: 'gemini-omni-1.1-flash', params: { aspect_ratio: '16:9' } },
    ...extra,
  };
}

/**
 * A group shaped as a snapshot hands one over.
 * @param id - Its id.
 * @param createdAt - When it was made.
 * @returns The entry.
 */
function group(id: string, createdAt: number): Record<string, unknown> & { id: string } {
  return { id, type: 'group', position: { x: 0, y: 0 }, data: { kind: 'group', name: `Group ${id}`, createdAt, createdBy: 'u1', backgroundColor: 'red', width: 400, height: 300 } };
}

/**
 * A canvas to fit.
 * @param entries - Its nodes.
 * @param selected - The ids the reader selected.
 * @param links - Its links as [source, target].
 * @returns The input.
 */
function canvasOf(
  entries: ReadonlyArray<Record<string, unknown> & { id: string }>,
  selected: readonly string[] = [],
  links: ReadonlyArray<readonly [string, string]> = [],
): FitInput {
  return {
    nodes: entries.map((e) => fitNodeOf(e, {}, selected.includes(e.id))),
    edges: links.map(([source, target]) => ({ id: `${source}-${target}`, source, target, createdAt: 1 })),
  };
}

/** A canvas text parsed back. */
interface Parsed {
  edges: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown> & { id: string; data?: Record<string, unknown> }>;
}

/**
 * The text parsed back.
 * @param text - What was sent.
 * @returns The canvas.
 */
const parsed = (text: string): Parsed => JSON.parse(text) as Parsed;

/**
 * The length of the canvas when the given nodes go at the given sizes.
 * @param input - The canvas.
 * @param size - Each node's size.
 * @returns The length.
 */
function lengthAt(input: FitInput, size: (n: FitNode) => 'whole' | 'slim' | 'named'): number {
  const at = new Map(input.nodes.map((n) => [n.id, size(n)]));
  const nodes = input.nodes.map((n) => (at.get(n.id) === 'whole' ? n.whole : at.get(n.id) === 'slim' ? n.slim : n.named));
  const edges = input.edges.map((e) =>
    at.get(e.source) === 'whole' && at.get(e.target) === 'whole' ? e : { source: e.source, target: e.target },
  );
  return JSON.stringify({ edges, nodes }).length;
}

/**
 * What each node went as.
 * @param text - What was sent.
 * @param input - The canvas.
 * @returns Each listed node's size by id.
 */
function sizes(text: string, input: FitInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of parsed(text).nodes) {
    const fit = input.nodes.find((n) => n.id === node.id);
    const same = (v: unknown): boolean => JSON.stringify(v) === JSON.stringify(node);
    out[node.id] = fit && same(fit.whole) ? 'whole' : fit && same(fit.named) && !('data' in node) ? 'named' : 'slim';
  }
  return out;
}

/**
 * The detail read off what was sent, as a check on what the fit says it did.
 * @param text - What was sent.
 * @param input - The canvas.
 * @returns The counts that can be read off the text.
 */
function readOff(text: string, input: FitInput): Partial<ChatCanvasDetail> {
  const got = parsed(text);
  const listed = new Set(got.nodes.map((n) => n.id));
  const size = sizes(text, input);
  const groups = new Set(input.nodes.filter((n) => n.group).map((n) => n.id));
  return {
    selected_whole: input.nodes.filter((n) => n.selected && size[n.id] === 'whole').length,
    slim: Object.entries(size).some(([id, s]) => s === 'slim' && !groups.has(id)),
    texts_cut: (text.match(/…\[\+\d+\]/g) ?? []).length,
    names_only: Object.entries(size).filter(([id, s]) => s === 'named' && !groups.has(id)).length,
    edges_not_listed: input.edges.length - got.edges.length,
    nodes_not_listed: input.nodes.filter((n) => !n.group && !listed.has(n.id)).length,
    groups_not_listed: input.nodes.filter((n) => n.group && !listed.has(n.id)).length,
  };
}

/**
 * Fit a canvas and check what the fit says it did against what it sent.
 * @param input - The canvas.
 * @param max - The limit.
 * @returns The fit.
 */
function fit(input: FitInput, max: number): ReturnType<typeof fitCanvas> {
  const out = fitCanvas(input, max, 0);
  expect(out.text.length).toBeLessThanOrEqual(max);
  expect(out.detail).toMatchObject(readOff(out.text, input));
  const d = out.detail;
  const listedWholeOrSlim = parsed(out.text).nodes.filter((n) => sizes(out.text, input)[n.id] !== 'named' || input.nodes.find((x) => x.id === n.id)?.group).length;
  expect(listedWholeOrSlim + d.names_only + d.nodes_not_listed + d.groups_not_listed).toBe(input.nodes.length);
  expect(
    chatMessageSchema.safeParse({
      message: 'hi',
      project_id: '11111111-1111-4111-8111-111111111111',
      conversation_id: '22222222-2222-4222-8222-222222222222',
      current_space: { id: 's', name: 'Cast', kind: 'canvas', state: 'loaded', content: out.text, total_chars: out.total, detail: d },
    }).success,
  ).toBe(true);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a canvas that fits', () => {
  it('goes whole, as Add to Agent hands it over, and says nothing was done', () => {
    const input = canvasOf([image('a', 1), image('b', 2)], ['b'], [['a', 'b']]);

    const out = fit(input, 100_000);

    expect(out.text).toBe(JSON.stringify({ edges: input.edges, nodes: input.nodes.map((n) => n.whole) }));
    expect(out.total).toBe(out.text.length);
    expect(out.detail).toEqual({
      selected_total: 1,
      selected_attached: 0,
      selected_whole: 1,
      slim: false,
      texts_cut: 0,
      names_only: 0,
      edges_not_listed: 0,
      nodes_not_listed: 0,
      groups_not_listed: 0,
    });
  });
});

describe('going slim', () => {
  it('slims the earliest nodes one by one and stops as soon as the canvas fits', () => {
    const input = canvasOf([image('c', 3), image('a', 1), image('b', 2)]);
    const max = lengthAt(input, (n) => (n.id === 'a' ? 'slim' : 'whole'));

    const out = fit(input, max);

    expect(sizes(out.text, input)).toEqual({ c: 'whole', a: 'slim', b: 'whole' });
  });

  it('orders nodes made at the same moment by id', () => {
    const input = canvasOf([image('b', 1), image('a', 1)]);
    const max = lengthAt(input, (n) => (n.id === 'a' ? 'slim' : 'whole'));

    expect(sizes(fit(input, max).text, input)).toEqual({ b: 'whole', a: 'slim' });
  });

  it('keeps the selected nodes whole while the others going slim is enough', () => {
    const input = canvasOf([image('a', 1), image('b', 2), image('c', 3)], ['a']);
    const max = lengthAt(input, (n) => (n.selected ? 'whole' : 'slim'));

    const out = fit(input, max);

    expect(sizes(out.text, input)).toEqual({ a: 'whole', b: 'slim', c: 'slim' });
    expect(out.detail.selected_whole).toBe(1);
  });

  it('slims only as many selected nodes as it must, earliest first', () => {
    const input = canvasOf([image('a', 1, 'x'.repeat(3_000)), image('b', 2), image('c', 3), image('d', 4)], ['b', 'c', 'd']);
    const max = lengthAt(input, (n) => (n.id === 'b' || !n.selected ? 'slim' : 'whole'));

    const out = fit(input, max);

    expect(sizes(out.text, input)).toEqual({ a: 'slim', b: 'slim', c: 'whole', d: 'whole' });
    expect(out.detail).toMatchObject({ selected_total: 3, selected_whole: 2, slim: true });
  });

  it('sends a link whole only while both its ends go whole', () => {
    const input = canvasOf([image('a', 1), image('b', 2), image('c', 3)], ['b', 'c'], [['a', 'b'], ['b', 'c']]);
    const max = lengthAt(input, (n) => (n.selected ? 'whole' : 'slim'));

    const got = parsed(fit(input, max).text);

    expect(got.edges).toEqual([{ source: 'a', target: 'b' }, input.edges[1]]);
  });
});

describe('cutting texts', () => {
  const long = 'a quiet street at night with rain '.repeat(40);

  it('cuts every unselected text to the same, longest length that fits, marking how much was left out', () => {
    const input = canvasOf([image('a', 1, long), image('b', 2, long), image('c', 3, long)], ['c']);
    const allSlim = lengthAt(input, () => 'slim');
    const max = allSlim - 2 * (long.length - 100);

    const out = fit(input, max);

    const got = parsed(out.text);
    const promptOf = (id: string): string => ((got.nodes.find((n) => n.id === id)?.data?.prompts as Record<string, string>).t2i);
    expect(promptOf('c')).toBe(long);
    const cut = promptOf('a');
    expect(cut).toBe(promptOf('b'));
    const kept = Number(/…\[\+(\d+)\]$/.exec(cut)?.[1]);
    expect(cut).toBe(`${long.slice(0, long.length - kept)}…[+${String(kept)}]`);
    // One more character would not fit.
    expect(out.text.replace(cut, `${long.slice(0, long.length - kept + 1)}…[+${String(kept - 1)}]`).length).toBeGreaterThan(max);
    expect(out.detail).toMatchObject({ texts_cut: 2, names_only: 0 });
  });

  it('cuts the selected texts only once the others are cut to nothing', () => {
    const input = canvasOf([image('a', 1, long), image('b', 2, long)], ['b']);
    const max = lengthAt(input, () => 'slim') - long.length - 200;

    const got = parsed(fit(input, max).text);

    const promptOf = (id: string): string => ((got.nodes.find((n) => n.id === id)?.data?.prompts as Record<string, string>).t2i);
    expect(promptOf('a')).toBe(`…[+${String(long.length)}]`);
    expect(promptOf('b')).toMatch(/^a quiet street .*…\[\+\d+\]$/);
  });

  it('leaves a text whole when cutting it would not make it shorter', () => {
    const input = canvasOf([image('a', 1, 'abcdef'), image('b', 2, long)]);
    const max = lengthAt(input, () => 'slim') - long.length + 10;

    const got = parsed(fit(input, max).text);

    expect((got.nodes[0]?.data?.prompts as Record<string, string>).t2i).toBe('abcdef');
  });

  it('does not split a character in two', () => {
    const input = canvasOf([image('a', 1, '😀'.repeat(2_000))]);
    const max = lengthAt(input, () => 'slim') - 3_000;

    const prompt = (parsed(fit(input, max).text).nodes[0]?.data?.prompts as Record<string, string>).t2i;

    expect(prompt).toMatch(/^(😀)*…\[\+\d+\]$/u);
  });
});

describe('names only, then leaving out', () => {
  it('names the earliest nodes only, the selected last, and never counts a group', () => {
    const input = canvasOf([group('g', 0), image('a', 1), image('b', 2), image('c', 3)], ['a']);
    const named = lengthAt(input, (n) => (n.id === 'b' || n.id === 'g' ? 'named' : n.id === 'c' ? 'named' : 'slim'));
    // Cut to nothing, then by name: c is still sent with its texts cut.
    const out = fit(input, named + 40);

    const size = sizes(out.text, input);
    expect(size.b).toBe('named');
    expect(size.a).toBe('slim');
    expect(out.detail.names_only).toBeGreaterThanOrEqual(1);
  });

  it('leaves out links among unselected nodes before a link that touches the selection', () => {
    const input = canvasOf([image('a', 1), image('b', 2), image('c', 3)], ['c'], [['a', 'b'], ['b', 'c']]);
    const allNamed = lengthAt(input, () => 'named');
    const out = fit(input, allNamed - 1);

    const got = parsed(out.text);
    expect(got.nodes).toHaveLength(3);
    expect(got.edges).toEqual([{ source: 'b', target: 'c' }]);
    expect(out.detail.edges_not_listed).toBe(1);
  });

  it('leaves out the earliest nodes, the selected last, and says how many groups went', () => {
    const input = canvasOf([group('g', 0), image('a', 1, 'p', { parentId: 'g' }), image('b', 2), image('c', 3)], ['a']);
    const keepOnly = (ids: readonly string[]): number =>
      JSON.stringify({ edges: [], nodes: input.nodes.filter((n) => ids.includes(n.id)).map((n) => n.named) }).length;

    const out = fit(input, keepOnly(['a', 'c']));

    const got = parsed(out.text);
    expect(got.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(got.nodes[0]?.parentId).toBe('g');
    expect(out.detail).toMatchObject({ nodes_not_listed: 1, groups_not_listed: 1, selected_whole: 0 });
  });

  it('keeps every node by name when names fit, however many were selected', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const input = canvasOf(ids.map((id, i) => image(id, i, 'a long prompt '.repeat(20))), ids);
    const max = lengthAt(input, () => 'named') + 10;

    const out = fit(input, max);

    expect(parsed(out.text).nodes).toHaveLength(200);
    expect(out.detail.nodes_not_listed).toBe(0);
  });
});

describe('the cost of fitting', () => {
  it('serializes the whole canvas a bounded number of times, however many nodes it has', () => {
    const ids = Array.from({ length: 6_000 }, (_, i) => `node-${String(i).padStart(5, '0')}`);
    const input = canvasOf(ids.map((id, i) => image(id, i)), ['node-00007']);
    const stringify = vi.spyOn(JSON, 'stringify');

    const out = fitCanvas(input, 100_000, 0);

    const whole = stringify.mock.calls.filter(([value]) => typeof value === 'object' && value !== null && 'nodes' in value && 'edges' in value);
    expect(out.detail.nodes_not_listed).toBeGreaterThan(0);
    expect(whole.length).toBeLessThanOrEqual(64);
  });
});
