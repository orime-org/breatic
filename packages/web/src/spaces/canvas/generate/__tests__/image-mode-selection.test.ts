// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { ModelEntry } from '@breatic/shared';

import {
  resolveMode,
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

describe('resolveMode', () => {
  it('resolves the literal i2i to i2i', () => {
    expect(resolveMode('i2i')).toBe('i2i');
  });

  it('defaults undefined to t2i (a node with no stored mode)', () => {
    expect(resolveMode(undefined)).toBe('t2i');
  });

  it('sanitizes anything not exactly i2i to t2i (untrusted Yjs)', () => {
    // Only the literal 'i2i' is i2i; 't2i', '', and a malformed wire value all
    // resolve to the default so a corrupt string can never select a real mode
    // the picker cannot honor.
    expect(resolveMode('t2i')).toBe('t2i');
    expect(resolveMode('')).toBe('t2i');
    expect(resolveMode('bogus')).toBe('t2i');
  });
});
