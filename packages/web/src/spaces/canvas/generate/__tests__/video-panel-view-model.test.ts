// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';
import type { VideoGenMode } from '@web/spaces/canvas/generate/video-panel-view-model';
import { resolveModeSwitch } from '@web/spaces/canvas/generate/mode-selection';
import {
  buildVideoPanelViewModel,
  nodeVideoMode,
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

/** No edges, which is what a case about models / params / slots wants. */
const NO_EDGES: CanvasEdge[] = [];

/**
 * Shared empty text map. The rail's rows carry what a referenced TEXT node
 * says, and no case here is about that — but the parameter is required at the
 * real call sites so that omitting it can never blank every text reference by
 * accident (#1774 round-6), so it is stated rather than defaulted away.
 */
const NO_TEXT: ReadonlyMap<string, string> = new Map();

/**
 * Builds the view model, filling in the reference inputs a case does not care
 * about.
 * @param input - Everything the view model takes; edges and text default to empty.
 * @returns The derived view model.
 */
function buildVm(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  models: ModelEntry[];
  mode: VideoGenMode;
  edges?: ReadonlyArray<CanvasEdge>;
  textById?: ReadonlyMap<string, string>;
  atMentionedSourceIds?: ReadonlySet<string>;
}): ReturnType<typeof buildVideoPanelViewModel> {
  return buildVideoPanelViewModel({
    ...input,
    edges: input.edges ?? NO_EDGES,
    textById: input.textById ?? NO_TEXT,
  });
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

describe('buildVideoPanelViewModel — 渲染时按本模式记住的模型解析 (#1948 9.10)', () => {
  // 两个面板在这件事上必须一致。视频侧此前少了中间那层（存的模型不在本模式
  // 列表里时直接掉到第一个，不查 modelByMode），#1948 收成共用的
  // pickModelForMode 补上。
  //
  // 这条钉的是视图模型真的调了它 —— 纯函数那侧钉的是「给对了参数会怎样」，
  // 钉不住「视图模型给没给」：Gate 2 第 4 轮实测把这处退回内联三元，684 条
  // 测试没有一条变红。
  const veo = makeModel('veo', { mode: 't2v' });
  const kling = makeModel('kling', { mode: 't2v' });

  it('存的模型不在本模式列表里时，恢复用户在这个模式下选过的那个', () => {
    // 这个状态由两个写入函数的不对称造出来：setNodeModel 只写 model，
    // setNodeMode 写 mode + model，协作时一个人挑模型撞上另一个人切模式。
    const vm = buildVm({
      nodeId: 'n1',
      nodes: [
        node(
          'n1',
          videoView({ model: 'gone-from-this-mode', modelByMode: { t2v: 'kling' } }),
        ),
      ],
      models: [veo, kling],
      mode: 't2v',
    });
    // 不是 veo（列表第一个），是用户自己在 t2v 下选过的 kling。
    expect(vm.model).toBe('kling');
  });

  it('存的和记住的都不在列表里时才落到第一个', () => {
    const vm = buildVm({
      nodeId: 'n1',
      nodes: [
        node('n1', videoView({ model: 'gone', modelByMode: { t2v: 'also-gone' } })),
      ],
      models: [veo, kling],
      mode: 't2v',
    });
    expect(vm.model).toBe('veo');
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
    const vm = buildVm({
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
    const vm = buildVm({
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
    const vm = buildVm({
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
    // submitting it would generate from the prompt alone, ignoring the source
    // the mode is named after.
    const nodes = [node('n1', videoView({ model: 'kling-o3-pro-i2v' }))];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.model).toBe('veo-3.1');
  });

  it('resolves no model and no params when the mode offers nothing', () => {
    const nodes = [node('n1', videoView({ model: 'veo-3.1' }))];
    const vm = buildVm({
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
          paramsByModel: {
            'veo-3.1': { aspect_ratio: '2:1', resolution: '1080p' },
          },
        }),
      ),
    ];
    const vm = buildVm({
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
    // `model` is what a real node always carries alongside `params`: both are
    // written together by setNodeModel, and node-factory creates neither. Since
    // #1948 a param set belongs to a model, so a fixture without one describes
    // a node that cannot exist — and would be read as "nothing to migrate".
    const nodes = [
      node(
        'n1',
        videoView({
          model: 'kling-o3-pro',
          paramsByModel: { 'kling-o3-pro': { duration: 12 } },
        }),
      ),
    ];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      models: [ranged],
      mode: 't2v',
    });
    expect(vm.params.duration).toBe(12);
  });

  it('reports the node status so the panel can block submitting mid-generation', () => {
    const nodes = [node('n1', videoView({ status: 'handling' }))];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      models,
      mode: 't2v',
    });
    expect(vm.nodeStatus).toBe('handling');
  });

  it('resolves a default model for a node that is not on the canvas', () => {
    const vm = buildVm({
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
    const vm = buildVm({
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

  it('collects the slots the active mode states, not a rule of its own', () => {
    // What a mode sends upstream is a fixed set of fields, and it states that
    // set itself (#1904). Text-to-video collects nothing; image-to-video the
    // first frame; first-last frame both, in the order they are shown.
    const nodes = [node('n1', videoView())];
    const slotsIn = (mode: VideoGenMode): readonly string[] =>
      buildVm({ nodeId: 'n1', nodes, models, mode }).slots;
    expect(slotsIn('t2v')).toEqual([]);
    expect(slotsIn('i2v')).toEqual(['firstFrame']);
    expect(slotsIn('first_last')).toEqual(['firstFrame', 'endFrame']);
  });

  it('echoes the mode back, so the payload is built from the same one', () => {
    const nodes = [node('n1', videoView())];
    expect(
      buildVm({ nodeId: 'n1', nodes, models, mode: 'first_last' })
        .mode,
    ).toBe('first_last');
  });

  it('carries both picked frames through from node data', () => {
    const nodes = [
      node(
        'n1',
        videoView({
          firstFrameUrl: 'https://cdn/f.png',
          endFrameUrl: 'https://cdn/l.png',
        }),
      ),
    ];
    expect(
      buildVm({ nodeId: 'n1', nodes, models, mode: 'first_last' })
        .slotUrls,
    ).toEqual({
      firstFrame: 'https://cdn/f.png',
      endFrame: 'https://cdn/l.png',
    });
  });

  it('shows the driving video by its poster, never by the video URL (#1918)', () => {
    // The toolbar paints a filled slot with an `<img>`. Handed the mp4 it
    // draws nothing at all — and with `alt=''` not even a broken-image
    // marker, just a blank square where the pick should be. So the slot
    // copies the node's poster at pick time and the panel shows that.
    const nodes = [
      node(
        'n1',
        videoView({
          drivingVideo: {
            url: 'https://cdn/driving.mp4',
            cover: 'https://cdn/driving-cover.png',
          },
        }),
      ),
    ];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      models,
      mode: 'animate',
    });
    // What goes upstream is still the video itself.
    expect(vm.slotUrls.drivingVideo).toBe('https://cdn/driving.mp4');
    expect(vm.slotThumbnails.drivingVideo).toBe('https://cdn/driving-cover.png');
  });

  it('shows an image slot its own pick, with no poster in between', () => {
    const nodes = [
      node('n1', videoView({ characterImageUrl: 'https://cdn/c.png' })),
    ];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      models,
      mode: 'animate',
    });
    expect(vm.slotThumbnails.characterImage).toBe('https://cdn/c.png');
  });

  it('leaves a driving video with no poster showing nothing rather than the mp4', () => {
    // A video node that has not got its poster yet. Falling back to the asset
    // URL would put the blank square back; leaving the thumbnail absent lets
    // the toolbar cover the slot with the video node's icon instead (#1946).
    const nodes = [
      node('n1', videoView({ drivingVideo: { url: 'https://cdn/driving.mp4' } })),
    ];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      models,
      mode: 'animate',
    });
    expect(vm.slotUrls.drivingVideo).toBe('https://cdn/driving.mp4');
    expect(vm.slotThumbnails.drivingVideo).toBeUndefined();
  });

  it('keeps reading a slot the active mode does not collect', () => {
    // A pick survives a mode switch — either frame can be changed whenever
    // (user 2026-08-10) — so the panel still sees it. What the mode decides is
    // which of these reach the payload, and that decision is made there.
    const nodes = [
      node('n1', videoView({ endFrameUrl: 'https://cdn/l.png' })),
    ];
    expect(
      buildVm({ nodeId: 'n1', nodes, models, mode: 'i2v' })
        .slotUrls.endFrame,
    ).toBe('https://cdn/l.png');
  });

  it('drops a slot value that is not a usable URL', () => {
    // Slot values are collaborative Yjs data — untrusted. A malformed one
    // reaching the payload sends a source param the provider rejects AFTER the
    // task is accepted and billed; an empty string passes `typeof === 'string'`
    // but is no URL either. Same guard the style slot has carried since #1664.
    const bad = (value: unknown): unknown =>
      buildVm({
        nodeId: 'n1',
        nodes: [
          node(
            'n1',
            videoView({ endFrameUrl: value } as Partial<
              Extract<NodeView, { kind: 'video' }>
            >),
          ),
        ],
        models,
        mode: 'first_last',
      }).slotUrls.endFrame;
    expect(bad('')).toBeUndefined();
    expect(bad(42)).toBeUndefined();
    expect(bad({ url: 'https://cdn/f.png' })).toBeUndefined();
    expect(bad(null)).toBeUndefined();
  });

  it('reports an empty slot map when the node has no picks', () => {
    const nodes = [node('n1', videoView())];
    expect(
      buildVm({ nodeId: 'n1', nodes, models, mode: 'first_last' })
        .slotUrls,
    ).toEqual({});
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

describe('resolveModeSwitch — 视频侧的六个模式 (#1948 起两个面板共用)', () => {
  const t2v = makeModel('veo', { mode: 't2v' });
  const both = makeModel('kling', { mode: ['t2v', 'i2v'] });
  const i2v = makeModel('wan', { mode: 'i2v' });

  it('restores the model remembered under the TARGET mode', () => {
    const content = { modelByMode: { i2v: 'wan' }, params: {} };
    expect(resolveModeSwitch(content, 'i2v', [t2v, both, i2v]).model).toBe(
      'wan',
    );
  });

  it('falls back to the first model the target mode offers', () => {
    expect(resolveModeSwitch(undefined, 'i2v', [t2v, both, i2v]).model).toBe(
      'kling',
    );
  });

  it('never carries the outgoing mode’s model across', () => {
    // `veo` is the current pick and belongs to t2v alone. Carrying it into
    // i2v would submit a model that ignores the first frame and generates
    // from the prompt alone — and the backend would NOT stop it, because its
    // source gate passes any model with a source-less mode.
    const content = { modelByMode: { t2v: 'veo' }, params: {} };
    expect(resolveModeSwitch(content, 'i2v', [t2v, both, i2v]).model).toBe(
      'kling',
    );
  });

  it('gives the target mode’s model its OWN params, not the outgoing mode’s (#1948)', () => {
    // The defect this slice fixes, in its smallest form. `animate` left
    // resolution=480p on the node; the model i2v resolves to has never been
    // used, so it must start from its own default — 480p is a value nobody
    // chose, it is just what the previous mode's model defaults to.
    const animate = makeModel('wan', {
      mode: 'animate',
      params: {
        resolution: { description: '', values: ['480p', '720p'], default: '480p' },
      },
    });
    const seedance = makeModel('seedance', {
      mode: 'i2v',
      params: {
        resolution: {
          description: '',
          values: ['480p', '720p', '1080p'],
          default: '720p',
        },
      },
    });
    const content = {
      model: 'wan',
      modelByMode: { i2v: 'seedance' },
      params: { resolution: '480p' },
      paramsByModel: { wan: { resolution: '480p' } },
    };
    const { model, paramsByModel } = resolveModeSwitch(content, 'i2v', [
      animate,
      seedance,
    ]);
    expect(model).toBe('seedance');
    expect(paramsByModel[model]?.resolution).toBe('720p');
  });

  it('restores the target model’s own record when it has one', () => {
    const content = {
      modelByMode: { i2v: 'wan' },
      paramsByModel: { veo: { aspect_ratio: '16:9' }, wan: { aspect_ratio: '9:16' } },
    };
    const { model, paramsByModel } = resolveModeSwitch(content, 'i2v', [
      t2v,
      both,
      i2v,
    ]);
    expect(paramsByModel[model]?.aspect_ratio).toBe('9:16');
  });

  it('keeps one record for a model offered under two modes (#1948)', () => {
    // `kling-o3-pro-i2v` and `seedance-1.5-pro-i2v` each serve i2v AND
    // first_last in the real catalog, and each declares ONE param set —
    // splitting the record per mode would invent a distinction the model
    // never made. The switch here targets the OTHER of its two modes, which
    // is the only way this differs from the case above.
    const dual = makeModel('kling', { mode: ['i2v', 'first_last'] });
    const content = {
      model: 'kling',
      modelByMode: { i2v: 'kling', first_last: 'kling' },
      params: { aspect_ratio: '9:16' },
      paramsByModel: { kling: { aspect_ratio: '9:16' } },
    };
    const { model, paramsByModel } = resolveModeSwitch(content, 'first_last', [
      t2v,
      dual,
    ]);
    expect(model).toBe('kling');
    expect(paramsByModel[model]?.aspect_ratio).toBe('9:16');
  });

  it('keeps the other models’ records while adding the incoming one (#1948)', () => {
    // 不是迁移 —— 老节点一律不管（user 2026-08-15）。这条钉的是「换模式时别
    // 把别的模型的记录丢了」，切回去才找得到。
    const content = {
      modelByMode: { i2v: 'wan' },
      paramsByModel: { veo: { aspect_ratio: '9:16' } },
    };
    const { paramsByModel } = resolveModeSwitch(content, 'i2v', [
      t2v,
      both,
      i2v,
    ]);
    expect(paramsByModel.veo?.aspect_ratio).toBe('9:16');
    expect(paramsByModel.wan?.aspect_ratio).toBe('16:9'); // wan's own default
  });

  it('returns an empty model when the target mode offers none', () => {
    // The container bails on this rather than writing it: an empty model plus
    // empty params would clobber what the node had stored, and params do not
    // self-heal.
    expect(resolveModeSwitch(undefined, 'i2v', [t2v])).toEqual({ model: '', paramsByModel: {} });
  });
});

/**
 * #1927 — the reference rail, and the images the prompt `@`-mentions.
 *
 * The rail rows and the URLs that ride the payload are two different answers:
 * the rail shows everything connected, and only what the prompt `@`-mentions
 * is sent. Deriving both here rather than in the container keeps them from
 * disagreeing, and lets the execute path re-derive them from live Yjs at click
 * time — the same reason the image panel does it this way.
 */
describe('buildVideoPanelViewModel — references (#1927)', () => {
  const REF_MODELS = [
    makeModel('kling-o3-pro-ref', {
      mode: 'ref',
      params: {
        images: { description: '', type: 'list', max_items: 7, default: null },
      },
    }),
  ];

  /**
   * A canvas with two images connected into the target video node.
   * @returns The nodes and the edges wiring them in.
   */
  function twoConnectedImages(): {
    nodes: CanvasNodeView[];
    edges: CanvasEdge[];
    } {
    return {
      nodes: [
        node('n1', videoView({ mode: 'ref', model: 'kling-o3-pro-ref' })),
        node('src-a', { kind: 'image', status: 'idle', content: 'https://cdn/a.png' }),
        node('src-b', { kind: 'image', status: 'idle', content: 'https://cdn/b.png' }),
      ],
      edges: [
        { id: 'e-a', source: 'src-a', target: 'n1' },
        { id: 'e-b', source: 'src-b', target: 'n1' },
      ],
    };
  }

  it('shows every connected source in the rail, @-mentioned or not', () => {
    const { nodes, edges } = twoConnectedImages();
    const vm = buildVm({ nodeId: 'n1', nodes, edges, models: REF_MODELS, mode: 'ref' });
    expect(vm.references.map((r) => r.sourceNodeId)).toEqual(['src-a', 'src-b']);
  });

  it('sends only the @-mentioned ones, in rail order', () => {
    // Connecting an image says "this one is available"; `@`-mentioning it says
    // "use this one". A connected image that is never mentioned contributes
    // nothing — otherwise the user could not connect a candidate without
    // paying for it in every generation.
    const { nodes, edges } = twoConnectedImages();
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: REF_MODELS,
      mode: 'ref',
      atMentionedSourceIds: new Set(['src-b']),
    });
    expect(vm.referenceUrls).toEqual(['https://cdn/b.png']);
  });

  it('keeps rail order, not mention order', () => {
    const { nodes, edges } = twoConnectedImages();
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: REF_MODELS,
      mode: 'ref',
      atMentionedSourceIds: new Set(['src-b', 'src-a']),
    });
    expect(vm.referenceUrls).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
  });

  it('sends nothing when nothing is @-mentioned', () => {
    const { nodes, edges } = twoConnectedImages();
    const vm = buildVm({ nodeId: 'n1', nodes, edges, models: REF_MODELS, mode: 'ref' });
    expect(vm.references).toHaveLength(2);
    expect(vm.referenceUrls).toEqual([]);
  });

  it('sends nothing under a mode that does not take references', () => {
    // The four modes built before this one collect through slots. A reference
    // stays connected across a mode switch, so without this the images someone
    // connected for reference-to-video would ride into a first-last-frame task.
    const { nodes, edges } = twoConnectedImages();
    for (const mode of ['t2v', 'i2v', 'first_last', 'animate'] as VideoGenMode[]) {
      const vm = buildVm({
        nodeId: 'n1',
        nodes,
        edges,
        models: [makeModel('kling-i2v', { mode: ['i2v', 'first_last'] }), ...REF_MODELS],
        mode,
        atMentionedSourceIds: new Set(['src-a', 'src-b']),
      });
      expect(vm.referenceUrls, mode).toEqual([]);
    }
  });

  it('drops an @-mentioned source that is not an image', () => {
    // The rail carries text, audio and video rows too. A text node's body is
    // not a URL, and sending it as one would put a sentence where the upstream
    // expects an image.
    const nodes: CanvasNodeView[] = [
      node('n1', videoView({ mode: 'ref' })),
      node('src-t', { kind: 'text', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [{ id: 'e-t', source: 'src-t', target: 'n1' }];
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: REF_MODELS,
      mode: 'ref',
      atMentionedSourceIds: new Set(['src-t']),
    });
    expect(vm.referenceUrls).toEqual([]);
  });

  it('reads the model\'s reference cap off the wire', () => {
    const { nodes, edges } = twoConnectedImages();
    const vm = buildVm({ nodeId: 'n1', nodes, edges, models: REF_MODELS, mode: 'ref' });
    expect(vm.maxReferences).toBe(7);
  });

  it('treats a non-positive cap as uncapped, like the server and the worker', () => {
    // The server rule guards on `limit >= 1` and the worker on a truthy
    // `spec.max_items`; a frontend that honoured 0 would block every submit
    // with a "at most 0 reference images" toast the other two never meant.
    const { nodes, edges } = twoConnectedImages();
    for (const cap of [0, -1, Number.NaN, undefined]) {
      const models = [
        makeModel('kling-o3-pro-ref', {
          mode: 'ref',
          params: {
            images: { description: '', type: 'list', max_items: cap, default: null },
          },
        }),
      ];
      const vm = buildVm({ nodeId: 'n1', nodes, edges, models, mode: 'ref' });
      expect(vm.maxReferences, String(cap)).toBeUndefined();
    }
  });

  it('has no cap when the model declares no reference param at all', () => {
    const { nodes, edges } = twoConnectedImages();
    const vm = buildVm({
      nodeId: 'n1',
      nodes,
      edges,
      models: [makeModel('veo-3.1', { mode: 'ref' })],
      mode: 'ref',
    });
    expect(vm.maxReferences).toBeUndefined();
  });
});
