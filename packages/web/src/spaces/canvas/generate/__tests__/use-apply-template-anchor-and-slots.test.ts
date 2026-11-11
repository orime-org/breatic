// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Applying a template from a panel when it has nodes that are not upstream of
 * the anchor and inputs that go straight into a slot (inner#1825 §4.1, §4.2).
 *
 * - A standalone node (no template edge at all) is found again by the
 *   `anchor` its canvas tag records, so a second apply does not place it twice.
 * - An input wired into a slot (`into`) that the board already holds material
 *   for lands in that slot through the proposal's `fills`, the path an
 *   accepted agent proposal takes, with no note asking for it.
 * - An input node the agent placed with `fills` (tagged, not wired) is found
 *   by its tag's `anchor`, so the panel does not add a second one.
 *
 * These run on a real canvas-space document; the end-to-end case places the
 * proposal through the real `placeProposalAt` and reads the slot back.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setLocale,
  setLocaleMessages,
  type CanvasProposal,
  type GenerationTemplate,
  type ModelEntry,
} from '@breatic/shared';
import en from '@locales/en.json';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { addEdge, addNode, readCanvasGraph } from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { useApplyTemplate, type PlaceTemplate } from '@web/spaces/canvas/generate/use-apply-template';
import { useNodeCreation, type ExistingNode } from '@web/spaces/canvas/use-node-creation';
import { useCurrentUserStore } from '@web/stores/current-user';

/** A sound-effects model that reads a clip from the canvas. */
const SCORE_MODEL = {
  name: 'model-score',
  mode: 'sfx',
  params: { video: { description: '', default: null, accepts: 'video', fill: 'canvas' } },
} as unknown as ModelEntry;

/** An audio anchor whose clip input goes straight into its video slot (§4.1). */
const INTO: GenerationTemplate = {
  id: 'fixture-into',
  anchor: 'score',
  nodes: [{ key: 'score', role: 'generate', type: 'audio', mode: 'sfx', model: 'model-score', params: {} }],
  edges: [],
  inputs: [{ key: 'video', type: 'video', into: 'video' }],
  steps: [],
  agentNote: 'a fixture scoring a clip',
  goal: 'character',
  triggers: { asks: ['a fixture'], offerWhen: [] },
};

/** An audio anchor with one standalone section node: no template edge touches it (§4.2). */
/** A cover's shape: the song goes into `audio`, the same param name a voice clone's sample travels as. */
const COVER: GenerationTemplate = {
  id: 'fixture-cover',
  anchor: 'cover',
  nodes: [{ key: 'cover', role: 'generate', type: 'audio', mode: 'a2m', model: 'model-score', params: {} }],
  edges: [],
  inputs: [{ key: 'song', type: 'audio', into: 'audio' }],
  steps: [],
  agentNote: 'a fixture covering a song',
  goal: 'character',
  triggers: { asks: ['a fixture'], offerWhen: [] },
};

const SECTIONS: GenerationTemplate = {
  id: 'fixture-sections',
  anchor: 'score',
  nodes: [
    { key: 'score', role: 'generate', type: 'audio', mode: 'sfx', model: 'model-score', params: {} },
    { key: 'intro', role: 'generate', type: 'audio', mode: 'sfx', model: 'model-score', params: {} },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote: 'a fixture with a standalone section',
  goal: 'character',
  triggers: { asks: ['a fixture'], offerWhen: [] },
};

/** English with the fixtures' strings added. */
const EN_WITH_FIXTURES = {
  ...en,
  canvas: {
    ...en.canvas,
    template: {
      ...en.canvas.template,
      'fixture-into': {
        name: 'Fixture into',
        description: 'Scores a clip',
        prompt: 'Footsteps on gravel, in time with the clip.',
        input: { video: { name: 'Clip', note: 'Put the clip in, then pick it into the video slot' } },
      },
      'fixture-cover': {
        name: 'Fixture cover',
        description: 'Covers a song',
        prompt: 'A slow folk cover.',
        input: { song: { name: 'Song', note: 'Put your song in, then pick it into the Song slot' } },
      },
      'fixture-sections': {
        name: 'Fixture sections',
        description: 'A score in sections',
        prompt: 'The main section.',
        node: { intro: { name: 'Intro', prompt: 'The opening section.' } },
      },
    },
  },
};

const CLIP = 'https://cdn/clip.mp4';
const POSTER = 'https://cdn/clip.jpg';
const NOTE = { slot: { kind: 'note', label: 'Put the clip in, then pick it into the video slot' } };

let stamp = 0;

/**
 * Seeds a node on the real canvas-space document.
 * @param id - Node id.
 * @param type - Node type.
 * @param extra - Further data fields, `templateNode` among them.
 */
function seed(id: string, type: 'audio' | 'video', extra: Record<string, unknown> = {}): void {
  addNode('p', 's', {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], ...extra },
  } as Parameters<typeof addNode>[2]);
}

/**
 * Wires `from` into `to`.
 * @param from - Source node id.
 * @param to - Target node id.
 */
function wire(from: string, to: string): void {
  stamp += 1;
  addEdge('p', 's', { id: `${from}->${to}`, source: from, target: to, createdAt: 10_000 + stamp });
}

/**
 * Applies a template from the panel of `nodeId`.
 * @param template - The template picked.
 * @param nodeId - The panel's node.
 * @param place - The placing callback.
 */
function apply(template: GenerationTemplate, nodeId: string, place: PlaceTemplate): void {
  const { result } = renderHook(() => useApplyTemplate('p', 's', nodeId, [SCORE_MODEL], place));
  result.current(template);
}

/**
 * The one call `placeTemplate` received.
 * @param place - The spy.
 * @returns Its proposal and existing map.
 */
function placed(place: ReturnType<typeof vi.fn>): { proposal: CanvasProposal; existing: ReadonlyMap<number, ExistingNode> } {
  expect(place).toHaveBeenCalledTimes(1);
  const [proposal, existing] = place.mock.calls[0] as [CanvasProposal, ReadonlyMap<number, ExistingNode>];
  return { proposal, existing };
}

/**
 * The index a canvas node is reused at.
 * @param existing - The reused nodes.
 * @param nodeId - The canvas node.
 * @returns Its index, or -1.
 */
function indexOf(existing: ReadonlyMap<number, ExistingNode>, nodeId: string): number {
  for (const [index, entry] of existing) if (entry.nodeId === nodeId) return index;
  return -1;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  getDoc(docName.canvasSpace('p', 's'));
  stamp = 0;
  setLocaleMessages('en', EN_WITH_FIXTURES as Record<string, unknown>);
  useCurrentUserStore.getState().setUser({
    id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    personalStudio: null,
    membershipTier: 'base',
  });
});
afterEach(() => {
  setLocaleMessages('en', en as Record<string, unknown>);
  setLocale('en');
});

describe('a standalone template node (inner#1825 §4.2)', () => {
  it('is placed on a first apply tagged with the anchor it belongs to', () => {
    seed('target', 'audio');
    const place = vi.fn();
    apply(SECTIONS, 'target', place);

    const { proposal, existing } = placed(place);
    const added = proposal.nodes.filter((_, i) => !existing.has(i));
    expect(added.find((node) => node.name === 'Intro')?.templateNode).toEqual({
      template: 'fixture-sections',
      key: 'intro',
      anchor: 0,
    });
  });

  it('is found again by the anchor its tag records, so a second apply does not place it twice', () => {
    seed('target', 'audio');
    seed('target-intro', 'audio', { name: 'Intro', templateNode: { template: 'fixture-sections', key: 'intro', anchor: 'target' } });
    const place = vi.fn();
    apply(SECTIONS, 'target', place);

    const { proposal, existing } = placed(place);
    expect(proposal.nodes.filter((_, i) => !existing.has(i)).map((node) => node.name)).toEqual([]);
    const intro = indexOf(existing, 'target-intro');
    expect(intro).toBeGreaterThan(0);
    expect(existing.get(intro)?.instance).toBe(true);
  });
});

describe('an input that goes straight into a slot (inner#1825 §4.1)', () => {
  it('writes the clip already wired in into the anchor’s slot through fills, with its material and no note', () => {
    seed('target', 'audio');
    seed('clip', 'video', { name: 'My clip', content: CLIP, coverUrl: POSTER, duration: 6 });
    wire('clip', 'target');
    const place = vi.fn();
    apply(INTO, 'target', place);

    const { proposal, existing } = placed(place);
    const at = indexOf(existing, 'clip');
    expect(at).toBeGreaterThan(0);
    expect(proposal.nodes.filter((_, i) => !existing.has(i))).toEqual([]);
    expect(proposal.nodes[0]?.fills).toEqual({ video: [at] });
    expect(proposal.nodes[at]).toMatchObject({
      material: CLIP,
      materialMedia: expect.objectContaining({ coverUrl: POSTER, duration: 6 }),
    });
    expect(proposal.nodes[0]?.prompt).not.toContainEqual(NOTE);
  });

  it('lands the clip in the anchor’s video slot when the real placing runs', () => {
    seed('target', 'audio');
    seed('clip', 'video', { name: 'My clip', content: CLIP, coverUrl: POSTER, duration: 6 });
    wire('clip', 'target');
    const { result: creation } = renderHook(() => useNodeCreation('p', 's'));
    apply(INTO, 'target', (proposal, existing, order) => creation.current.placeProposalAt(proposal, { x: 0, y: 0 }, [], existing, order));

    const anchor = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target');
    expect((anchor?.data as { soundVideo?: unknown } | undefined)?.soundVideo).toEqual({ url: CLIP, cover: POSTER, duration: 6 });
    // The clip was already wired in; nothing new is drawn or placed.
    expect(readCanvasGraph('p', 's').nodes.map((n) => n.id).sort()).toEqual(['clip', 'target']);
  });

  it('does not add a second input node to an instance the agent placed with fills and no edge', () => {
    seed('target', 'audio', { mode: 'sfx', model: 'model-score', soundVideo: { url: CLIP, cover: POSTER, duration: 6 } });
    seed('target-clip', 'video', {
      name: 'Clip',
      content: CLIP,
      coverUrl: POSTER,
      duration: 6,
      templateNode: { template: 'fixture-into', key: 'video', input: true, anchor: 'target' },
    });
    const place = vi.fn();
    apply(INTO, 'target', place);

    const { proposal, existing } = placed(place);
    expect(proposal.nodes.filter((node, i) => !existing.has(i) && node.templateNode?.input === true)).toEqual([]);
    const at = indexOf(existing, 'target-clip');
    expect(at).toBeGreaterThan(0);
    expect(proposal.nodes[0]?.fills).toEqual({ video: [at] });
    expect(proposal.nodes[0]?.prompt).not.toContainEqual(NOTE);
  });
  it('gives a second take the clip another take was placed with, filled into both slots, and places no input or note for it (design 8.6)', () => {
    const slotted = { mode: 'sfx', model: 'model-score', soundVideo: { url: CLIP, cover: POSTER, duration: 6 } };
    seed('target', 'audio', slotted);
    seed('take2', 'audio', slotted);
    seed('shared-clip', 'video', {
      name: 'Clip',
      content: CLIP,
      coverUrl: POSTER,
      duration: 6,
      templateNode: { template: 'fixture-into', key: 'video', input: true, anchor: 'target' },
    });
    const place = vi.fn();
    apply(INTO, 'take2', place);

    const { proposal, existing } = placed(place);
    expect(proposal.nodes.filter((_, i) => !existing.has(i))).toEqual([]);
    const at = indexOf(existing, 'shared-clip');
    expect(at).toBeGreaterThan(0);
    expect(proposal.nodes[0]?.fills).toEqual({ video: [at] });
    expect(proposal.nodes[0]?.prompt).not.toContainEqual(NOTE);
  });

  it('gives a second take the clip another take was placed with, wired into both, and places no input for it (design 8.6)', () => {
    seed('target', 'audio', { mode: 'sfx', model: 'model-score' });
    seed('take2', 'audio', { mode: 'sfx', model: 'model-score' });
    seed('shared-clip', 'video', {
      name: 'Clip',
      content: CLIP,
      coverUrl: POSTER,
      duration: 6,
      templateNode: { template: 'fixture-into', key: 'video', input: true, anchor: 'target' },
    });
    wire('shared-clip', 'target');
    wire('shared-clip', 'take2');
    const place = vi.fn();
    apply(INTO, 'take2', place);

    const { proposal, existing } = placed(place);
    expect(proposal.nodes.filter((_, i) => !existing.has(i))).toEqual([]);
    const at = indexOf(existing, 'shared-clip');
    expect(at).toBeGreaterThan(0);
    expect(proposal.nodes[0]?.fills).toEqual({ video: [at] });
  });

  it('reads the slot the template fills under the template node\'s own mode, so a voice sample does not pass for the song (round 2)', () => {
    const SAMPLE = 'https://cdn/sample.mp3';
    seed('target', 'audio', { mode: 'voice_clone', model: 'model-score', refAudio: { url: SAMPLE, cover: null } });
    seed('sample', 'audio', { name: 'My voice', content: SAMPLE, duration: 8 });
    const place = vi.fn();
    apply(COVER, 'target', place);

    const { proposal, existing } = placed(place);
    expect(indexOf(existing, 'sample')).toBe(-1);
    const added = proposal.nodes.filter((node, i) => !existing.has(i) && node.templateNode?.input === true);
    expect(added.map((node) => node.name)).toEqual(['Song']);
    expect(proposal.nodes[0]?.prompt).toContainEqual({ slot: { kind: 'note', label: 'Put your song in, then pick it into the Song slot' } });
  });
});
