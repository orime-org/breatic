// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import {
  buildGeneratePanelViewModel,
  resolveModeSwitch,
} from '@web/spaces/canvas/generate/panel-view-model';
import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

/**
 * Builds an image ModelEntry fixture with only the fields the view-model reads.
 * @param name - Model id.
 * @param over - Overrides (tier, cost_per_call, params).
 * @returns A minimal image ModelEntry.
 */
function makeModel(name: string, over: Partial<ModelEntry> = {}): ModelEntry {
  const mode = over.mode ?? 't2i';
  return {
    name,
    display_name: name.toUpperCase(),
    modality: 'image',
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
    mode,
    // Mirror the backend `computeSourcesByMode` for image modes so the gate
    // (which reads `sourcesByMode[activeMode]`) is exercised realistically:
    // i2i / edit need an image, t2i generates from scratch.
    sourcesByMode:
      over.sourcesByMode ??
      Object.fromEntries(
        (Array.isArray(mode) ? mode : [mode]).map((m) => [
          m,
          m === 'i2i' || m === 'edit' ? (['image'] as const) : [],
        ]),
      ),
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
  // Both t2i so the default-t2i view offers them; sdxl carries the
  // `recommended` BADGE but the default pick is flux — the FIRST offered
  // model (user 2026-07-11: recommended is curation dressing, a mode may
  // carry several; it is not a default-selection rule).
  const models = [
    makeModel('flux', { mode: 't2i', tier: 'optional', cost_per_call: 7 }),
    makeModel('sdxl', { mode: 't2i', tier: 'recommended', cost_per_call: 3 }),
  ];
  // A small i2i catalog + node for the reference tests: reference URLs only
  // flow in i2i (t2i generates from scratch — see the dedicated t2i test).
  const i2iModels = [makeModel('mj-i2i', { mode: 'i2i', cost_per_call: 9 })];
  /**
   * An i2i-mode image node whose panel offers the i2i catalog above.
   * @param over - Extra image-view overrides.
   * @returns An i2i image node view.
   */
  function i2iView(
    over: Partial<Extract<NodeView, { kind: 'image' }>> = {},
  ): NodeView {
    return imageView({ mode: 'i2i', model: 'mj-i2i', ...over });
  }

  it('uses the stored model when it is present in the mode catalog', () => {
    const nodes = [node('n1', imageView({ model: 'flux' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('flux');
    expect(vm.creditEstimate).toBe(7);
  });

  it('picks the FIRST offered model when the node has none (user 2026-07-11)', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('flux'); // first in the list; sdxl's badge does not promote it
    expect(vm.creditEstimate).toBe(7);
  });

  it('restores the mode\'s remembered model over the first', () => {
    const nodes = [node('n1', imageView({ modelByMode: { t2i: 'sdxl' } }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('sdxl'); // remembered t2i pick beats list order
  });

  it('defaults the mode to t2i when the node stores none', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.mode).toBe('t2i');
  });

  it('reads a stored i2i mode', () => {
    const nodes = [node('n1', i2iView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: i2iModels });
    expect(vm.mode).toBe('i2i');
  });

  it('sanitizes a malformed stored mode to t2i', () => {
    const nodes = [node('n1', imageView({ mode: 'garbage' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.mode).toBe('t2i');
  });

  it('narrows the picker to the active mode (t2i shows t2i, i2i shows i2i)', () => {
    const mixed = [
      makeModel('flux', { mode: 't2i' }),
      makeModel('mj-i2i', { mode: 'i2i' }),
      makeModel('nano-edit', { mode: ['i2i', 'edit'] }), // carries i2i
    ];
    const t2iVm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes: [node('n1', imageView())],
      edges: [],
      models: mixed,
    });
    expect(t2iVm.models.map((m) => m.name)).toEqual(['flux']);
    const i2iVm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ mode: 'i2i' }))],
      edges: [],
      models: mixed,
    });
    expect(i2iVm.models.map((m) => m.name)).toEqual(['mj-i2i', 'nano-edit']);
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

  it('i2i sends ONLY @-mentioned reference URLs (subset of the rail)', () => {
    const nodes = [
      node('n1', i2iView()),
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vm.references).toHaveLength(1);
    expect(vm.references[0]?.sourceNodeId).toBe('src');
    expect(vm.referenceUrls).toEqual(['https://cdn/x.png']);
  });

  it('i2i with an incoming edge but NO @-mention submits no source image (design B)', () => {
    const nodes = [
      node('n1', i2iView()),
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    // No atMentionedSourceIds → nothing @-picked. Design B: i2i without an
    // @-reference sends an empty source list (the #1675 gate then blocks execute).
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges, models: i2iModels });
    expect(vm.references).toHaveLength(1); // rail still shows the connected image
    expect(vm.referenceUrls).toEqual([]); // but nothing is @-picked → no source sent
  });

  it('i2i drops an @-mentioned NON-image source (never sends a non-image URL as a source image)', () => {
    // The @ picker pool has no type filter, so a connected audio/video/3d/web
    // node can be @-mentioned. Its URL must NEVER ride into params.images — an
    // i2i source is definitionally an image (adversarial 2026-07-10).
    const nodes = [
      node('n1', i2iView()),
      node('aud', { kind: 'audio', status: 'idle', name: 'Song', content: 'https://cdn/x.mp3' }),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'aud', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['aud']),
    });
    expect(vm.references).toHaveLength(1); // the audio node is still a connected reference
    expect(vm.referenceUrls).toEqual([]); // but its URL is NOT an image source
  });

  it('t2i contributes NO reference URLs even with an incoming edge (generates from scratch)', () => {
    // Design §2.5: t2i ignores source images — the rail still renders (greyed in
    // the panel) but no reference URL reaches the execute payload.
    const nodes = [
      node('n1', imageView({ model: 'flux' })), // default t2i
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges, models });
    expect(vm.references).toHaveLength(1); // rail still shown
    expect(vm.referenceUrls).toEqual([]); // but nothing submitted
  });

  it('keeps only string URLs in referenceUrls (filters a malformed non-string content, i2i)', () => {
    const nodes = [
      node('n1', i2iView()),
      // malformed: content is an object, not a URL string
      node('src', imageView({ name: 'Bad', content: { u: 1 } as unknown as string })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vm.referenceUrls).toEqual([]); // the object must not slip into the payload
  });

  it('skips references whose source carries no asset URL (i2i)', () => {
    const nodes = [
      node('n1', i2iView()),
      node('src', imageView({ name: 'Empty' })), // no content
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vm.references).toHaveLength(1); // still shown in the rail
    expect(vm.referenceUrls).toEqual([]); // but no URL to submit
  });

  it('returns a safe empty view-model when the node is missing', () => {
    const vm = buildGeneratePanelViewModel({ nodeId: 'ghost', nodes: [], edges: [], models });
    expect(vm.model).toBe('flux'); // first t2i model — picker stays usable
    expect(vm.mode).toBe('t2i');
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

  it('flags catalogEmpty on GLOBAL generatable-model emptiness, not the active mode (§ round-2)', () => {
    const nodes = [node('n1', imageView())]; // t2i
    const toolsOnly = [makeModel('bg', { mode: 'remove_bg', tier: 'internal' })];
    // loading / failed (no models) -> empty
    expect(
      buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: [] }).catalogEmpty,
    ).toBe(true);
    // only pure tools, zero generatable -> empty
    expect(
      buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: toolsOnly }).catalogEmpty,
    ).toBe(true);
    // has generatable models -> NOT empty
    expect(
      buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models }).catalogEmpty,
    ).toBe(false);
    // i2i mode with ZERO i2i models but t2i models present: catalogEmpty stays
    // false so the toggle can escape back to t2i (round-2 fix).
    expect(
      buildGeneratePanelViewModel({
        nodeId: 'n1',
        nodes: [node('n1', imageView({ mode: 'i2i' }))],
        edges: [],
        models,
      }).catalogEmpty,
    ).toBe(false);
  });

  it('excludes pure-tool models (remove_bg / upscale) from the picker', () => {
    const mixed = [
      makeModel('flux', { mode: 't2i' }), // generation
      makeModel('bg-remover', { mode: 'remove_bg', tier: 'internal' }), // tool
      makeModel('topaz', { mode: 'upscale', tier: 'internal' }), // tool
    ];
    const nodes = [node('n1', imageView())]; // default t2i
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: mixed });
    expect(vm.models.map((m) => m.name)).toEqual(['flux']); // tools dropped
    expect(vm.model).toBe('flux'); // default never a tool
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

  // requiresSource drives the #1675 execute gate: a model whose mode needs a
  // source image (i2i / edit) must not submit with an empty image list.
  it('flags requiresSource=false for a t2i model (generates from scratch)', () => {
    const nodes = [node('n1', imageView({ model: 'flux' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.requiresSource).toBe(false);
  });

  it('flags requiresSource=true for an i2i model (#1675 gate)', () => {
    const nodes = [node('n1', i2iView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: i2iModels });
    expect(vm.requiresSource).toBe(true);
  });

  it('flags requiresSource=true for an edit-capable model', () => {
    const editModels = [makeModel('nano-edit', { mode: ['i2i', 'edit'] })];
    const nodes = [node('n1', imageView({ mode: 'i2i', model: 'nano-edit' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: editModels });
    expect(vm.requiresSource).toBe(true);
  });

  it('flags requiresSource=false when the catalog is empty (no model resolved)', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: [] });
    expect(vm.requiresSource).toBe(false);
  });

  // Round-2 adversarial: a HYBRID model (mode: ['t2i','i2i'] — real models
  // like Seedream / Flux are hybrid) offered under the t2i toggle must NOT
  // demand a source image: the ACTIVE PANEL MODE decides the submission
  // semantics, not the model's capability list. Keying the gate on the
  // capability array made t2i permanently unexecutable for hybrids (t2i
  // clears referenceUrls, so the "needs source image" gate could never pass).
  it('requiresSource=false for a hybrid (t2i+i2i) model running under t2i', () => {
    const hybrid = [makeModel('seedream', { mode: ['t2i', 'i2i'] })];
    const nodes = [node('n1', imageView({ mode: 't2i', model: 'seedream' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: hybrid });
    expect(vm.requiresSource).toBe(false);
  });

  it('requiresSource=true for the same hybrid model running under i2i', () => {
    const hybrid = [makeModel('seedream', { mode: ['t2i', 'i2i'] })];
    const nodes = [node('n1', imageView({ mode: 'i2i', model: 'seedream' }))];
    const vm = buildGeneratePanelViewModel({ nodeId: 'n1', nodes, edges: [], models: hybrid });
    expect(vm.requiresSource).toBe(true);
  });
});

describe('resolveModeSwitch — model + params to persist on a mode toggle', () => {
  const catalog = [
    makeModel('flux-t2i', { mode: 't2i' }),
    makeModel('mj-i2i', { mode: 'i2i' }),
    makeModel('nano-i2i', { mode: ['i2i'], tier: 'recommended' }),
  ];

  it('resolves the target mode\'s FIRST model when there is no memory (user 2026-07-11)', () => {
    const r = resolveModeSwitch({ modelByMode: {}, params: {} }, 'i2i', catalog);
    // mj-i2i is first for i2i; nano-i2i's recommended badge does not promote it.
    expect(r.model).toBe('mj-i2i');
  });

  it('restores the target mode\'s remembered model over the first', () => {
    const r = resolveModeSwitch(
      { modelByMode: { i2i: 'nano-i2i' }, params: {} },
      'i2i',
      catalog,
    );
    expect(r.model).toBe('nano-i2i'); // remembered i2i pick beats list order
  });

  it('reconciles params against the resolved model (keeps valid, drops unknown)', () => {
    const r = resolveModeSwitch(
      { modelByMode: {}, params: { aspect_ratio: '16:9', bogus: 'x' } },
      't2i',
      catalog,
    );
    expect(r.model).toBe('flux-t2i');
    expect(r.params.aspect_ratio).toBe('16:9'); // kept — valid for the model
    expect(r.params.bogus).toBeUndefined(); // dropped — model has no such param
  });

  it('yields an empty model when the target mode offers nothing', () => {
    const t2iOnly = [makeModel('flux-t2i', { mode: 't2i' })];
    const r = resolveModeSwitch({ modelByMode: {}, params: {} }, 'i2i', t2iOnly);
    expect(r.model).toBe('');
    expect(r.params).toEqual({});
  });
});

describe('buildGeneratePanelViewModel — maxReferences (#1735 count gate)', () => {
  it('exposes the active model images-param max_items as maxReferences', () => {
    const capped = makeModel('nano-edit', {
      mode: 'i2i',
      params: { images: { description: '', default: null, max_items: 3 } },
    });
    const vm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ mode: 'i2i', model: 'nano-edit' }))],
      edges: [],
      models: [capped],
    });
    expect(vm.model).toBe('nano-edit');
    expect(vm.maxReferences).toBe(3);
  });

  it('leaves maxReferences undefined when the active model caps nothing', () => {
    // The default makeModel params carry aspect_ratio / resolution — no images cap.
    const vm = buildGeneratePanelViewModel({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ mode: 't2i', model: 'flux' }))],
      edges: [],
      models: [makeModel('flux', { mode: 't2i' })],
    });
    expect(vm.maxReferences).toBeUndefined();
  });
});
