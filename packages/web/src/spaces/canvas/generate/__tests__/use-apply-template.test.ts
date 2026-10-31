// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Applying a picked template from a generate panel (inner#977, inner#1345).
 *
 * The panel reads the board fresh from Yjs, matches what the template already
 * has around the panel's node, and hands one proposal plus the canvas nodes it
 * reuses to `placeTemplate`, the same placing the agent's proposals go
 * through. These cases run on a real canvas-space document and capture what
 * reaches `placeTemplate`; where it lands is `placeProposalAt`'s own business.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_TEMPLATES,
  setLocale,
  setLocaleMessages,
  t,
  templateGuideNode,
  type CanvasProposal,
  type GenerationTemplate,
  type ModelEntry,
  type ProposalNode,
} from '@breatic/shared';
import en from '@locales/en.json';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { addEdge, addNode, createGroup, readCanvasGraph, setNodeLocked } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import { toast } from '@web/lib/toast';
import { createGroupNode } from '@web/spaces/canvas/node-factory';
import { useApplyTemplate } from '@web/spaces/canvas/generate/use-apply-template';

/** What the panel hands `placeTemplate` for one canvas node it reuses. */
interface Existing {
  nodeId: string;
  mention?: unknown;
  paramsByModel?: Record<string, Record<string, unknown>>;
}

/** The callback `CanvasSpace` passes the panels (6.5). */
type PlaceTemplate = (proposal: CanvasProposal, existing: ReadonlyMap<number, Existing>) => unknown;

const ULTRA = {
  name: 'nano-banana-pro-edit-ultra',
  mode: 'i2i',
  params: {
    aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '16:9' },
    resolution: { description: '', values: ['1k', '4k'], default: '1k' },
  },
} as unknown as ModelEntry;

/** The fixture's anchor model. */
const FINAL_MODEL = {
  name: 'model-final',
  mode: 'i2i',
  params: { aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '16:9' } },
} as unknown as ModelEntry;

/** The fixture's upstream model. */
const SHEET_MODEL = {
  name: 'model-sheet',
  mode: 'i2i',
  params: { aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '16:9' } },
} as unknown as ModelEntry;

/**
 * The multi-node fixture of 6.9: an upstream generation feeding the anchor
 * through a slot, a hosted resource wired only into the upstream node, an
 * input fed only to the upstream node, two same-type inputs on the anchor, one
 * input feeding both, and two follow-up steps.
 */
const FLOW: GenerationTemplate = {
  id: 'fixture-flow',
  anchor: 'final',
  nodes: [
    { key: 'final', role: 'generate', type: 'image', mode: 'i2i', model: 'model-final', params: { aspect_ratio: '1:1' } },
    { key: 'sheet', role: 'generate', type: 'image', mode: 'i2i', model: 'model-sheet', params: {} },
    { key: 'style', role: 'source', type: 'image', resource: 'templates/fixture-flow/style.png' },
  ],
  edges: [
    { from: 'style', to: 'sheet' },
    { from: 'sheet', to: 'final', into: 'styleImageUrls' },
  ],
  inputs: [
    { key: 'pose', type: 'image', feeds: ['sheet'] },
    { key: 'front', type: 'image' },
    { key: 'back', type: 'image' },
    { key: 'character', type: 'image', feeds: ['sheet', 'final'] },
  ],
  steps: ['split', 'animate'],
  agentNote: 'a fixture flow for tests',
  goal: 'character',
  triggers: { asks: ['a fixture'], offerWhen: ['a fixture is wanted'] },
};

/** The fixture's English strings; no locale file carries them. */
const FLOW_STRINGS = {
  name: 'Fixture flow',
  description: 'A flow for tests',
  prompt: '(💡 Generate Sheet first) The final of [📎 Front view] and [📎 Back view], dressed like [📎 Character].',
  node: {
    sheet: { name: 'Sheet', prompt: 'A sheet of [📎 Character] in [📎 Pose], styled like [📎 Style].' },
    style: { name: 'Style' },
  },
  input: {
    pose: { name: 'Pose', note: 'Put a pose picture in first' },
    front: { name: 'Front view', note: 'Put the front view in first' },
    back: { name: 'Back view', note: 'Put the back view in first' },
    character: { name: 'Character', note: 'Put the character in first' },
  },
  step: {
    split: 'Right-click the result, then Tools, then Grid split',
    animate: 'Turn the panels into a video',
  },
};

/** English with the fixture's strings added. */
const EN_WITH_FIXTURE = {
  ...en,
  canvas: { ...en.canvas, template: { ...en.canvas.template, 'fixture-flow': FLOW_STRINGS } },
};

const BOTH_FLOW_MODELS = [FINAL_MODEL, SHEET_MODEL];

/**
 * The migrated storyboard template, read from the registry.
 * @returns The template.
 */
function grid(): GenerationTemplate {
  const template = GENERATION_TEMPLATES.find((template) => template.id === 'storyboard-grid-25');
  if (!template) throw new Error('grid template missing');
  return template;
}

let stamp = 0;

/**
 * Seeds a node on the real canvas-space document.
 * @param id - Node id.
 * @param type - Node type.
 * @param extra - Further data fields, `templateNode` among them.
 */
function seed(id: string, type: 'image' | 'text', extra: Record<string, unknown> = {}): void {
  addNode('p', 's', {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], ...extra },
  } as Parameters<typeof addNode>[2]);
}

/**
 * Wires `from` into `to`, stamped later than every edge before it so the
 * reference rail reads them in the order the case wires them.
 * @param from - Source node id.
 * @param to - Target node id.
 * @param createdAt - An explicit stamp, to write edges out of rail order.
 */
function wire(from: string, to: string, createdAt?: number): void {
  stamp += 1;
  addEdge('p', 's', { id: `${from}->${to}`, source: from, target: to, createdAt: createdAt ?? 10_000 + stamp });
}

/**
 * The fixture instance as a landing leaves it on the canvas around `anchor`:
 * tagged template nodes, filled inputs, and (optionally) the guide.
 * @param anchor - The anchor's id; every other id is prefixed with it.
 * @param options - What to leave out or change.
 * @param options.guide - Whether the guide text node is there.
 * @param options.models - Models the reader switched the anchor and upstream to.
 */
function seedFlowInstance(anchor: string, options: { guide?: boolean; models?: boolean } = {}): void {
  const { guide = true, models = false } = options;
  seed(anchor, 'image', models ? { mode: 'i2i', model: 'someone-else' } : {});
  seed(`${anchor}-sheet`, 'image', {
    name: 'Sheet',
    templateNode: { template: 'fixture-flow', key: 'sheet' },
    ...(models ? { mode: 'i2i', model: 'someone-else' } : {}),
  });
  seed(`${anchor}-style`, 'image', {
    name: 'Style',
    content: 'https://cdn/style.png',
    templateNode: { template: 'fixture-flow', key: 'style' },
  });
  for (const input of ['pose', 'front', 'back', 'character']) {
    seed(`${anchor}-${input}`, 'image', { name: `${input} picture`, content: `https://cdn/${anchor}-${input}.png` });
  }
  if (guide) {
    seed(`${anchor}-guide`, 'text', {
      name: 'Fixture flow',
      templateNode: { template: 'fixture-flow', key: 'guide', anchor },
    });
  }
  wire(`${anchor}-style`, `${anchor}-sheet`);
  wire(`${anchor}-pose`, `${anchor}-sheet`);
  wire(`${anchor}-character`, `${anchor}-sheet`);
  wire(`${anchor}-sheet`, anchor);
  wire(`${anchor}-front`, anchor);
  wire(`${anchor}-back`, anchor);
  wire(`${anchor}-character`, anchor);
}

/**
 * Applies a template from the panel of `nodeId`.
 * @param template - The template picked.
 * @param nodeId - The panel's node.
 * @param models - The full catalog this deployment serves.
 * @param place - The placing callback.
 */
function apply(
  template: GenerationTemplate,
  nodeId: string,
  models: readonly ModelEntry[],
  place: PlaceTemplate,
): void {
  const { result } = renderHook(() => useApplyTemplate('p', 's', nodeId, models, place));
  result.current(template);
}

/**
 * The one call `placeTemplate` received.
 * @param place - The spy.
 * @returns Its proposal and existing map.
 */
function placed(place: ReturnType<typeof vi.fn>): { proposal: CanvasProposal; existing: ReadonlyMap<number, Existing> } {
  expect(place).toHaveBeenCalledTimes(1);
  const [proposal, existing] = place.mock.calls[0] as [CanvasProposal, ReadonlyMap<number, Existing>];
  return { proposal, existing };
}

/**
 * Who an index stands for: the canvas node it reuses, else `new:<name>`.
 * @param proposal - The proposal.
 * @param existing - The reused nodes.
 * @param index - The index.
 * @returns The identity.
 */
function who(proposal: CanvasProposal, existing: ReadonlyMap<number, Existing>, index: number): string {
  const at = existing.get(index);
  if (at) return at.nodeId;
  return `new:${proposal.nodes[index]?.name ?? '?'}`;
}

/**
 * The proposal's edges, by identity.
 * @param proposal - The proposal.
 * @param existing - The reused nodes.
 * @returns `from->to` per edge, sorted.
 */
function edgesOf(proposal: CanvasProposal, existing: ReadonlyMap<number, Existing>): string[] {
  return proposal.edges
    .map((e) => `${who(proposal, existing, e.fromIndex)}->${who(proposal, existing, e.toIndex)}`)
    .sort();
}

/**
 * What a node's prompt @s, by identity, in prompt order.
 * @param proposal - The proposal.
 * @param existing - The reused nodes.
 * @param index - The node's index.
 * @returns The identities.
 */
function refsOf(proposal: CanvasProposal, existing: ReadonlyMap<number, Existing>, index: number): string[] {
  return (proposal.nodes[index]?.prompt ?? []).flatMap((s) => (s.ref === undefined ? [] : [who(proposal, existing, s.ref)]));
}

/**
 * The index a canvas node is reused at.
 * @param existing - The reused nodes.
 * @param nodeId - The canvas node.
 * @returns Its index, or -1.
 */
function indexOf(existing: ReadonlyMap<number, Existing>, nodeId: string): number {
  for (const [index, entry] of existing) if (entry.nodeId === nodeId) return index;
  return -1;
}

/**
 * The appended nodes: every index no canvas node stands behind.
 * @param proposal - The proposal.
 * @param existing - The reused nodes.
 * @returns Those nodes.
 */
function appendedOf(proposal: CanvasProposal, existing: ReadonlyMap<number, Existing>): ProposalNode[] {
  return proposal.nodes.filter((_, i) => !existing.has(i));
}

/** A proposal node with the two fields 6.3 adds. */
type TemplateProposalNode = ProposalNode & {
  resource?: string;
  templateNode?: { template: string; key: string; anchor?: number };
};

describe('useApplyTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    stamp = 0;
    setLocaleMessages('en', EN_WITH_FIXTURE as Record<string, unknown>);
  });
  afterEach(() => {
    setLocaleMessages('en', en as Record<string, unknown>);
    setLocale('en');
  });

  describe('what stops it before anything is placed', () => {
    it('says the model is unavailable and places nothing when the catalog no longer has it', () => {
      seed('target', 'image');
      const place = vi.fn();
      apply(grid(), 'target', [], place);
      expect(toast.error).toHaveBeenCalledWith(en.canvas.generatePanel.modelUnavailable);
      expect(place).not.toHaveBeenCalled();
    });

    it('judges availability over every generate node of the template, not only the anchor (6.5 step 2)', () => {
      seed('target', 'image');
      const place = vi.fn();
      apply(FLOW, 'target', [FINAL_MODEL], place);
      expect(toast.error).toHaveBeenCalledWith(en.canvas.generatePanel.modelUnavailable);
      expect(place).not.toHaveBeenCalled();

      vi.mocked(toast.error).mockClear();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);
      expect(toast.error).not.toHaveBeenCalled();
      expect(place).toHaveBeenCalledTimes(1);
    });

    it('warns that the panel’s own node is locked and places nothing (6.5 step 1)', () => {
      seed('target', 'image', { locked: true });
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);
      expect(toast.warning).toHaveBeenCalledWith(en.canvas.gate.locked, { id: 'canvas-node-gate' });
      expect(place).not.toHaveBeenCalled();
    });

    it('warns and places nothing when the upstream node it would reuse is locked (6.5 step 3)', () => {
      seedFlowInstance('target');
      setNodeLocked('p', 's', 'target-sheet', true);
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);
      expect(toast.warning).toHaveBeenCalledWith(en.canvas.gate.locked, { id: 'canvas-node-gate' });
      expect(place).not.toHaveBeenCalled();
    });
  });

  describe('a single-node template (the migrated storyboard)', () => {
    it('@s the reference already wired in, by its rail row, and creates nothing', () => {
      seed('target', 'image', { paramsByModel: { 'nano-banana': { aspect_ratio: '16:9' } } });
      seed('src', 'image', { name: 'Hero', content: 'https://cdn/hero.png' });
      wire('src', 'target');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);

      const { proposal, existing } = placed(place);
      expect(existing.get(0)?.nodeId).toBe('target');
      const src = indexOf(existing, 'src');
      expect(src).toBeGreaterThan(0);
      expect(existing.get(src)?.mention).toEqual({
        sourceNodeId: 'src',
        label: 'Hero',
        kind: 'image',
        thumbnail: 'https://cdn/hero.png',
      });
      expect(appendedOf(proposal, existing)).toEqual([]);
      // Already wired, so no edge is drawn again.
      expect(proposal.edges).toEqual([]);
      expect(refsOf(proposal, existing, 0)).toEqual(['src']);
      const anchor = proposal.nodes[0];
      // The reference already holds its file, so no note says to put one in.
      expect(anchor?.prompt).not.toContainEqual({ slot: { kind: 'note', label: t('canvas.template.storyboard-grid-25.input.reference.note') } });
      expect(anchor?.mode).toBe('i2i');
      expect(anchor?.model).toBe('nano-banana-pro-edit-ultra');
      // The anchor's params as `templateParams` merges them: its other models kept.
      expect(existing.get(0)?.paramsByModel?.['nano-banana']).toEqual({ aspect_ratio: '16:9' });
      expect(existing.get(0)?.paramsByModel?.['nano-banana-pro-edit-ultra']).toEqual({ aspect_ratio: '1:1', resolution: '4k' });
    });

    it('creates an empty reference node, wires it and @s it, with the note on top, when nothing is wired', () => {
      seed('target', 'image');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);

      const { proposal, existing } = placed(place);
      expect([...existing.keys()]).toEqual([0]);
      const name = t('canvas.template.storyboard-grid-25.input.reference.name');
      const added = appendedOf(proposal, existing);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ role: 'source', type: 'image', name });
      expect((added[0] as TemplateProposalNode).templateNode).toBeUndefined();
      expect(edgesOf(proposal, existing)).toEqual([`new:${name}->target`]);
      expect(refsOf(proposal, existing, 0)).toEqual([`new:${name}`]);
      expect(proposal.nodes[0]?.prompt).toContainEqual({
        slot: { kind: 'note', label: t('canvas.template.storyboard-grid-25.input.reference.note') },
      });
      // No steps, so no guide.
      expect(proposal.nodes.filter((n) => n.role === 'written')).toEqual([]);
      // An empty node and a `{✏️ …}` are left for the reader (6.5 step 8).
      expect(toast.info).toHaveBeenCalledWith(en.canvas.generatePanel.editProposalMarks);
    });

    it('writes the anchor prompt in the reader’s language', () => {
      seed('target', 'image');
      setLocale('zh-CN');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);
      const { proposal } = placed(place);
      const words = (proposal.nodes[0]?.prompt ?? []).map((s) => s.text ?? '').join('');
      expect(words).toContain('5 行 5 列');
    });

    it('leaves a second wired reference alone', () => {
      seed('target', 'image');
      seed('first', 'image', { name: 'First', content: 'https://cdn/first.png' });
      seed('second', 'image', { name: 'Second', content: 'https://cdn/second.png' });
      wire('first', 'target');
      wire('second', 'target');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);

      const { proposal, existing } = placed(place);
      expect(indexOf(existing, 'second')).toBe(-1);
      expect(refsOf(proposal, existing, 0)).toEqual(['first']);
      expect(appendedOf(proposal, existing)).toEqual([]);
      expect(proposal.edges).toEqual([]);
    });

    it('@s a node another template placed, like any reference', () => {
      seed('target', 'image');
      seed('other', 'image', {
        name: 'Other',
        content: 'https://cdn/other.png',
        templateNode: { template: 'costume-sheet', key: 'sheet' },
      });
      wire('other', 'target');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);

      const { proposal, existing } = placed(place);
      expect(refsOf(proposal, existing, 0)).toEqual(['other']);
      expect(appendedOf(proposal, existing)).toEqual([]);
    });
  });

  describe('the multi-node fixture', () => {
    it('lays out every template node, every input and the guide around an anchor with nothing wired', () => {
      seed('target', 'image');
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect([...existing.keys()]).toEqual([0]);
      const added = appendedOf(proposal, existing) as TemplateProposalNode[];
      expect(added.map((n) => n.name).sort()).toEqual(
        ['Back view', 'Character', 'Fixture flow', 'Front view', 'Pose', 'Sheet', 'Style'].sort(),
      );
      expect(added.find((n) => n.name === 'Sheet')?.templateNode).toEqual({ template: 'fixture-flow', key: 'sheet' });
      expect(added.find((n) => n.name === 'Style')).toMatchObject({
        role: 'source',
        resource: 'templates/fixture-flow/style.png',
        templateNode: { template: 'fixture-flow', key: 'style' },
      });
      expect(added.find((n) => n.name === 'Pose')?.templateNode).toBeUndefined();
      expect(added.find((n) => n.name === 'Fixture flow')).toEqual(templateGuideNode(FLOW, 0));
      expect(edgesOf(proposal, existing)).toEqual(
        [
          'new:Style->new:Sheet',
          'new:Sheet->target',
          'new:Pose->new:Sheet',
          'new:Character->new:Sheet',
          'new:Front view->target',
          'new:Back view->target',
          'new:Character->target',
        ].sort(),
      );
      expect(refsOf(proposal, existing, 0)).toEqual(['new:Front view', 'new:Back view', 'new:Character']);
    });

    it('reuses the whole instance on a second apply: nothing new, no second guide, each input @ing its own node', () => {
      seedFlowInstance('target');
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect(appendedOf(proposal, existing)).toEqual([]);
      expect(proposal.edges).toEqual([]);
      expect([...existing.values()].map((e) => e.nodeId).sort()).toEqual(
        ['target', 'target-back', 'target-character', 'target-front', 'target-pose', 'target-sheet', 'target-style'].sort(),
      );
      // The guide already there is neither duplicated nor rewritten.
      expect(indexOf(existing, 'target-guide')).toBe(-1);
      expect(proposal.nodes.filter((n) => n.role === 'written')).toEqual([]);
      // Two same-type inputs each @ the node first given them.
      expect(refsOf(proposal, existing, 0)).toEqual(['target-front', 'target-back', 'target-character']);
      // The reused upstream node still @s the resource wired only into it, and
      // the input fed only to it is not rebuilt.
      const sheet = indexOf(existing, 'target-sheet');
      expect(refsOf(proposal, existing, sheet)).toEqual(['target-character', 'target-pose', 'target-style']);
      // The upstream generation is rewritten to the template's settings; the
      // resource and the inputs are not.
      expect(proposal.nodes[sheet]).toMatchObject({ role: 'generate', mode: 'i2i', model: 'model-sheet' });
      expect(Object.keys(existing.get(sheet)?.paramsByModel ?? {})).toContain('model-sheet');
      expect(existing.get(indexOf(existing, 'target-style'))?.paramsByModel).toBeUndefined();
      expect(existing.get(indexOf(existing, 'target-front'))?.mention).toEqual({
        sourceNodeId: 'target-front',
        label: 'front picture',
        kind: 'image',
        thumbnail: 'https://cdn/target-front.png',
      });
    });

    it('reads the rail in connection order, not in the order the edges were written', () => {
      seed('target', 'image');
      seed('a', 'image', { name: 'A', content: 'https://cdn/a.png' });
      seed('b', 'image', { name: 'B', content: 'https://cdn/b.png' });
      // `b` is written first but connected later.
      wire('b', 'target', 20_000);
      wire('a', 'target', 19_000);
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      const anchorRefs = refsOf(proposal, existing, 0);
      expect(anchorRefs.slice(0, 2)).toEqual(['a', 'b']);
    });

    it('gives the second same-type input a new empty node when only one node is wired in', () => {
      seed('target', 'image');
      seed('only', 'image', { name: 'Only', content: 'https://cdn/only.png' });
      wire('only', 'target');
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect(refsOf(proposal, existing, 0)).toEqual(['only', 'new:Back view', 'new:Character']);
      expect(edgesOf(proposal, existing)).toContain('new:Back view->target');
      expect(edgesOf(proposal, existing)).not.toContain('only->target');
    });

    it('keeps every node after the reader switched the anchor’s and upstream’s models', () => {
      seedFlowInstance('target', { models: true });
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect(appendedOf(proposal, existing)).toEqual([]);
      expect(proposal.nodes[0]).toMatchObject({ mode: 'i2i', model: 'model-final' });
      expect(proposal.nodes[indexOf(existing, 'target-sheet')]).toMatchObject({ mode: 'i2i', model: 'model-sheet' });
    });

    it('leaves the earlier of two chained instances alone when applied on the later one', () => {
      seedFlowInstance('first');
      seed('second', 'image');
      // The first instance's result is the second one's front view.
      wire('first', 'second');
      const place = vi.fn();
      apply(FLOW, 'second', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      const reused = [...existing.values()].map((e) => e.nodeId).sort();
      expect(reused).toEqual(['first', 'second']);
      expect(refsOf(proposal, existing, 0)[0]).toBe('first');
      // The first instance's upstream, resource and guide are not this one's.
      expect(appendedOf(proposal, existing).map((n) => n.name)).toEqual(
        expect.arrayContaining(['Sheet', 'Style', 'Fixture flow']),
      );
    });

    it('does not reuse a tagged node that was copied but never wired in', () => {
      seed('target', 'image');
      seed('stray', 'image', { name: 'Sheet', templateNode: { template: 'fixture-flow', key: 'sheet' } });
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect(indexOf(existing, 'stray')).toBe(-1);
      expect(appendedOf(proposal, existing).filter((n) => n.name === 'Sheet')).toHaveLength(1);
    });
  });

  describe('the guide text node', () => {
    it('puts the guide back when the reader deleted it', () => {
      seedFlowInstance('target', { guide: false });
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect(appendedOf(proposal, existing)).toEqual([templateGuideNode(FLOW, 0)]);
    });

    it('does not count a guide that belongs to another anchor', () => {
      seedFlowInstance('target', { guide: false });
      seed('elsewhere-guide', 'text', {
        name: 'Fixture flow',
        templateNode: { template: 'fixture-flow', key: 'guide', anchor: 'elsewhere' },
      });
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);

      const { proposal, existing } = placed(place);
      expect(appendedOf(proposal, existing)).toEqual([templateGuideNode(FLOW, 0)]);
    });

    it('puts no guide for a template without steps', () => {
      seed('target', 'image');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);
      const { proposal } = placed(place);
      expect(proposal.nodes.some((n) => (n as TemplateProposalNode).templateNode?.key === 'guide')).toBe(false);
    });
  });

  describe('an anchor inside a locked group', () => {
    /**
     * Puts the given nodes in a group and locks it.
     * @param members - The member ids.
     */
    function lockInGroup(members: readonly string[]): void {
      createGroup(
        'p',
        's',
        createGroupNode('g', { x: 0, y: 0 }, 2000, 1000, 'u1'),
        members.map((id) => ({ id, position: { x: 0, y: 0 } })),
      );
      setNodeLocked('p', 's', 'g', true);
    }

    it('warns and places nothing when the template needs a new node', () => {
      seed('target', 'image');
      lockInGroup(['target']);
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);
      expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe(t('canvas.template.groupLocked'));
      expect(place).not.toHaveBeenCalled();
    });

    it('warns and places nothing when the only new node would be the guide', () => {
      seedFlowInstance('target', { guide: false });
      lockInGroup(['target', 'target-sheet', 'target-style', 'target-pose', 'target-front', 'target-back', 'target-character']);
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);
      expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe(t('canvas.template.groupLocked'));
      expect(place).not.toHaveBeenCalled();
    });

    it('applies as usual when nothing new is needed', () => {
      seedFlowInstance('target');
      lockInGroup([
        'target',
        'target-sheet',
        'target-style',
        'target-pose',
        'target-front',
        'target-back',
        'target-character',
        'target-guide',
      ]);
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);
      expect(toast.warning).not.toHaveBeenCalled();
      const { proposal, existing } = placed(place);
      expect(appendedOf(proposal, existing)).toEqual([]);
    });
  });

  describe('round-1 review (inner#1345)', () => {
    it('notes the input whose wired node is still empty', () => {
      seed('target', 'image');
      seed('src', 'image', { name: 'Empty one' });
      wire('src', 'target');
      const place = vi.fn();
      apply(grid(), 'target', [ULTRA], place);
      const { proposal } = placed(place);
      expect(proposal.nodes[0]?.prompt).toContainEqual({
        slot: { kind: 'note', label: t('canvas.template.storyboard-grid-25.input.reference.note') },
      });
    });

    it('hands a reused resource node over with its path, so an empty one is fetched again', () => {
      seedFlowInstance('target');
      const place = vi.fn();
      apply(FLOW, 'target', BOTH_FLOW_MODELS, place);
      const { proposal, existing } = placed(place);
      expect((proposal.nodes[indexOf(existing, 'target-style')] as TemplateProposalNode).resource).toBe('templates/fixture-flow/style.png');
    });
  });

  it('says applying failed when placing throws (6.5 step 8)', () => {
    seed('target', 'image');
    seed('src', 'image', { name: 'Hero', content: 'https://cdn/hero.png' });
    wire('src', 'target');
    const place = vi.fn(() => {
      throw new Error('write failed');
    });
    apply(grid(), 'target', [ULTRA], place);
    expect(place).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(t('canvas.template.applyFailed'));
  });
});

describe('the view the panel matches on', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('carries data.templateNode from the document; the anchor and inputs carry none', () => {
    seedFlowInstance('target');
    const views = readCanvasGraph('p', 's').nodes;
    const tagOf = (id: string): unknown =>
      (views.find((n) => n.id === id)?.data as { templateNode?: unknown } | undefined)?.templateNode;
    expect(tagOf('target-sheet')).toEqual({ template: 'fixture-flow', key: 'sheet' });
    expect(tagOf('target-style')).toEqual({ template: 'fixture-flow', key: 'style' });
    expect(tagOf('target-guide')).toEqual({ template: 'fixture-flow', key: 'guide', anchor: 'target' });
    expect(tagOf('target')).toBeUndefined();
    expect(tagOf('target-front')).toBeUndefined();
  });
});
