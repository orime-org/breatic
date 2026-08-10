// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';
import {
  buildVideoPanelViewModel,
  nodeVideoMode,
  resolveVideoModeSwitch,
  selectVideoModeModels,
} from '@web/spaces/canvas/generate/video-panel-view-model';

/**
 * Builds a video ModelEntry fixture carrying only the fields the view model
 * reads. Defaults mirror a real t2v entry (`veo-3.1`): the four param groups
 * the video panel renders. One of them, `duration`, is stated as a RANGE by
 * `kling-o3-pro` and as a list by everything else the panel offers — see the
 * per-case override.
 * @param name - Model id.
 * @param over - Overrides (mode, tier, cost_per_call, params).
 * @returns A minimal video ModelEntry.
 */
function makeModel(name: string, over: Partial<ModelEntry> = {}): ModelEntry {
  const mode = over.mode ?? 't2v';
  return {
    name,
    display_name: name.toUpperCase(),
    modality: 'video',
    description: '',
    guide: '',
    tier: 'optional',
    cost_per_call: 40,
    generation_time: 120,
    params: {
      aspect_ratio: { description: '', values: ['16:9', '9:16'], default: '16:9' },
      resolution: { description: '', values: ['720p', '1080p'], default: '720p' },
      duration: { description: '', values: [4, 6, 8], default: 8 },
      generate_audio: { description: '', values: [true, false], default: true },
    },
    providers: [],
    ...over,
    mode,
    sourcesByMode:
      over.sourcesByMode ??
      Object.fromEntries(
        (Array.isArray(mode) ? mode : [mode]).map((m) => [
          m,
          m === 't2v' ? [] : (['image'] as const),
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

/**
 * A video node view carrying generate inputs.
 * @param over - Overrides on the video view.
 * @returns The video node view.
 */
function videoView(
  over: Partial<Extract<NodeView, { kind: 'video' }>> = {},
): NodeView {
  return { kind: 'video', status: 'idle', ...over };
}

describe('selectVideoModeModels', () => {
  // The video catalog carries entries that are NOT generation: upscale,
  // interpolate, extend, edit and motion all belong to the mini-tool system
  // (design 2026-08-08 §3.1). Offering them in the panel would put "Video
  // Upscale Pro" in the text-to-video picker and the submit would be refused
  // by the backend source gate.
  const catalog = [
    makeModel('veo-3.1', { mode: 't2v' }),
    makeModel('kling-o3-pro-i2v', { mode: 'i2v' }),
    makeModel('video-upscale-pro', { mode: 'upscale' }),
    makeModel('rife-interpolation', { mode: 'interpolate' }),
    makeModel('veo-3.1-extend', { mode: 'extend' }),
    makeModel('kling-o3-pro-edit', { mode: 'edit' }),
    makeModel('kling-v3-pro-motion', { mode: 'motion' }),
  ];

  it('drops the non-generation video modes', () => {
    expect(selectVideoModeModels(catalog, 't2v').map((m) => m.name)).toEqual([
      'veo-3.1',
    ]);
  });

  it('narrows to the active mode', () => {
    expect(selectVideoModeModels(catalog, 'i2v').map((m) => m.name)).toEqual([
      'kling-o3-pro-i2v',
    ]);
  });

  it('keeps a multi-mode model under every generation mode it declares', () => {
    const hybrid = makeModel('hybrid', { mode: ['t2v', 'i2v'] });
    expect(selectVideoModeModels([hybrid], 't2v').map((m) => m.name)).toEqual([
      'hybrid',
    ]);
    expect(selectVideoModeModels([hybrid], 'i2v').map((m) => m.name)).toEqual([
      'hybrid',
    ]);
  });

  it('returns an empty list for a mode nothing is configured for', () => {
    // `first_last` has no configured model yet (its config lands with the
    // first-last-frame slice) — narrowing must yield nothing, not everything.
    expect(selectVideoModeModels(catalog, 'first_last')).toEqual([]);
  });

  it('preserves catalog order', () => {
    const reordered = [
      makeModel('b', { mode: 't2v' }),
      makeModel('a', { mode: 't2v' }),
    ];
    expect(selectVideoModeModels(reordered, 't2v').map((m) => m.name)).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('buildVideoPanelViewModel', () => {
  const models = [
    makeModel('veo-3.1', { mode: 't2v', cost_per_call: 88 }),
    makeModel('veo-3.1-lite', { mode: 't2v', cost_per_call: 21 }),
    makeModel('kling-o3-pro-i2v', { mode: 'i2v', cost_per_call: 56 }),
    makeModel('video-upscale-pro', { mode: 'upscale', cost_per_call: 4 }),
  ];

  it('picks from the active mode only, never from another mode or a mini-tool entry', () => {
    // The list itself is `selectVideoModeModels`, covered above. What this
    // pins is that the effective model comes out of that narrowing: the
    // i2v and upscale entries sit earlier and later in the catalog and
    // neither may win.
    const nodes = [node('n1', videoView())];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models: [
        makeModel('video-upscale-pro', { mode: 'upscale', cost_per_call: 4 }),
        makeModel('kling-o3-pro-i2v', { mode: 'i2v', cost_per_call: 56 }),
        ...models,
      ],
      mode: 't2v',
    });
    expect(vm.model).toBe('veo-3.1');
  });

  it('uses the stored model when the active mode offers it', () => {
    const nodes = [node('n1', videoView({ model: 'veo-3.1-lite' }))];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.model).toBe('veo-3.1-lite');
    expect(vm.creditEstimate).toBe(21);
  });

  it('falls back to the first offered model when none is stored', () => {
    const nodes = [node('n1', videoView())];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.model).toBe('veo-3.1');
    expect(vm.creditEstimate).toBe(88);
  });

  it('falls back to the first offered model when the stored one is not offered here', () => {
    // A model the panel does not offer under this mode (another mode's pick,
    // or one dropped from the catalog) must never be the effective model:
    // submitting it would be refused by the backend source gate.
    const nodes = [node('n1', videoView({ model: 'kling-o3-pro-i2v' }))];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.model).toBe('veo-3.1');
  });

  it('resolves no model and no params when the mode offers nothing', () => {
    const nodes = [node('n1', videoView({ model: 'veo-3.1' }))];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models,
      mode: 'talking_head',
    });
    expect(vm.model).toBe('');
    expect(vm.params).toEqual({});
    expect(vm.creditEstimate).toBe(0);
  });

  it('reconciles stored params against the effective model', () => {
    const nodes = [
      node(
        'n1',
        videoView({
          model: 'veo-3.1',
          // `2:1` is not offered by this model → falls back to its default;
          // `1080p` is offered → kept.
          params: { aspect_ratio: '2:1', resolution: '1080p' },
        }),
      ),
    ];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.params.aspect_ratio).toBe('16:9');
    expect(vm.params.resolution).toBe('1080p');
    expect(vm.params.duration).toBe(8);
    expect(vm.params.generate_audio).toBe(true);
  });

  it('keeps a range-shaped duration the model declares as min/max', () => {
    // `kling-o3-pro` states duration as bounds, not a list. The panel
    // must still carry a duration value for them (the picker expands the
    // range) — dropping it would leave the submitted payload without one.
    const ranged = makeModel('kling-o3-pro', {
      mode: 't2v',
      params: {
        aspect_ratio: { description: '', values: ['16:9'], default: '16:9' },
        duration: { description: '', min: 3, max: 15, default: 5 },
      },
    });
    const nodes = [node('n1', videoView({ params: { duration: 12 } }))];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models: [ranged],
      mode: 't2v',
    });
    expect(vm.params.duration).toBe(12);
  });

  it('reports the node status so the panel can block submitting mid-generation', () => {
    const nodes = [node('n1', videoView({ status: 'handling' }))];
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.nodeStatus).toBe('handling');
  });

  it('resolves a default model for a node that is not on the canvas', () => {
    const vm = buildVideoPanelViewModel({
      nodeId: 'missing',
      nodes: [],
      models,
      mode: 't2v',
    });
    expect(vm.nodeStatus).toBeUndefined();
    expect(vm.model).toBe('veo-3.1');
  });

  it('resolves nothing when the catalog holds no generatable video model', () => {
    // A catalog of mini-tool entries only. Nothing to pick, nothing to price,
    // and no params to reconcile against — the panel's execute gate reads the
    // empty model and stays shut.
    const vm = buildVideoPanelViewModel({
      nodeId: 'n1',
      nodes: [node('n1', videoView())],
      models: [makeModel('video-upscale-pro', { mode: 'upscale' })],
      mode: 't2v',
    });
    expect(vm.model).toBe('');
    expect(vm.creditEstimate).toBe(0);
    expect(vm.params).toEqual({});
  });
});

describe('buildVideoPanelViewModel — source requirements (#1896 slice 2)', () => {
  const models = [
    makeModel('veo-3.1', { mode: 't2v' }),
    makeModel('kling-o3-pro-i2v', { mode: 'i2v' }),
  ];

  it('reads whether the active mode needs a source off the wire, not a local rule', () => {
    // `sourcesByMode` is computed backend-side (domain/source-requirement.ts)
    // and ships on the catalog entry, so the panel never re-derives the rule.
    // Text-to-video needs nothing; image-to-video needs an image.
    const nodes = [node('n1', videoView())];
    expect(
      buildVideoPanelViewModel({ nodeId: 'n1', nodes, models, mode: 't2v' })
        .requiresSource,
    ).toBe(false);
    expect(
      buildVideoPanelViewModel({ nodeId: 'n1', nodes, models, mode: 'i2v' })
        .requiresSource,
    ).toBe(true);
  });

  it('says no source is required when no model resolves', () => {
    // An empty catalog leaves no model to read the requirement off. Claiming a
    // source IS required would block execute for a reason the user cannot act
    // on; the model gate already stops the submit.
    const nodes = [node('n1', videoView())];
    expect(
      buildVideoPanelViewModel({ nodeId: 'n1', nodes, models: [], mode: 'i2v' })
        .requiresSource,
    ).toBe(false);
  });

  it('carries the picked first frame through from node data', () => {
    const nodes = [node('n1', videoView({ firstFrameUrl: 'https://cdn/f.png' }))];
    expect(
      buildVideoPanelViewModel({ nodeId: 'n1', nodes, models, mode: 'i2v' })
        .firstFrameUrl,
    ).toBe('https://cdn/f.png');
  });

  it('drops a first frame that is not a usable URL', () => {
    // The slot's value is collaborative Yjs data — untrusted. A malformed
    // one reaching the payload sends `params.image` as something the provider
    // rejects AFTER the task is accepted and billed; an empty string passes
    // `typeof === 'string'` but is no URL either. Same guard the style slot
    // has carried since #1664.
    const bad = (value: unknown): unknown =>
      buildVideoPanelViewModel({
        nodeId: 'n1',
        nodes: [
          node(
            'n1',
            videoView({ firstFrameUrl: value } as Partial<
              Extract<NodeView, { kind: 'video' }>
            >),
          ),
        ],
        models,
        mode: 'i2v',
      }).firstFrameUrl;
    expect(bad('')).toBeUndefined();
    expect(bad(42)).toBeUndefined();
    expect(bad({ url: 'https://cdn/f.png' })).toBeUndefined();
    expect(bad(null)).toBeUndefined();
  });

  it('leaves the first frame undefined when the node has none', () => {
    const nodes = [node('n1', videoView())];
    expect(
      buildVideoPanelViewModel({ nodeId: 'n1', nodes, models, mode: 'i2v' })
        .firstFrameUrl,
    ).toBeUndefined();
  });

});

describe('nodeVideoMode', () => {
  it('reads the stored mode off the node, defaulting to text-to-video', () => {
    // The node stores ONE `mode` field shared with the image panel's own mode
    // set, so a video node opened for the first time has none — and a value
    // this panel does not offer (an image mode, or a mini-tool video mode)
    // must not be honoured either: it would narrow the model list to nothing
    // and leave the panel with no model to submit.
    expect(nodeVideoMode([node('n1', videoView())], 'n1')).toBe('t2v');
    expect(nodeVideoMode([node('n1', videoView({ mode: 'i2v' }))], 'n1')).toBe(
      'i2v',
    );
    expect(nodeVideoMode([node('n1', videoView({ mode: 't2i' }))], 'n1')).toBe(
      't2v',
    );
    expect(
      nodeVideoMode([node('n1', videoView({ mode: 'upscale' }))], 'n1'),
    ).toBe('t2v');
  });

  it('defaults for a node that is not on the board', () => {
    // A collaborator can delete the node under an open panel; the read has to
    // answer something the panel can render rather than throw.
    expect(nodeVideoMode([], 'gone')).toBe('t2v');
  });

  it('defaults for a node kind that carries no generate inputs', () => {
    // Annotations and groups have no `mode` at all.
    expect(nodeVideoMode([node('n1', { kind: 'group' })], 'n1')).toBe('t2v');
  });
});

describe('resolveVideoModeSwitch', () => {
  const t2v = makeModel('veo', { mode: 't2v' });
  const both = makeModel('kling', { mode: ['t2v', 'i2v'] });
  const i2v = makeModel('wan', { mode: 'i2v' });

  it('restores the model remembered under the TARGET mode', () => {
    const content = { modelByMode: { i2v: 'wan' }, params: {} };
    expect(resolveVideoModeSwitch(content, 'i2v', [t2v, both, i2v]).model).toBe(
      'wan',
    );
  });

  it('falls back to the first model the target mode offers', () => {
    expect(resolveVideoModeSwitch(undefined, 'i2v', [t2v, both, i2v]).model).toBe(
      'kling',
    );
  });

  it('never carries the outgoing mode’s model across', () => {
    // `veo` is the current pick and belongs to t2v alone. Carrying it into
    // i2v would submit a model the mode does not offer, which the backend
    // source gate refuses.
    const content = { modelByMode: { t2v: 'veo' }, params: {} };
    expect(resolveVideoModeSwitch(content, 'i2v', [t2v, both, i2v]).model).toBe(
      'kling',
    );
  });

  it('reconciles params against the resolved model', () => {
    // A value the target model still allows survives the switch; one it does
    // not falls back to that model's default. A param the model never declares
    // is preserved rather than dropped (user 2026-07-18): the param set lives
    // on the node independently of which model is active, and the worker drops
    // undeclared params at generation time, so nothing leaks upstream.
    const content = {
      modelByMode: {},
      params: { aspect_ratio: '9:16', resolution: '4k', keptForLater: 'x' },
    };
    const { params } = resolveVideoModeSwitch(content, 'i2v', [both]);
    expect(params.aspect_ratio).toBe('9:16');
    expect(params.resolution).toBe('720p');
    expect(params.keptForLater).toBe('x');
  });

  it('returns an empty model when the target mode offers none', () => {
    // The container bails on this rather than writing it: an empty model plus
    // empty params would clobber what the node had stored, and params do not
    // self-heal.
    expect(resolveVideoModeSwitch(undefined, 'i2v', [t2v])).toEqual({
      model: '',
      params: {},
    });
  });
});
