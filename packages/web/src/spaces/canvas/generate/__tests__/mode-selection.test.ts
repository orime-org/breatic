// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { ModelEntry } from '@breatic/shared';

import { filterModelsByMode } from '@web/spaces/canvas/generate/mode-selection';

/**
 * Minimal ModelEntry fixture — only the fields the mode filter reads.
 * @param name - Model id.
 * @param mode - The model's `mode` (string or array).
 * @param modality - The model's modality (the filter ignores it; both panels
 *   pass their own catalog bucket).
 * @returns A ModelEntry-shaped object.
 */
function model(
  name: string,
  mode: string | string[],
  modality: ModelEntry['modality'] = 'image',
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
    params: {},
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
    // (In practice such a model is already excluded upstream by slice-1's
    // isImageGenerationMode; this locks the invariant at the mode filter too.)
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
