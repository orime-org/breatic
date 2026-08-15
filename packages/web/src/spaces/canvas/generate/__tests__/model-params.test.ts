// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import {
  paramsStoreOf,
  resolveModelSwitch,
  resolveParamsEdit,
  resolveParamsForModel,
} from '@web/spaces/canvas/generate/model-params';

/**
 * Builds a minimal image {@link ModelEntry} with the given params.
 * @param params - The model's param descriptors.
 * @param name - Model id (defaults to `nano`).
 * @returns A model entry usable by resolveParamsForModel.
 */
function model(
  params: Record<string, ParamDescriptor>,
  name = 'nano',
): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'image',
    mode: 'text-to-image',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 7,
    generation_time: 30,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

const RATIO: ParamDescriptor = {
  description: 'Aspect ratio',
  values: ['1:1', '16:9', '4:3'],
  default: '1:1',
};
const RESOLUTION: ParamDescriptor = {
  description: 'Resolution',
  values: ['1K', '2K'],
  default: '1K',
};
describe('resolveParamsForModel — keep valid, reset invalid, DROP undeclared', () => {
  it('keeps a current value that is valid for the new model', () => {
    const out = resolveParamsForModel(model({ aspect_ratio: RATIO }), {
      aspect_ratio: '16:9',
    });
    expect(out).toEqual({ aspect_ratio: '16:9' });
  });

  it('resets a value not in the new model’s allowed values to that param’s default', () => {
    const out = resolveParamsForModel(
      model({ aspect_ratio: RATIO, resolution: RESOLUTION }),
      { aspect_ratio: '16:9', resolution: '4K' }, // 4K invalid for this model
    );
    expect(out).toEqual({ aspect_ratio: '16:9', resolution: '1K' });
  });

  it('fills every param from its default when there is no current value', () => {
    const out = resolveParamsForModel(
      model({ aspect_ratio: RATIO, resolution: RESOLUTION }),
      {},
    );
    expect(out).toEqual({ aspect_ratio: '1:1', resolution: '1K' });
  });

  it('drops params the model does not declare (#1948)', () => {
    // Params are stored per model now, so a set never mixes two models' keys.
    // Anything the model does not declare has no reason to be in its record:
    // keeping it would put a foreign key in the request payload, where the
    // worker drops it and logs `unknown_param_dropped`.
    const out = resolveParamsForModel(model({ aspect_ratio: RATIO }), {
      aspect_ratio: '1:1',
      camera: 'Canon EOS R5', // not a param of this model
    });
    expect(out).toEqual({ aspect_ratio: '1:1' });
  });

  it('outputs an empty set for a model that declares no params (#1948)', () => {
    expect(resolveParamsForModel(model({}), { aspect_ratio: '16:9' })).toEqual(
      {},
    );
  });

  it('keeps a current value for a free (values-less) param, else uses its default', () => {
    const freeParam: ParamDescriptor = {
      description: 'Image weight',
      type: 'float',
      min: 0,
      max: 2,
      default: 1,
    };
    expect(resolveParamsForModel(model({ iw: freeParam }), { iw: 1.5 })).toEqual(
      { iw: 1.5 },
    );
    expect(resolveParamsForModel(model({ iw: freeParam }), {})).toEqual({
      iw: 1,
    });
  });

  // Malformed-catalog robustness (null / non-object / array params, null
  // descriptors, non-array values) is enforced ONCE at the API boundary —
  // see sanitizeModelCatalog + model-catalog.schema.test.ts. resolveParamsForModel
  // consumes the sanitized, trusted ModelEntry, so those impossible-after-boundary
  // states are not re-tested here.
});

describe('paramsStoreOf — 节点的按模型记录 (#1948)', () => {
  it('有记录就原样返回', () => {
    const stored = { banana: { aspect_ratio: '16:9' } };
    expect(paramsStoreOf({ paramsByModel: stored })).toEqual(stored);
  });

  it('没有内容时是空的', () => {
    expect(paramsStoreOf(undefined)).toEqual({});
  });

  it('上线前的老节点一个记录都没有，不做任何兼容处理', () => {
    // user 2026-08-15 拍定：Yjs 里的老数据一律不迁移、不兼容。老节点上那份
    // 旧参数在类型里已经不存在，这里连读都读不到 —— 每个模型从自己的默认值
    // 开始，这正是「不做任何支持」该有的样子。
    expect(paramsStoreOf({} as { paramsByModel?: never })).toEqual({});
  });

  it('记录是空对象时如实返回空，不当成「还没有记录」区别对待', () => {
    expect(paramsStoreOf({ paramsByModel: {} })).toEqual({});
  });
});

describe('resolveModelSwitch — the picked model brings its own record (#1948)', () => {
  // Mirrors the real declarations this defect was found on: two models in the
  // SAME mode whose defaults differ, one of which does not constrain the value
  // at all. `veo` defaults to 8 and allows [4,6,8]; `kling` defaults to 5 and
  // states no `values`, so nothing invalidates a value carried into it.
  const DURATION_FREE: ParamDescriptor = {
    description: 'Duration',
    type: 'int',
    default: 5,
  };
  const kling = model({ duration: DURATION_FREE }, 'kling');

  it('gives a model never used before its OWN defaults, not the outgoing model’s values', () => {
    // The defect: `veo`'s default 8 was written into the shared param set, and
    // `kling` states no `values`, so nothing rejected it — the user landed on
    // 8 seconds under a model whose own recommendation is 5.
    const { params } = resolveModelSwitch(
      { paramsByModel: { veo: { duration: 8 } } },
      kling,
    );
    expect(params).toEqual({ duration: 5 });
  });

  it('restores the picked model’s own record when it has one', () => {
    const { params } = resolveModelSwitch(
      { paramsByModel: { veo: { duration: 8 }, kling: { duration: 12 } } },
      kling,
    );
    expect(params).toEqual({ duration: 12 });
  });

  it('returns every record to persist, leaving the other models’ untouched', () => {
    const { paramsByModel } = resolveModelSwitch(
      { paramsByModel: { veo: { duration: 6 } } },
      kling,
    );
    expect(paramsByModel).toEqual({
      veo: { duration: 6 },
      kling: { duration: 5 },
    });
  });

});

describe('resolveParamsEdit — a param edit lands on the model it was made on (#1948)', () => {
  it('merges the change into the current model’s record', () => {
    const r = resolveParamsEdit(
      { paramsByModel: { banana: { aspect_ratio: '1:1', camera: 'Sony A7' } } },
      { aspect_ratio: '16:9' },
      'banana',
    );
    expect(r.banana).toEqual({
      aspect_ratio: '16:9',
      camera: 'Sony A7',
    });
  });

  it('leaves the OTHER models’ records untouched', () => {
    // The defect a missing store merge produces: editing one model's params
    // wipes every other model's record, so 9.5 (switch away and back) silently
    // stops holding.
    const r = resolveParamsEdit(
      {
        paramsByModel: {
          banana: { aspect_ratio: '1:1' },
          midjourney: { aspect_ratio: '16:9' },
        },
      },
      { aspect_ratio: '4:3' },
      'banana',
    );
    expect(r.midjourney).toEqual({ aspect_ratio: '16:9' });
  });

  it('别的模型的记录原样留着，这次没碰的一个都不丢', () => {
    const r = resolveParamsEdit(
      { paramsByModel: { banana: { aspect_ratio: '1:1', camera: 'Sony A7' } } },
      { aspect_ratio: '16:9' },
      'midjourney',
    );
    expect(r).toEqual({
      banana: { aspect_ratio: '1:1', camera: 'Sony A7' },
      midjourney: { aspect_ratio: '16:9' },
    });
  });

  it('persists nothing under an empty model id', () => {
    // The panels pass the RESOLVED model, which is '' only while the catalog
    // is empty or the mode offers nothing — and then no param control renders
    // at all. A guard, not a reachable state; it must not write a "" record.
    const r = resolveParamsEdit(undefined, { aspect_ratio: '16:9' }, '');
    expect(r).toEqual({});
  });
});

describe('resolveParamsEdit — a fresh node has no stored model (#1948 Gate 2 round 2)', () => {
  it('persists the edit under the model the panel is SHOWING, not the stored one', () => {
    // node-factory writes no `model`, and nothing persists one on panel open —
    // the panel resolves the first offered model and renders its controls. An
    // edit made there has to land on THAT model, or it is written nowhere and
    // the control snaps back to the default on the next render.
    const r = resolveParamsEdit(
      undefined, // fresh node: no records at all
      { aspect_ratio: '16:9' },
      'nano', // what the panel resolved and is showing
    );
    expect(r).toEqual({ nano: { aspect_ratio: '16:9' } });
  });
});
