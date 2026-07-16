// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';

/**
 * Builds a minimal image {@link ModelEntry} with the given params.
 * @param params - The model's param descriptors.
 * @returns A model entry usable by resolveParamsForModel.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'nano',
    display_name: 'Nano',
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

describe('resolveParamsForModel — keep valid params, reset invalid to the model default on model switch', () => {
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

  it('drops params the new model does not define (they belong to a different model)', () => {
    const out = resolveParamsForModel(model({ aspect_ratio: RATIO }), {
      aspect_ratio: '1:1',
      style_strength: 0.8, // not a param of this model
    });
    expect(out).toEqual({ aspect_ratio: '1:1' });
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

  it('returns an empty object for a model with no params', () => {
    expect(resolveParamsForModel(model({}), { aspect_ratio: '16:9' })).toEqual(
      {},
    );
  });

  // Malformed-catalog robustness (null / non-object / array params, null
  // descriptors, non-array values) is now enforced ONCE at the API boundary —
  // see sanitizeModelCatalog + model-catalog.schema.test.ts. resolveParamsForModel
  // consumes the sanitized, trusted ModelEntry, so those impossible-after-boundary
  // states are no longer re-tested here.
});
