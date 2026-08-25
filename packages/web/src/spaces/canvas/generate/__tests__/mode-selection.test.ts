// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import type { ModelEntry } from '@breatic/shared';

import {
  filterAvailableModes,
  resolveAvailableMode,
  filterModelsByMode,
  pickModelForMode,
  resolveModeSwitch,
  resolveModelForMode,
} from '@web/spaces/canvas/generate/mode-selection';

/**
 * Minimal ModelEntry fixture — only the fields the mode filter reads.
 * @param name - Model id.
 * @param mode - The model's `mode` (string or array).
 * @param modality - The model's modality (the filter ignores it; both panels
 *   pass their own catalog bucket).
 * @param params - The model's declared params (only the resolvers read these).
 * @returns A ModelEntry-shaped object.
 */
function model(
  name: string,
  mode: string | string[],
  modality: ModelEntry['modality'] = 'image',
  params: ModelEntry['params'] = {},
): ModelEntry {
  return {
    name,
    display_name: name,
    modality,
    mode,
    description: '',
    guide: '',
    tier: 'optional',
    cost_per_call: 5,
    generation_time: 10,
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

const T2I = model('t2i-a', 't2i');
const T2I_B = model('t2i-b', 't2i');
const I2I = model('i2i-a', 'i2i');
const EDIT = model('edit-a', ['i2i', 'edit']); // qualifies as i2i via its i2i mode
const MODELS = [T2I, I2I, T2I_B, EDIT];

describe('filterModelsByMode', () => {
  it('t2i mode keeps only models whose mode includes t2i', () => {
    expect(filterModelsByMode(MODELS, 't2i').map((m) => m.name)).toEqual([
      't2i-a',
      't2i-b',
    ]);
  });

  it('i2i mode keeps models whose mode includes i2i (incl. multi-mode edit)', () => {
    expect(filterModelsByMode(MODELS, 'i2i').map((m) => m.name)).toEqual([
      'i2i-a',
      'edit-a',
    ]);
  });

  it('preserves the input order within a mode', () => {
    const reordered = [T2I_B, T2I];
    expect(filterModelsByMode(reordered, 't2i').map((m) => m.name)).toEqual([
      't2i-b',
      't2i-a',
    ]);
  });

  it('returns [] when no model matches the mode', () => {
    expect(filterModelsByMode([T2I, T2I_B], 'i2i')).toEqual([]);
  });

  it('excludes a pure-edit model from i2i — edit is not a generation mode', () => {
    // The generate panel routes on i2i; a model with only the `edit`
    // capability belongs to the future image-editing mini-tool, not here.
    // 这一条一直就是唯一的守卫，#1951 前后都一样。仓里曾有个
    // isImageGenerationMode 看着像上游那一道，但它算的是「整份目录一个可生成
    // 模型都没有」这个布尔，从没参与过交给选择器的模型列表；#1951 删掉那个布尔
    // 之后它没了最后一个调用方，函数也一起删了。
    const pureEdit = model('edit-only', ['edit']);
    expect(filterModelsByMode([I2I, pureEdit], 'i2i').map((m) => m.name)).toEqual([
      'i2i-a',
    ]);
  });

  it('serves video modes by the same rule', () => {
    // One implementation for both panels (#1896): the video panel narrows its
    // own mode union before calling, and gets multi-mode handling for free.
    const t2v = model('veo', 't2v', 'video');
    const hybrid = model('kling', ['t2v', 'i2v'], 'video');
    const upscale = model('upscale', 'upscale', 'video');
    expect(
      filterModelsByMode([t2v, hybrid, upscale], 't2v').map((m) => m.name),
    ).toEqual(['veo', 'kling']);
    expect(
      filterModelsByMode([t2v, hybrid, upscale], 'i2v').map((m) => m.name),
    ).toEqual(['kling']);
  });
});

describe('resolveModelForMode', () => {
  const t2iModels = [T2I, T2I_B];

  it('restores the remembered model for the mode when still available', () => {
    expect(resolveModelForMode('t2i', { t2i: 't2i-b' }, t2iModels)).toBe(
      't2i-b',
    );
  });

  it('falls back to the first model when the mode was never chosen', () => {
    expect(resolveModelForMode('t2i', {}, t2iModels)).toBe('t2i-a');
  });

  it('ignores the recommended TIER for defaulting — first model wins (user 2026-07-11)', () => {
    // `tier: recommended` is a curation BADGE (a mode may carry several), not
    // a default-selection rule — the earlier recommended-first resolution
    // misread it (corrected 2026-07-11). With no remembered pick, the first
    // offered model is the default even when a later one is recommended.
    const rec: ModelEntry = { ...T2I_B, tier: 'recommended' };
    expect(resolveModelForMode('t2i', {}, [T2I, rec])).toBe('t2i-a');
  });

  it('remembered model always wins', () => {
    const rec: ModelEntry = { ...T2I_B, tier: 'recommended' };
    expect(resolveModelForMode('t2i', { t2i: 't2i-b' }, [T2I, rec])).toBe(
      't2i-b',
    );
  });

  it('falls back to the first model when the remembered one is gone', () => {
    expect(resolveModelForMode('t2i', { t2i: 'removed' }, t2iModels)).toBe(
      't2i-a',
    );
  });

  it('returns undefined when there are no models for the mode', () => {
    expect(resolveModelForMode('i2i', { i2i: 'anything' }, [])).toBeUndefined();
  });

  it('remembers per video mode too, keyed by the mode string', () => {
    // The reason this lives beside the mode filter rather than in the image
    // module (#1896): the memory is per mode, and a node carrying picks for
    // several modes must get the right one back in each — including the video
    // ones, which the image-typed signature could not even express.
    const veo = model('veo', 't2v', 'video');
    const kling = model('kling', ['t2v', 'i2v'], 'video');
    const memory = { t2v: 'kling', i2v: 'kling' };
    expect(resolveModelForMode('t2v', memory, [veo, kling])).toBe('kling');
    expect(resolveModelForMode('i2v', memory, [kling])).toBe('kling');
    // A pick remembered under ANOTHER mode never leaks into this one.
    expect(resolveModelForMode('t2v', { i2v: 'kling' }, [veo])).toBe('veo');
  });
});

describe('pickModelForMode — 渲染时挑模型，两个面板共用 (#1948)', () => {
  const nano = model('nano', 't2i');
  const midjourney = model('midjourney', 't2i');

  it('存的模型还在这个模式的列表里，就用它', () => {
    expect(pickModelForMode('midjourney', 't2i', {}, [nano, midjourney])).toBe(
      'midjourney',
    );
  });

  it('存的模型不在列表里，落到这个模式记住的那个', () => {
    // 这一条正是视频面板原来漏掉的那层。协作时一个人挑模型（只写 model）
    // 撞上另一个人切模式（写 mode + model），节点上会留下「新模式 + 旧模式的
    // 模型」；此时该恢复的是用户自己在这个模式下选过的那个。
    expect(
      pickModelForMode('editor', 't2i', { t2i: 'midjourney' }, [
        nano,
        midjourney,
      ]),
    ).toBe('midjourney');
  });

  it('存的和记住的都不在列表里，落到第一个', () => {
    expect(
      pickModelForMode('editor', 't2i', { t2i: 'gone' }, [nano, midjourney]),
    ).toBe('nano');
  });

  it('这个模式一个模型都没有时给空字符串', () => {
    expect(pickModelForMode('nano', 'i2i', {}, [])).toBe('');
  });

  it('视频的模式一样走这条路，签名不认识面板类型', () => {
    const veo = model('veo', 't2v', 'video');
    expect(pickModelForMode('kling', 't2v', { t2v: 'veo' }, [veo])).toBe('veo');
  });
});

describe('resolveModeSwitch — 切模式，两个面板共用 (#1948)', () => {
  const nano = model('nano', 't2i', 'image', {
    aspect_ratio: { default: '1:1', values: ['1:1', '16:9'], description: '' },
  });
  const editor = model('editor', 'i2i', 'image', {
    aspect_ratio: { default: '4:3', values: ['4:3', '16:9'], description: '' },
  });

  it('目标模式的模型带自己的参数记录，不继承来的那个模式的值', () => {
    const content = {
      modelByMode: { t2i: 'nano' },
      paramsByModel: { nano: { aspect_ratio: '16:9' } },
    };
    const r = resolveModeSwitch(content, 'i2i', [nano, editor]);
    expect(r.model).toBe('editor');
    expect(r.paramsByModel[r.model]).toEqual({ aspect_ratio: '4:3' });
    // 离开的那个模型的记录原样留着，切回来还在。
    expect(r.paramsByModel.nano).toEqual({ aspect_ratio: '16:9' });
  });

  it('目标模式一个模型都没有时，模型和记录都是空的（调用方据此放弃写入）', () => {
    const r = resolveModeSwitch({ modelByMode: { t2i: 'nano' } }, 'i2i', [nano]);
    expect(r.model).toBe('');
    expect(r.paramsByModel).toEqual({});
  });

  it('视频的六个模式走的是同一个函数', () => {
    const veo = model('veo', 't2v', 'video', {
      duration: { default: 8, values: [4, 8], description: '' },
    });
    const kling = model('kling', 'i2v', 'video', {
      duration: { default: 5, values: [5, 10], description: '' },
    });
    const r = resolveModeSwitch({ modelByMode: { t2v: 'veo' } }, 'i2v', [veo, kling]);
    expect(r.model).toBe('kling');
    expect(r.paramsByModel[r.model]).toEqual({ duration: 5 });
  });
});

describe('filterAvailableModes（#1951 档要先有模型才出现）', () => {
  const t2v = model('veo', 't2v', 'video');
  const i2v = model('kling-i2v', ['i2v', 'first_last'], 'video');
  const OPTIONS = [
    { value: 't2v', label: 'Text to Video', testId: 'x-t2v' },
    { value: 'i2v', label: 'Image to Video', testId: 'x-i2v' },
    { value: 'first_last', label: 'First-Last Frame', testId: 'x-fl' },
    { value: 'animate', label: 'Image Animation', testId: 'x-animate' },
  ] as const;

  it('目录是空的时候一个档都不留', () => {
    expect(filterAvailableModes(OPTIONS, [])).toEqual([]);
  });

  it('只去掉没有模型的那一档，其余原样留下', () => {
    const kept = filterAvailableModes(OPTIONS, [t2v, i2v]);
    expect(kept.map((o) => o.value)).toEqual(['t2v', 'i2v', 'first_last']);
  });

  it('一个模型声明了两个模式，两档都留下', () => {
    // kling-i2v 是 ["i2v", "first_last"]，这两档靠同一个模型活着 ——
    // 按模型数去重的写法会漏掉后一档。
    const kept = filterAvailableModes(OPTIONS, [i2v]);
    expect(kept.map((o) => o.value)).toEqual(['i2v', 'first_last']);
  });

  it('留下的是原来那个对象，额外字段一个不丢', () => {
    // 视频档带着 slots / takesReferences，容器还要拿它们查槽位；
    // 过滤要是重建对象，那些字段就没了。
    const withExtras = [
      { value: 't2v', label: 'Text to Video', testId: 'x-t2v', slots: [], takesReferences: false },
      { value: 'ref', label: 'Reference', testId: 'x-ref', slots: ['a'], takesReferences: true },
    ] as const;
    const kept = filterAvailableModes(withExtras, [t2v]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(withExtras[0]);
    expect(kept[0]?.takesReferences).toBe(false);
  });
});

describe('resolveAvailableMode（#1951 当前档也要先可用）', () => {
  const OPTIONS = [
    { value: 't2v' },
    { value: 'i2v' },
    { value: 'animate' },
  ] as const;

  it('存的档可用，就用它', () => {
    expect(resolveAvailableMode('i2v', OPTIONS)).toBe('i2v');
  });

  it('存的档合法但已经不可用，当没存过', () => {
    // animate 在这个部署里被摘掉了：可用档只剩前两个。
    expect(resolveAvailableMode('animate', OPTIONS.slice(0, 2))).toBe('t2v');
  });

  it('没存过，取可用档第一个', () => {
    expect(resolveAvailableMode(undefined, OPTIONS)).toBe('t2v');
    expect(resolveAvailableMode('', OPTIONS)).toBe('t2v');
  });

  it('取的是可用档第一个，不是某个写死的档', () => {
    // t2v 被摘掉时，新节点该落在 i2v 上 —— 写死 't2v' 的实现会在这条上红。
    expect(resolveAvailableMode(undefined, OPTIONS.slice(1))).toBe('i2v');
    expect(resolveAvailableMode('t2v', OPTIONS.slice(1))).toBe('i2v');
  });

  it('一个可用档都没有时答不出来', () => {
    // 面板在这种部署里根本不打开，所以这一支到不了；纯函数仍然要诚实。
    expect(resolveAvailableMode('t2v', [])).toBeUndefined();
    expect(resolveAvailableMode(undefined, [])).toBeUndefined();
  });
});
