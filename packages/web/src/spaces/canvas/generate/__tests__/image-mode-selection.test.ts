// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { ModelEntry } from '@breatic/shared';

import {
  filterModelsByMode,
  resolveModelForMode,
  type ImageGenMode,
} from '@web/spaces/canvas/generate/image-mode-selection';

/**
 * Minimal ModelEntry fixture — only the fields the mode logic reads.
 * @param name - Model id.
 * @param mode - The model's `mode` (string or array).
 * @returns A ModelEntry-shaped object.
 */
function model(name: string, mode: string | string[]): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'image',
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
});

describe('resolveModelForMode', () => {
  const t2iModels = [T2I, T2I_B];

  it('restores the remembered model for the mode when still available', () => {
    const remembered: Partial<Record<ImageGenMode, string>> = { t2i: 't2i-b' };
    expect(resolveModelForMode('t2i', remembered, t2iModels)).toBe('t2i-b');
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
    expect(resolveModelForMode('t2i', { t2i: 't2i-b' }, [T2I, rec])).toBe('t2i-b');
  });

  it('falls back to the first model when the remembered one is gone', () => {
    const remembered: Partial<Record<ImageGenMode, string>> = { t2i: 'removed' };
    expect(resolveModelForMode('t2i', remembered, t2iModels)).toBe('t2i-a');
  });

  it('returns undefined when there are no models for the mode', () => {
    expect(resolveModelForMode('i2i', { i2i: 'anything' }, [])).toBeUndefined();
  });
});
