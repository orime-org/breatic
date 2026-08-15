// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import {
  paramsStoreOf,
  resolveModelSwitch,
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
const CAMERA: ParamDescriptor = {
  description: 'Camera',
  values: ['Canon EOS R5', 'Sony A7'],
  default: 'Canon EOS R5',
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

describe('paramsStoreOf — per-model records, with a one-time migration for old nodes (#1948)', () => {
  const banana = model({ aspect_ratio: RATIO, camera: CAMERA }, 'banana');
  const midjourney = model({ aspect_ratio: RATIO }, 'midjourney');
  const CATALOG = [banana, midjourney];

  it('returns the stored records untouched when the node already has them', () => {
    const stored = { banana: { aspect_ratio: '16:9' } };
    expect(
      paramsStoreOf(
        { model: 'banana', params: { aspect_ratio: '4:3' }, paramsByModel: stored },
        CATALOG,
      ),
    ).toEqual(stored);
  });

  it('migrates an old node’s params to its CURRENT model only', () => {
    // The node predates paramsByModel: its `params` are whatever the model it
    // was last on had. They belong to that one model — handing them to every
    // model the user later picks is exactly the bug this slice fixes.
    const store = paramsStoreOf(
      { model: 'banana', params: { aspect_ratio: '16:9', camera: 'Sony A7' } },
      CATALOG,
    );
    expect(store).toEqual({
      banana: { aspect_ratio: '16:9', camera: 'Sony A7' },
    });
    expect(store.midjourney).toBeUndefined();
  });

  it('filters the migrated set through the current model’s declaration', () => {
    // An old node's params can carry keys belonging to models it visited
    // earlier (end_image / video / images on the video side). They must not
    // ride into the record — the request payload is built from it.
    const store = paramsStoreOf(
      {
        model: 'midjourney',
        params: { aspect_ratio: '16:9', camera: 'Sony A7', end_image: null },
      },
      CATALOG,
    );
    expect(store).toEqual({ midjourney: { aspect_ratio: '16:9' } });
  });

  it('returns nothing to migrate when the node has no content at all', () => {
    expect(paramsStoreOf(undefined, CATALOG)).toEqual({});
  });

  it('returns nothing to migrate when the node has no model yet', () => {
    expect(paramsStoreOf({ params: { aspect_ratio: '16:9' } }, CATALOG)).toEqual(
      {},
    );
  });

  it('returns nothing to migrate when the current model left the catalog', () => {
    // Its declaration is what the filter above needs; without it there is no
    // way to tell the user's picks from another model's leftovers.
    expect(
      paramsStoreOf(
        { model: 'retired', params: { aspect_ratio: '16:9' } },
        CATALOG,
      ),
    ).toEqual({});
  });

  it('prefers stored records even when they are empty (migration is one-time)', () => {
    // An empty object means "this node has been through the new code path" —
    // migrating again would resurrect the old params after the user cleared
    // them.
    expect(
      paramsStoreOf(
        { model: 'banana', params: { aspect_ratio: '16:9' }, paramsByModel: {} },
        CATALOG,
      ),
    ).toEqual({});
  });
});

describe('resolveModelSwitch — the picked model brings its own record (#1948)', () => {
  // Mirrors the real declarations this defect was found on: two models in the
  // SAME mode whose defaults differ, one of which does not constrain the value
  // at all. `veo` defaults to 8 and allows [4,6,8]; `kling` defaults to 5 and
  // states no `values`, so nothing invalidates a value carried into it.
  const DURATION_LIST: ParamDescriptor = {
    description: 'Duration',
    values: [4, 6, 8],
    default: 8,
  };
  const DURATION_FREE: ParamDescriptor = {
    description: 'Duration',
    type: 'int',
    default: 5,
  };
  const veo = model({ duration: DURATION_LIST }, 'veo');
  const kling = model({ duration: DURATION_FREE }, 'kling');
  const CATALOG = [veo, kling];

  it('gives a model never used before its OWN defaults, not the outgoing model’s values', () => {
    // The defect: `veo`'s default 8 was written into the shared param set, and
    // `kling` states no `values`, so nothing rejected it — the user landed on
    // 8 seconds under a model whose own recommendation is 5.
    const { params } = resolveModelSwitch(
      { model: 'veo', params: { duration: 8 }, paramsByModel: { veo: { duration: 8 } } },
      kling,
      CATALOG,
    );
    expect(params).toEqual({ duration: 5 });
  });

  it('restores the picked model’s own record when it has one', () => {
    const { params } = resolveModelSwitch(
      {
        model: 'veo',
        params: { duration: 8 },
        paramsByModel: { veo: { duration: 8 }, kling: { duration: 12 } },
      },
      kling,
      CATALOG,
    );
    expect(params).toEqual({ duration: 12 });
  });

  it('returns every record to persist, leaving the other models’ untouched', () => {
    const { paramsByModel } = resolveModelSwitch(
      { model: 'veo', params: { duration: 6 }, paramsByModel: { veo: { duration: 6 } } },
      kling,
      CATALOG,
    );
    expect(paramsByModel).toEqual({
      veo: { duration: 6 },
      kling: { duration: 5 },
    });
  });

  it('carries a migrated old node’s record into what gets persisted', () => {
    // An old node has no paramsByModel. Switching away from its current model
    // must persist BOTH the migrated record for the model being left and the
    // new one — otherwise the user's settings on the outgoing model are gone
    // the moment they try another model.
    const { paramsByModel } = resolveModelSwitch(
      { model: 'veo', params: { duration: 6 } },
      kling,
      CATALOG,
    );
    expect(paramsByModel).toEqual({
      veo: { duration: 6 },
      kling: { duration: 5 },
    });
  });
});
