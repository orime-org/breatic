// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The options a parameter offers, read off whichever model is active (#1896).
 *
 * The image panel has always read these from a model's `values` list. Video
 * needs the same thing plus one more shape: some models express duration as a
 * RANGE rather than a list of allowed numbers — `kling-o3-pro` is 3 to 15
 * seconds, and the image-to-video entries state theirs the same way. Left
 * unhandled, the duration group would find nothing to show and disappear for
 * those models — the user could not pick a duration at all, and the panel
 * would give no hint why.
 *
 * Both panels share this reader. That is safe for the image side by evidence,
 * not by hope: `config/models/image/*.yaml` contains no `min:` at all, so every
 * image parameter is a list and never reaches the range branch. The last case
 * below pins that.
 *
 * Ranges expand one step per second (user 2026-08-08, from the reference
 * screenshot where 4s through 12s are listed one by one).
 */

import { describe, it, expect } from 'vitest';

import { paramValues } from '@web/spaces/canvas/generate/param-values';
import type { ModelEntry } from '@breatic/shared';

/**
 * A model carrying exactly one parameter descriptor.
 * @param key - Parameter name.
 * @param descriptor - The descriptor fields under test.
 * @returns A ModelEntry shaped enough for the reader.
 */
function modelWith(
  key: string,
  descriptor: Record<string, unknown>,
): ModelEntry {
  return {
    name: 'probe',
    display_name: 'Probe',
    description: '',
    mode: 't2v',
    tier: 'recommended',
    cost_per_call: 1,
    generation_time: 1,
    params: { [key]: { description: '', default: null, ...descriptor } },
    providers: [],
    sourcesByMode: {},
  } as unknown as ModelEntry;
}

describe('paramValues', () => {
  it('reads a list of allowed values, as the image panel always has', () => {
    const model = modelWith('duration', { values: [4, 6, 8] });
    expect(paramValues(model, 'duration')).toEqual([4, 6, 8]);
  });

  it('keeps string values as they are', () => {
    const model = modelWith('aspect_ratio', { values: ['16:9', '9:16'] });
    expect(paramValues(model, 'aspect_ratio')).toEqual(['16:9', '9:16']);
  });

  it('hands back the catalog type, not a display string', () => {
    // What the user picks is what gets stored and submitted. Duration and
    // focal length are numbers in the catalog, so a reader that stringified
    // everything would put "5" in the payload where the provider expects 5,
    // and would make the current value unrecognizable to the control drawing
    // it (`'5' === 5` is false, so nothing reads as selected).
    const numeric = modelWith('duration', { values: [4, 6, 8] });
    expect(paramValues(numeric, 'duration').map((v) => typeof v)).toEqual([
      'number',
      'number',
      'number',
    ]);
    const ranged = modelWith('duration', { min: 4, max: 6 });
    expect(paramValues(ranged, 'duration').map((v) => typeof v)).toEqual([
      'number',
      'number',
      'number',
    ]);
  });

  it('expands a range one step per second', () => {
    // `kling-o3-pro`'s duration. Without this the whole duration group
    // vanishes for it — and it is the only text-to-video model stating a
    // range, so the group would be missing from exactly one of the five.
    const model = modelWith('duration', { min: 3, max: 15 });
    expect(paramValues(model, 'duration')).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('expands the other range family too', () => {
    // A different span (`seedance-1.5-pro-i2v`'s 4 to 12), so the expansion
    // cannot be hardcoded to one model's numbers.
    const model = modelWith('duration', { min: 4, max: 12 });
    expect(paramValues(model, 'duration')).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('prefers an explicit list when a descriptor carries both', () => {
    // A list is the more precise statement: it can skip values a range would
    // include. Deriving from the range instead would offer 5s and 7s on a
    // model that only accepts 4, 6 and 8.
    const model = modelWith('duration', { values: [4, 6, 8], min: 4, max: 8 });
    expect(paramValues(model, 'duration')).toEqual([4, 6, 8]);
  });

  it('yields a single option when the range has one point', () => {
    const model = modelWith('duration', { min: 5, max: 5 });
    expect(paramValues(model, 'duration')).toEqual([5]);
  });

  it('yields nothing for a half-declared range', () => {
    // A bound on its own says nothing about where the other end is; guessing
    // one would put options in front of the user that the model may reject.
    expect(paramValues(modelWith('duration', { min: 4 }), 'duration')).toEqual([]);
    expect(paramValues(modelWith('duration', { max: 12 }), 'duration')).toEqual([]);
  });

  it('yields nothing when the range runs backwards', () => {
    const model = modelWith('duration', { min: 12, max: 4 });
    expect(paramValues(model, 'duration')).toEqual([]);
  });

  it('yields nothing for a non-finite bound', () => {
    // The catalog is sanitized at the API boundary, but a bound that survived
    // as NaN or Infinity would otherwise drive an unbounded loop.
    expect(paramValues(modelWith('d', { min: NaN, max: 8 }), 'd')).toEqual([]);
    expect(paramValues(modelWith('d', { min: 4, max: Infinity }), 'd')).toEqual([]);
  });

  it('steps on whole seconds inside a fractional range', () => {
    // No catalog writes this today; it is defined rather than left to chance
    // because the option labels are seconds and half a second is not one.
    const model = modelWith('duration', { min: 3.5, max: 6.5 });
    expect(paramValues(model, 'duration')).toEqual([4, 5, 6]);
  });

  it('yields nothing when the parameter is absent or its list is empty', () => {
    const model = modelWith('duration', { values: [4, 6] });
    expect(paramValues(model, 'generate_audio')).toEqual([]);
    expect(paramValues(modelWith('d', { values: [] }), 'd')).toEqual([]);
  });

  it('leaves image parameters on the list path, so the image panel is unchanged', () => {
    // The reason sharing this reader is safe: image models declare no ranges
    // (`config/models/image/*.yaml` has no `min:`), so they never reach the
    // branch this change adds. Asserting the list path still wins when a
    // range is absent is what keeps that true.
    const model = modelWith('resolution', { values: ['1K', '2K', '4K'] });
    expect(paramValues(model, 'resolution')).toEqual(['1K', '2K', '4K']);
  });
});
