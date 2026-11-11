// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import { ScenePoseSchema } from '@breatic/shared';
import { POSE_PRESETS } from '@web/spaces/three-d/viewport/pose-presets';

/** The six limb segments of each side every preset must write. */
const LIMB_KEYS = ['left', 'right'].flatMap((side) =>
  ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot'].map((part) => `h:${side}${part}`));

/** The required VRM humanoid bones, the only rotations a preset may carry. */
const REQUIRED_KEYS = new Set(['h:hips', 'h:spine', 'h:head', ...LIMB_KEYS]);

const ENTRIES = Object.entries(POSE_PRESETS);

describe('pose presets (inner#1692)', () => {
  it('offers exactly stand, sit, lie, walk and wave', () => {
    expect(Object.keys(POSE_PRESETS).sort()).toEqual(['lie', 'sit', 'stand', 'walk', 'wave']);
  });

  it.each(ENTRIES)('%s passes the stored pose schema', (_name, pose) => {
    expect(ScenePoseSchema.safeParse(pose).success).toBe(true);
  });

  it.each(ENTRIES)('%s writes only required humanoid bones plus the hips translation', (_name, pose) => {
    for (const key of Object.keys(pose)) {
      expect(key === 't:hips' || REQUIRED_KEYS.has(key), key).toBe(true);
    }
  });

  it.each(ENTRIES)('%s covers all six limb segments of each side', (_name, pose) => {
    for (const key of LIMB_KEYS) expect(pose[key], key).toBeDefined();
  });

  it('lowers the hips for sit and lie', () => {
    expect(POSE_PRESETS.sit['t:hips']?.[1]).toBeLessThan(0);
    expect(POSE_PRESETS.lie['t:hips']?.[1]).toBeLessThan(0);
  });

  it('keeps every preset distinct', () => {
    const shapes = new Set(ENTRIES.map(([, pose]) => JSON.stringify(Object.entries(pose).sort(([a], [b]) => a.localeCompare(b)))));
    expect(shapes.size).toBe(ENTRIES.length);
  });
});
