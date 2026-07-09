// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { buildGeneratePanelViewModel } from '@web/spaces/canvas/generate/panel-view-model';
import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

/**
 * Builds an image ModelEntry fixture with only the fields the view-model reads.
 * @param name - Model id.
 * @param over - Overrides (tier, cost_per_call, params).
 * @returns A minimal image ModelEntry.
 */
function makeModel(name: string, over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name,
    display_name: name.toUpperCase(),
    modality: 'image',
    mode: 't2i',
    description: '',
    guide: '',
    tier: 'optional',
    cost_per_call: 5,
    generation_time: 10,
    params: {
      aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' },
      resolution: { description: '', values: ['1k', '2k'], default: '1k' },
    },
    providers: [],
    ...over,
  };
}

/**
 * Builds a canvas node view fixture.
 * @param id - Node id.
 * @param data - The node's view data.
 * @returns A CanvasNodeView.
 */
function node(id: string, data: NodeView): CanvasNodeView {
  return { id, type: data.kind, position: { x: 0, y: 0 }, data };
}

/** An image node view carrying generate inputs. */
function imageView(over: Partial<Extract<NodeView, { kind: 'image' }>> = {}): NodeView {
  return { kind: 'image', status: 'idle', ...over };
}

describe('buildGeneratePanelViewModel', () => {
  const models = [
    makeModel('flux', { tier: 'optional', cost_per_call: 7 }),
    makeModel('sdxl', { tier: 'recommended', cost_per_call: 3 }),
  ];

  it('uses the stored model when it is present in the catalog', () => {
    const nodes = [node('n1', imageView({ model: 'flux' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('flux');
    expect(vm.creditEstimate).toBe(7);
  });

  it('falls back to the first recommended model when the node has none', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('sdxl');
    expect(vm.creditEstimate).toBe(3);
  });

  it('falls back to the first model when nothing is recommended', () => {
    const flat = [makeModel('a'), makeModel('b')];
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: flat });
    expect(vm.model).toBe('a');
  });

  it('resolves params against the current model (keeps valid, fills defaults)', () => {
    const nodes = [
      node('n1', imageView({ model: 'flux', params: { aspect_ratio: '16:9', bogus: 'x' } })),
    ];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.params.aspect_ratio).toBe('16:9'); // kept — valid
    expect(vm.params.resolution).toBe('1k'); // filled from model default
    expect(vm.params.bogus).toBeUndefined(); // dropped — model has no such param
  });

  it('derives references from incoming edges and snapshots their asset URLs', () => {
    const nodes = [
      node('n1', imageView({ model: 'flux' })),
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges, models });
    expect(vm.references).toHaveLength(1);
    expect(vm.references[0]?.sourceNodeId).toBe('src');
    expect(vm.referenceUrls).toEqual(['https://cdn/x.png']);
  });

  it('keeps only string URLs in referenceUrls (filters a malformed non-string content)', () => {
    const nodes = [
      node('n1', imageView({ model: 'flux' })),
      // malformed: content is an object, not a URL string
      node('src', imageView({ name: 'Bad', content: { u: 1 } as unknown as string })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges, models });
    expect(vm.referenceUrls).toEqual([]); // the object must not slip into the payload
  });

  it('skips references whose source carries no asset URL', () => {
    const nodes = [
      node('n1', imageView({ model: 'flux' })),
      node('src', imageView({ name: 'Empty' })), // no content
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges, models });
    expect(vm.references).toHaveLength(1); // still shown in the rail
    expect(vm.referenceUrls).toEqual([]); // but no URL to submit
  });

  it('returns a safe empty view-model when the node is missing', () => {
    const vm = buildGeneratePanelViewModel({ nodeId: 'ghost', nodes: [], edges: [], models });
    expect(vm.model).toBe('sdxl'); // still offers a default so the picker is usable
    expect(vm.references).toEqual([]);
    expect(vm.referenceUrls).toEqual([]);
  });

  // Malformed-catalog robustness (non-number cost_per_call, non-array model
  // list) is now enforced ONCE at the API boundary — see sanitizeModelCatalog +
  // model-catalog.schema.test.ts. buildGeneratePanelViewModel consumes the
  // sanitized, trusted ModelEntry[], so those impossible-after-boundary states
  // are no longer re-tested here. (An EMPTY catalog is a real state and stays.)

  it('yields an empty model + zero credit when the catalog is empty', () => {
    // Guards the empty-catalog path: with no models the execute gate must see
    // model='' and refuse to submit an invalid task.
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: [] });
    expect(vm.model).toBe('');
    expect(vm.creditEstimate).toBe(0);
  });

  it('excludes pure-tool models (remove_bg / upscale) from the picker, keeps generation modes', () => {
    const mixed = [
      makeModel('flux', { mode: 't2i' }), // generation
      makeModel('mj-i2i', { mode: 'i2i' }), // image-to-image
      makeModel('nano-edit', { mode: ['i2i', 'edit'] }), // edit (carries i2i)
      makeModel('bg-remover', { mode: 'remove_bg', tier: 'internal' }), // tool
      makeModel('topaz', { mode: 'upscale', tier: 'internal' }), // tool
    ];
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: mixed });
    expect(vm.models.map((m) => m.name)).toEqual(['flux', 'mj-i2i', 'nano-edit']);
    // the model default is picked from the generatable set, never a tool
    expect(['flux', 'mj-i2i', 'nano-edit']).toContain(vm.model);
  });

  it('falls back off a stored tool model to a generatable default', () => {
    const mixed = [
      makeModel('flux', { mode: 't2i', tier: 'recommended' }),
      makeModel('bg-remover', { mode: 'remove_bg', tier: 'internal' }),
    ];
    // node somehow stored a tool model — it must not resolve to the tool.
    const nodes = [node('n1', imageView({ model: 'bg-remover' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: mixed });
    expect(vm.model).toBe('flux');
    expect(vm.models.some((m) => m.name === 'bg-remover')).toBe(false);
  });

  it('surfaces the node status so execute can refuse while handling', () => {
    const nodes = [node('n1', imageView({ model: 'flux', status: 'handling' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.nodeStatus).toBe('handling');
  });
});
