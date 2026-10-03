// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { FocusImage, ModelEntry } from '@breatic/shared';

import { resolveModeSwitch } from '@web/spaces/canvas/generate/mode-selection';
import {
  buildGeneratePanelViewModel,
} from '@web/spaces/canvas/generate/panel-view-model';
import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/data/yjs/node-view';

/**
 * Builds a view model with no body text, which is what every case here wants:
 * these tests cover model / params / status resolution, never what a text
 * reference says. `textById` is required at the real call sites so that
 * forgetting it cannot silently blank every reference (#1774 round-6).
 * @param input - Everything except the text map.
 * @returns The view model.
 */
function buildVm(
  input: Omit<Parameters<typeof buildGeneratePanelViewModel>[0], 'textById'>,
): ReturnType<typeof buildGeneratePanelViewModel> {
  return buildGeneratePanelViewModel({ ...input, textById: new Map() });
}

/**
 * Builds an image ModelEntry fixture with only the fields the view-model reads.
 * @param name - Model id.
 * @param over - Overrides (tier, mode, params).
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
    generation_time: 10,
    takes_prompt: true,
    providers: [],
    ...over,
    mode,
    // i2i / edit take the reference pool and cannot run without it, the way
    // the catalog declares it; t2i generates from scratch.
    params: {
      aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' },
      resolution: { description: '', values: ['1k', '2k'], default: '1k' },
      ...((Array.isArray(mode) ? mode : [mode]).some((m) => m === 'i2i' || m === 'edit')
        ? {
          images: {
            description: '',
            default: null,
            type: 'list',
            fill: 'pool',
            accepts: 'image',
            modes: ['i2i', 'edit'],
          },
        }
        : {}),
      ...over.params,
    },
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
    makeModel('flux', { mode: 't2i', tier: 'optional' }),
    makeModel('sdxl', { mode: 't2i', tier: 'recommended' }),
  ];
  // A small i2i catalog + node for the reference tests: reference URLs only
  // flow in i2i (t2i generates from scratch — see the dedicated t2i test).
  const i2iModels = [makeModel('mj-i2i', { mode: 'i2i' })];
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
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('flux');
  });

  it('picks the FIRST offered model when the node has none (user 2026-07-11)', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('flux'); // first in the list; sdxl's badge does not promote it
  });

  it('restores the mode\'s remembered model over the first', () => {
    const nodes = [node('n1', imageView({ modelByMode: { t2i: 'sdxl' } }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('sdxl'); // remembered t2i pick beats list order
  });

  it('restores the remembered model when the stored one is wrong-mode (9.10)', () => {
    // The node holds a model this mode does not offer — the state a
    // collaborator produces by switching mode while another picks a model
    // (`setNodeModel` writes the model but not the mode). The user should get
    // back the model THEY chose in t2i, not whichever the list starts with.
    // The case above leaves `model` unset and so only covers the absent
    // branch; without this one, resolving a wrong-mode model to the first
    // offered model goes unnoticed.
    const nodes = [
      node('n1', imageView({ model: 'mj-i2i', modelByMode: { t2i: 'sdxl' } })),
    ];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.model).toBe('sdxl');
  });

  it('defaults the mode to t2i when the node stores none', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.mode).toBe('t2i');
  });

  it('reads a stored i2i mode', () => {
    const nodes = [node('n1', i2iView())];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: i2iModels });
    expect(vm.mode).toBe('i2i');
  });

  it('sanitizes a malformed stored mode to t2i', () => {
    const nodes = [node('n1', imageView({ mode: 'garbage' }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.mode).toBe('t2i');
  });

  it('narrows the picker to the active mode (t2i shows t2i, i2i shows i2i)', () => {
    const mixed = [
      makeModel('flux', { mode: 't2i' }),
      makeModel('mj-i2i', { mode: 'i2i' }),
      makeModel('nano-edit', { mode: ['i2i', 'edit'] }), // carries i2i
    ];
    const t2iVm = buildVm({
      nodeId: 'n1',
      nodes: [node('n1', imageView())],
      edges: [],
      models: mixed,
    });
    expect(t2iVm.models.map((m) => m.name)).toEqual(['flux']);
    const i2iVm = buildVm({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ mode: 'i2i' }))],
      edges: [],
      models: mixed,
    });
    expect(i2iVm.models.map((m) => m.name)).toEqual(['mj-i2i', 'nano-edit']);
  });

  it('resolves params against the current model (keeps valid, fills defaults, drops undeclared)', () => {
    const nodes = [
      node(
        'n1',
        imageView({
          model: 'flux',
          paramsByModel: { flux: { aspect_ratio: '16:9', bogus: 'x' } },
        }),
      ),
    ];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.params.aspect_ratio).toBe('16:9'); // kept — valid
    expect(vm.params.resolution).toBe('1k'); // filled from model default
    // A key this model does not declare is dropped (#1948). What user
    // 2026-07-18 asked for — a switch away and back not losing a value — is
    // now guaranteed by the per-model record instead, so nothing has to ride
    // along inside another model's set to survive.
    expect(vm.params.bogus).toBeUndefined();
  });

  it('i2i sends ONLY @-mentioned reference URLs (subset of the rail)', () => {
    const nodes = [
      node('n1', i2iView()),
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vm.references).toHaveLength(1);
    expect(vm.references[0]?.sourceNodeId).toBe('src');
    expect(vm.referenceUrls.image).toEqual(['https://cdn/x.png']);
  });

  it('hands the prompt each mentioned picture in the words its model reads (#2156)', () => {
    const editModels = [
      makeModel('muse-image-edit', {
        mode: 'i2i',
        params: {
          images: { description: '', type: 'list', default: null, fill: 'pool', accepts: 'image', mention: 'image {n}' },
        },
      }),
    ];
    const nodes = [
      node('n1', imageView({ mode: 'i2i', model: 'muse-image-edit' })),
      node('a', imageView({ name: 'A', content: 'https://cdn/a.png' })),
      node('b', imageView({ name: 'B', content: 'https://cdn/b.png' })),
    ];
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'a', target: 'n1' },
      { id: 'e2', source: 'b', target: 'n1' },
    ];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: editModels,
      atMentionedSourceIds: new Set(['b', 'a']),
    });
    expect(vm.mentionTokens).toEqual({ a: 'image 1', b: 'image 2' });
  });

  it('i2i with an incoming edge but NO @-mention submits no source image (design B)', () => {
    const nodes = [
      node('n1', i2iView()),
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    // No atMentionedSourceIds → nothing @-picked. Design B: i2i without an
    // @-reference sends an empty source list (the #1675 gate then blocks execute).
    const vm = buildVm({ nodeId: 'n1', nodes, edges, models: i2iModels });
    expect(vm.references).toHaveLength(1); // rail still shows the connected image
    expect(vm.referenceUrls.image).toEqual([]); // but nothing is @-picked → no source sent
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
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['aud']),
    });
    expect(vm.references).toHaveLength(1); // the audio node is still a connected reference
    expect(vm.referenceUrls.image).toEqual([]); // but its URL is NOT an image source
  });

  it('t2i contributes NO reference URLs even with an incoming edge (generates from scratch)', () => {
    // Design §2.5: t2i ignores source images — the rail still renders (greyed in
    // the panel) but no reference URL reaches the execute payload.
    const nodes = [
      node('n1', imageView({ model: 'flux' })), // default t2i
      node('src', imageView({ name: 'Source', content: 'https://cdn/x.png' })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildVm({ nodeId: 'n1', nodes, edges, models });
    expect(vm.references).toHaveLength(1); // rail still shown
    expect(vm.referenceUrls.image).toEqual([]); // but nothing submitted
  });

  it('keeps only string URLs in referenceUrls (filters a malformed non-string content, i2i)', () => {
    const nodes = [
      node('n1', i2iView()),
      // malformed: content is an object, not a URL string
      node('src', imageView({ name: 'Bad', content: { u: 1 } as unknown as string })),
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vm.referenceUrls.image).toEqual([]); // the object must not slip into the payload
  });

  it('skips references whose source carries no asset URL (i2i)', () => {
    const nodes = [
      node('n1', i2iView()),
      node('src', imageView({ name: 'Empty' })), // no content
    ];
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'src', target: 'n1' }];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vm.references).toHaveLength(1); // still shown in the rail
    expect(vm.referenceUrls.image).toEqual([]); // but no URL to submit
  });

  it('returns a safe empty view-model when the node is missing', () => {
    const vm = buildVm({ nodeId: 'ghost', nodes: [], edges: [], models });
    expect(vm.model).toBe('flux'); // first t2i model — picker stays usable
    expect(vm.mode).toBe('t2i');
    expect(vm.references).toEqual([]);
    expect(vm.referenceUrls.image).toEqual([]);
  });

  // ── Focus images (#1782) — standalone crop copies on the node ──
  it('reads sanitized focus images off the node (i2i pool entries)', () => {
    const crop = {
      id: 'f1',
      url: 'https://cdn/crop.png',
      name: 'Img 26',
      width: 640,
      height: 360,
    };
    const nodes = [node('n1', imageView({ focusImages: [crop] }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.focusImages).toEqual([crop]);
  });

  it('drops malformed focus entries and non-array focusImages (untrusted Yjs)', () => {
    const good = {
      id: 'f2',
      url: 'https://cdn/ok.png',
      name: 'Img',
      width: 10,
      height: 10,
    };
    const nodes = [
      node(
        'n1',
        imageView({
          focusImages: [
            good,
            { id: '', url: 'https://cdn/bad.png', name: 'x', width: 1, height: 1 },
            { id: 'f3', url: 7, name: 'x', width: 1, height: 1 },
            'junk',
          ] as unknown as FocusImage[],
        }),
      ),
    ];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.focusImages).toEqual([good]);
    const nodes2 = [
      node('n1', imageView({ focusImages: 'nope' as unknown as FocusImage[] })),
    ];
    const vm2 = buildVm({ nodeId: 'n1', nodes: nodes2, edges: [], models });
    expect(vm2.focusImages).toEqual([]);
  });

  it('caps the entry COUNT — a hostile mega-array cannot ride every keystroke (round-6)', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `k${i}`,
      url: 'https://cdn/x.png',
      name: 'x',
      width: 1,
      height: 1,
    }));
    const nodes = [node('n1', imageView({ focusImages: many }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.focusImages).toHaveLength(200);
  });

  it('dedupes duplicate-id focus entries — first occurrence wins (round-3)', () => {
    const a = { id: 'k', url: 'https://cdn/a.png', name: 'a', width: 1, height: 1 };
    const b = { id: 'k', url: 'https://cdn/b.png', name: 'b', width: 1, height: 1 };
    const nodes = [node('n1', imageView({ focusImages: [a, b] }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.focusImages).toEqual([a]);
  });

  it('adds @-mentioned focus crop URLs to the i2i payload after node refs (#1782)', () => {
    const crop = {
      id: 'f1',
      url: 'https://cdn/crop.png',
      name: 'Img',
      width: 10,
      height: 10,
    };
    const nodes = [
      node('n1', imageView({ mode: 'i2i', model: 'mj-i2i', focusImages: [crop] })),
      node('src', imageView({ content: 'https://cdn/source.png' })),
    ];
    const edges = [{ id: 'src->n1', source: 'src', target: 'n1' }];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      // 目录必须真有 i2i 模型，否则 i2i 这一档在这个部署里不成立、当前档
      // 会被解析回 t2i（#1951）—— 而这条测的是 i2i 下的载荷。
      models: i2iModels,
      atMentionedSourceIds: new Set(['src', 'focus:f1']),
    });
    expect(vm.referenceUrls.image).toEqual([
      'https://cdn/source.png',
      'https://cdn/crop.png',
    ]);
    // Un-mentioned crops stay out (A, user 2026-07-16: @ is the only gate).
    const vmNone = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: i2iModels,
      atMentionedSourceIds: new Set(['src']),
    });
    expect(vmNone.referenceUrls.image).toEqual(['https://cdn/source.png']);
  });

  it('t2i sends no focus URLs even when @-mentioned (#1782 — same i2i pool rule)', () => {
    const crop = {
      id: 'f1',
      url: 'https://cdn/crop.png',
      name: 'Img',
      width: 10,
      height: 10,
    };
    const nodes = [node('n1', imageView({ mode: 't2i', focusImages: [crop] }))];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges: [],
      models,
      atMentionedSourceIds: new Set(['focus:f1']),
    });
    expect(vm.referenceUrls.image).toEqual([]);
  });

  // Malformed-catalog robustness (a malformed pricing contract, non-array model
  // list) is now enforced ONCE at the API boundary — see sanitizeModelCatalog +
  // model-catalog.schema.test.ts. buildGeneratePanelViewModel consumes the
  // sanitized, trusted ModelEntry[], so those impossible-after-boundary states
  // are no longer re-tested here. (An EMPTY catalog is a real state and stays.)

  it('yields an empty model when the catalog is empty', () => {
    // Guards the empty-catalog path: with no models the execute gate must see
    // model='' and refuse to submit an invalid task.
    const nodes = [node('n1', imageView())];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: [] });
    expect(vm.model).toBe('');
  });

  it('当前档必须是这个部署服务得了的那些之一 (#1951)', () => {
    // 节点存着 i2i，而这个目录只有 t2i 模型：以前 i2i 合法就放行，节点停在
    // 一个选择器里根本没有的档上；现在解析回可用的那个。
    expect(
      buildVm({
        nodeId: 'n1',
        nodes: [node('n1', imageView({ mode: 'i2i' }))],
        edges: [],
        models, // 只有 t2i 模型
      }).mode,
    ).toBe('t2i');
    // 存的档可用就照用，不受影响。
    expect(
      buildVm({
        nodeId: 'n1',
        nodes: [node('n1', imageView({ mode: 'i2i' }))],
        edges: [],
        models: [...models, ...i2iModels],
      }).mode,
    ).toBe('i2i');
  });

  it('excludes pure-tool models (remove_bg / upscale) from the picker', () => {
    const mixed = [
      makeModel('flux', { mode: 't2i' }), // generation
      makeModel('bg-remover', { mode: 'remove_bg', tier: 'internal' }), // tool
      makeModel('topaz', { mode: 'upscale', tier: 'internal' }), // tool
    ];
    const nodes = [node('n1', imageView())]; // default t2i
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: mixed });
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
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: mixed });
    expect(vm.model).toBe('flux');
    expect(vm.models.some((m) => m.name === 'bg-remover')).toBe(false);
  });

  it('surfaces the node status so execute can refuse while handling', () => {
    const nodes = [node('n1', imageView({ model: 'flux', status: 'handling' }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.nodeStatus).toBe('handling');
  });

  // `missing` drives the #1675 execute gate: a model whose mode needs a
  // source image (i2i / edit) must not submit with an empty image list.
  it('misses nothing for a t2i model (generates from scratch)', () => {
    const nodes = [node('n1', imageView({ model: 'flux' }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models });
    expect(vm.missing).toEqual([]);
  });

  it('misses the reference pool for an i2i model with none picked (#1675 gate)', () => {
    const nodes = [node('n1', i2iView())];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: i2iModels });
    expect(vm.missing).toEqual([['images']]);
  });

  it('misses the reference pool for an edit-capable model', () => {
    const editModels = [makeModel('nano-edit', { mode: ['i2i', 'edit'] })];
    const nodes = [node('n1', imageView({ mode: 'i2i', model: 'nano-edit' }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: editModels });
    expect(vm.missing).toEqual([['images']]);
  });

  it('misses nothing when the catalog is empty (no model resolved)', () => {
    const nodes = [node('n1', imageView())];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: [] });
    expect(vm.missing).toEqual([]);
  });

  // Round-2 adversarial: a HYBRID model (mode: ['t2i','i2i'] — real models
  // like Seedream / Flux are hybrid) offered under the t2i toggle must NOT
  // demand a source image: the ACTIVE PANEL MODE decides the submission
  // semantics, not the model's capability list. Keying the gate on the
  // capability array made t2i permanently unexecutable for hybrids (t2i
  // clears referenceUrls, so the "needs source image" gate could never pass).
  it('misses nothing for a hybrid (t2i+i2i) model running under t2i', () => {
    const hybrid = [makeModel('seedream', { mode: ['t2i', 'i2i'] })];
    const nodes = [node('n1', imageView({ mode: 't2i', model: 'seedream' }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: hybrid });
    expect(vm.missing).toEqual([]);
  });

  it('misses the pool for the same hybrid model running under i2i', () => {
    const hybrid = [makeModel('seedream', { mode: ['t2i', 'i2i'] })];
    const nodes = [node('n1', imageView({ mode: 'i2i', model: 'seedream' }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: hybrid });
    expect(vm.missing).toEqual([['images']]);
  });
});

describe('resolveModeSwitch — model + params to persist on a mode toggle', () => {
  const catalog = [
    makeModel('flux-t2i', { mode: 't2i' }),
    makeModel('mj-i2i', { mode: 'i2i' }),
    makeModel('nano-i2i', { mode: ['i2i'], tier: 'recommended' }),
  ];

  it('resolves the target mode\'s FIRST model when there is no memory (user 2026-07-11)', () => {
    const r = resolveModeSwitch({ modelByMode: {} }, 'i2i', catalog);
    // mj-i2i is first for i2i; nano-i2i's recommended badge does not promote it.
    expect(r.model).toBe('mj-i2i');
  });

  it('restores the target mode\'s remembered model over the first', () => {
    const r = resolveModeSwitch(
      { modelByMode: { i2i: 'nano-i2i' } },
      'i2i',
      catalog,
    );
    expect(r.model).toBe('nano-i2i'); // remembered i2i pick beats list order
  });

  it('gives the target mode’s model its OWN params, not the outgoing mode’s (#1948)', () => {
    // t2i was left on a 2k resolution; the i2i model has never been used, so
    // it starts from its own default. 2k is a value this model never offered
    // — carrying it in is what put users on a resolution nobody chose.
    const t2i = makeModel('mj-t2i', {
      mode: 't2i',
      params: {
        resolution: { description: '', values: ['1k', '2k'], default: '2k' },
      },
    });
    const i2i = makeModel('nano-edit', {
      mode: 'i2i',
      params: {
        resolution: {
          description: '',
          values: ['1k', '2k', '4k'],
          default: '1k',
        },
      },
    });
    const r = resolveModeSwitch(
      {
        modelByMode: {},
        paramsByModel: { 'mj-t2i': { resolution: '2k' } },
      },
      'i2i',
      [t2i, i2i],
    );
    expect(r.model).toBe('nano-edit');
    expect(r.paramsByModel[r.model]?.resolution).toBe('1k');
  });

  it('restores the target model’s own record when it has one', () => {
    const r = resolveModeSwitch(
      {
        modelByMode: { i2i: 'nano-i2i' },
        paramsByModel: {
          'flux-t2i': { aspect_ratio: '1:1' },
          'nano-i2i': { aspect_ratio: '16:9' },
        },
      },
      'i2i',
      catalog,
    );
    expect(r.paramsByModel[r.model]?.aspect_ratio).toBe('16:9');
  });

  it('keeps the camera cluster on the model that declares it (#1948)', () => {
    // The round trip user 2026-07-18 asked for, now guaranteed by the record
    // rather than by carrying undeclared keys along: the camera model's own
    // record still holds them when the user comes back to it.
    const CAMERA = {
      description: '',
      values: ['Canon EOS R5', 'Sony A7'],
      default: 'Canon EOS R5',
    };
    const withCamera = makeModel('nano-i2i', {
      mode: 'i2i',
      params: { aspect_ratio: { description: '', values: ['1:1'], default: '1:1' }, camera: CAMERA },
    });
    const plain = makeModel('flux-t2i', { mode: 't2i' });
    const r = resolveModeSwitch(
      {
        modelByMode: { i2i: 'nano-i2i' },
        paramsByModel: { 'nano-i2i': { camera: 'Sony A7' } },
      },
      'i2i',
      [plain, withCamera],
    );
    expect(r.paramsByModel[r.model]?.camera).toBe('Sony A7');
  });

  it('keeps the other models’ records while adding the incoming one (#1948)', () => {
    // 不是迁移 —— 老节点一律不管（user 2026-08-15）。这条钉的是「换模式时别
    // 把别的模型的记录丢了」，切回去才找得到。
    const r = resolveModeSwitch(
      {
        modelByMode: {},
        paramsByModel: { 'flux-t2i': { aspect_ratio: '16:9' } },
      },
      'i2i',
      catalog,
    );
    expect(r.paramsByModel['flux-t2i']?.aspect_ratio).toBe('16:9');
    expect(r.paramsByModel['mj-i2i']?.aspect_ratio).toBe('1:1'); // its own default
  });

  it('yields an empty model when the target mode offers nothing', () => {
    const t2iOnly = [makeModel('flux-t2i', { mode: 't2i' })];
    const r = resolveModeSwitch({ modelByMode: {} }, 'i2i', t2iOnly);
    expect(r.model).toBe('');
    expect(r.paramsByModel).toEqual({});
  });
});

describe('buildGeneratePanelViewModel — the pool cap (#1735 count gate)', () => {
  it('exposes the active model pool param max_items as its image cap', () => {
    const capped = makeModel('nano-edit', {
      mode: 'i2i',
      params: { images: { description: '', default: null, fill: 'pool', accepts: 'image', max_items: 3 } },
    });
    const vm = buildVm({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ mode: 'i2i', model: 'nano-edit' }))],
      edges: [],
      models: [capped],
    });
    expect(vm.model).toBe('nano-edit');
    expect(vm.pool.image?.cap).toBe(3);
  });

  it('has no pool when the active model declares none', () => {
    // The default makeModel params carry aspect_ratio / resolution — no pool.
    const vm = buildVm({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ mode: 't2i', model: 'flux' }))],
      edges: [],
      models: [makeModel('flux', { mode: 't2i' })],
    });
    expect(vm.pool).toEqual({});
  });

  it('treats a non-positive images max_items as uncapped (undefined) — aligns with the server rule + worker guard', () => {
    // 0 / negative / NaN all mean "uncapped" server-side (reference-count.ts
    // limit >= 1) and worker-side (truthy spec.max_items). The frontend must
    // agree, or a max_items: 0 would block every submit with a nonsensical
    // "limit: 0" toast while the server accepts it.
    for (const cap of [0, -1, Number.NaN]) {
      const vm = buildVm({
        nodeId: 'n1',
        nodes: [node('n1', imageView({ mode: 'i2i', model: 'nano-edit' }))],
        edges: [],
        models: [
          makeModel('nano-edit', {
            mode: 'i2i',
            params: { images: { description: '', default: null, fill: 'pool', accepts: 'image', max_items: cap } },
          }),
        ],
      });
      expect(vm.pool.image?.cap).toBeUndefined();
    }
  });
});

// #1966: 图片面板此前把这个答案写死成 true，写死在容器里、而且写死了两处
// （按钮闸门和提交前的复核）。当时那么写有理由：判据是「模型有没有声明
// params.prompt」，而一个图片模型都没声明过，照搬会把整个图片目录判成不要
// 提示词。现在模型自己说，两个面板读同一个字段。
describe('promptRequired 读模型自己的声明 (#1966)', () => {
  it('模型说吃提示词就是 true', () => {
    const models = [makeModel('m-yes', { takes_prompt: true })];
    const nodes = [node('n1', imageView({ model: 'm-yes' }))];
    expect(buildVm({ nodeId: 'n1', nodes, edges: [], models }).promptRequired).toBe(true);
  });

  it('模型说不吃就是 false，跟模式名无关', () => {
    const models = [makeModel('m-no', { takes_prompt: false })];
    const nodes = [node('n1', imageView({ model: 'm-no' }))];
    expect(buildVm({ nodeId: 'n1', nodes, edges: [], models }).promptRequired).toBe(false);
  });

  // 跟视频面板同一条兜底：认不出的模型不是「可以少一道要求」的许可。
  it('目录里一个模型都没有时回落到 true', () => {
    const nodes = [node('n1', imageView({ model: 'gone' }))];
    expect(buildVm({ nodeId: 'n1', nodes, edges: [], models: [] }).promptRequired).toBe(true);
  });
});

describe('the style slot (inner#826)', () => {
  const style = (optional: boolean) => ({
    description: '',
    default: null,
    type: 'list' as const,
    max_items: 3,
    fill: 'canvas' as const,
    accepts: 'image' as const,
    ...(optional ? { optional: true } : {}),
  });
  const krea = makeModel('krea', { params: { style_images: style(true) } });
  const recraft = makeModel('recraft', { params: { style_images: style(false) } });
  const plain = makeModel('plain');

  it('puts the node\'s style images into the params every reader takes', () => {
    const nodes = [node('n1', imageView({ model: 'krea', styleImageUrls: ['s1', 's2'] }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: [krea] });
    expect(vm.params.style_images).toEqual(['s1', 's2']);
    expect(vm.styleCap).toBe(3);
    expect(vm.slots).toEqual(['style']);
  });

  it('leaves style images out for a model that declares no style slot', () => {
    const nodes = [node('n1', imageView({ model: 'plain', styleImageUrls: ['s1'] }))];
    const vm = buildVm({ nodeId: 'n1', nodes, edges: [], models: [plain] });
    expect(vm.params.style_images).toBeUndefined();
    expect(vm.styleCap).toBeUndefined();
    expect(vm.slots).toEqual([]);
  });

  it('draws no style slot when the declaration gives no usable cap', () => {
    const uncapped = makeModel('uncapped', { params: { style_images: { ...style(true), max_items: 0 } } });
    const vm = buildVm({ nodeId: 'n1', nodes: [node('n1', imageView({ model: 'uncapped', styleImageUrls: ['s1'] }))], edges: [], models: [uncapped] });
    expect(vm.styleCap).toBeUndefined();
    expect(vm.slots).toEqual([]);
  });

  it('counts a required style slot as missing until an image is in it', () => {
    const empty = buildVm({ nodeId: 'n1', nodes: [node('n1', imageView({ model: 'recraft' }))], edges: [], models: [recraft] });
    expect(empty.missing).toEqual([['style_images']]);
    const filled = buildVm({
      nodeId: 'n1',
      nodes: [node('n1', imageView({ model: 'recraft', styleImageUrls: ['s1'] }))],
      edges: [],
      models: [recraft],
    });
    expect(filled.missing).toEqual([]);
  });
});
