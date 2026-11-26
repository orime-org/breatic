// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Applying a template with a text node again (inner#1824, CAP-3): the text
 * node the instance already has is reused and nothing is written to it, so a
 * lock on it does not stop the apply, while a lock on a node the apply
 * rewrites still does.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, setLocaleMessages, type GenerationTemplate, type ModelEntry } from '@breatic/shared';
import en from '@locales/en.json';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { addEdge, addNode, setNodeLocked } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import { toast } from '@web/lib/toast';
import { useApplyTemplate, type PlaceTemplate } from '@web/spaces/canvas/generate/use-apply-template';
import type { PlacedProposal } from '@web/spaces/canvas/use-node-creation';

const SCENE_MODEL = { name: 'model-scene', mode: 't2v', params: {} } as unknown as ModelEntry;

/** A script wired into the pool of two scenes, the second downstream of the first. */
const SCRIPTED: GenerationTemplate = {
  id: 'fixture-scripted',
  anchor: 'result',
  nodes: [
    { key: 'result', role: 'generate', type: 'video', mode: 't2v', model: 'model-scene', params: {} },
    { key: 'script', role: 'written', type: 'text' },
    { key: 'scene-2', role: 'generate', type: 'video', mode: 't2v', model: 'model-scene', params: {} },
  ],
  edges: [
    { from: 'script', to: 'result', into: 'pool' },
    { from: 'script', to: 'scene-2', into: 'pool' },
    { from: 'result', to: 'scene-2', into: 'pool' },
  ],
  inputs: [],
  steps: [],
  agentNote: 'a fixture two-scene episode',
  goal: 'cinematic',
  triggers: { asks: ['a fixture'], offerWhen: ['a fixture is wanted'] },
};

const STRINGS = {
  name: 'Scene 1',
  description: 'A fixture',
  prompt: 'Play scene 1 of [📎 Script].',
  node: {
    script: { name: 'Script', text: 'Who: {✏️ the lead}' },
    'scene-2': { name: 'Scene 2', prompt: '(💡 Generate the first scene first)Play scene 2 of [📎 Script] after [📎 Scene 1].' },
  },
};

/**
 * Adds a node to the test Space.
 * @param id - Node id.
 * @param type - Node type.
 * @param extra - Further data fields.
 */
function seed(id: string, type: 'video' | 'text', extra: Record<string, unknown> = {}): void {
  addNode('p', 's', {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], ...extra },
  } as Parameters<typeof addNode>[2]);
}

let stamp = 0;

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
 * A placing callback's answer for a template that landed.
 * @param _args - What it was asked to place.
 * @returns Placed, with no new nodes.
 */
function lands(..._args: Parameters<PlaceTemplate>): PlacedProposal {
  return { nodeIds: [], rects: [] };
}

/** The instance a first apply leaves, its script written by the user and its second scene deleted. */
function seedInstance(): void {
  seed('target', 'video');
  seed('target-script', 'text', { name: 'Script', templateNode: { template: 'fixture-scripted', key: 'script' } });
  wire('target-script', 'target');
}

describe('applying a template with a text node again (inner#1824, CAP-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    stamp = 0;
    setLocaleMessages('en', { ...en, canvas: { ...en.canvas, template: { ...en.canvas.template, 'fixture-scripted': STRINGS } } } as Record<string, unknown>);
  });
  afterEach(() => {
    setLocaleMessages('en', en as Record<string, unknown>);
    setLocale('en');
  });

  it('puts the deleted scene back when the user locked the script, which the apply leaves as it is', () => {
    seedInstance();
    setNodeLocked('p', 's', 'target-script', true);
    const place = vi.fn(lands);
    const { result } = renderHook(() => useApplyTemplate('p', 's', 'target', [SCENE_MODEL], place));
    result.current(SCRIPTED);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(place).toHaveBeenCalledTimes(1);
    const [proposal, existing] = place.mock.calls[0] as Parameters<PlaceTemplate>;
    // The script is reused, not placed again, and nothing rewrites it.
    const script = [...existing].find(([, node]) => node.nodeId === 'target-script')?.[0];
    expect(script).toBeDefined();
    expect(proposal.nodes[script as number]?.role).not.toBe('written');
    expect(proposal.nodes.some((node) => node.templateNode?.key === 'scene-2')).toBe(true);
  });

  it('still stops when the scene it would rewrite is locked', () => {
    seedInstance();
    seed('target-scene-2', 'video', { name: 'Scene 2', templateNode: { template: 'fixture-scripted', key: 'scene-2' } });
    wire('target-script', 'target-scene-2');
    wire('target', 'target-scene-2');
    setNodeLocked('p', 's', 'target-scene-2', true);
    const place = vi.fn(lands);
    const { result } = renderHook(() => useApplyTemplate('p', 's', 'target', [SCENE_MODEL], place));
    result.current(SCRIPTED);
    expect(toast.warning).toHaveBeenCalledWith(en.canvas.gate.locked, { id: 'canvas-node-gate' });
    expect(place).not.toHaveBeenCalled();
  });
});
