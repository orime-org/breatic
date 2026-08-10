// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { ModelEntry } from '@breatic/shared';

import {
  filterModelsByMode,
  resolveModelForMode,
} from '@web/spaces/canvas/generate/mode-selection';

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
