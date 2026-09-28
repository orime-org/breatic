// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many reference images the model in front of the user takes (#1928).
 *
 * The video Generate panel's submit gate refuses a submission carrying more.
 * Adding a reference image on the canvas asks a different question and gets a
 * different answer — the site-wide pool cap, which knows nothing about models
 * (#2112).
 */

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { modelReferenceCap } from '@web/spaces/canvas/generate/model-reference-cap';

/**
 * A catalog entry declaring a capped `images` pool.
 * @param over - Fields to replace.
 * @returns The entry.
 */
function refModel(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'ref-model',
    display_name: 'Ref Model',
    mode: 'ref',
    description: '',
    guide: '',
    tier: 'recommended',
    generation_time: 120,
    takes_prompt: true,
    providers: [],
    params: {
      images: { description: 'Reference image URLs', type: 'list', max_items: 7, default: null },
    },
    ...over,
  } as ModelEntry;
}

describe('the reference-image cap of the selected model', () => {
  it('is the cap the model declares on its image pool', () => {
    expect(modelReferenceCap(refModel())).toBe(7);
  });

  it('is undefined when the model declares no image list', () => {
    const noImages = refModel({ params: { seed: { description: '', default: -1 } } });
    expect(modelReferenceCap(noImages)).toBeUndefined();
  });

  it('is undefined when the catalog has not answered yet', () => {
    // The panel renders before the catalog query resolves, so this is the
    // ordinary case on a fresh space: the callers fall back to no cap rather
    // than inventing a number.
    expect(modelReferenceCap(undefined)).toBeUndefined();
  });

  it('treats an absent max_items as uncapped', () => {
    const uncapped = refModel({
      params: { images: { description: '', type: 'list', default: null } },
    });
    expect(modelReferenceCap(uncapped)).toBeUndefined();
  });
});
