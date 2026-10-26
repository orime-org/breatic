// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The colour and strength the light sphere draws its light in (inner#1304):
 * what the reader picked, so the sphere shows it as it is chosen.
 */

import { describe, expect, it } from 'vitest';
import { AUTO_LIGHT_SWATCH as AUTO_LIGHT, LIGHT_COLORS } from '@breatic/shared';

import { lightTintOf } from '@web/spaces/canvas/generate/light-tint';

describe('lightTintOf', () => {
  it('draws a preset in its swatch colour, and Auto in the warm default', () => {
    expect(lightTintOf({ light_color: 'cool' }).color).toBe(LIGHT_COLORS.cool!.swatch);
    expect(lightTintOf({ light_color: 'auto' }).color).toBe(AUTO_LIGHT);
    expect(lightTintOf({}).color).toBe(AUTO_LIGHT);
  });

  it('draws Custom in the colour picked, and in the default while none is well formed', () => {
    expect(lightTintOf({ light_color: 'custom', light_color_hex: '#8fc0ff' }).color).toBe('#8fc0ff');
    expect(lightTintOf({ light_color: 'custom', light_color_hex: 'nope' }).color).toBe(AUTO_LIGHT);
  });

  it('glows weakest at Low, strongest at High, and Auto as Medium', () => {
    const at = (light_intensity: string): number => lightTintOf({ light_intensity }).strength;
    expect(at('low')).toBeLessThan(at('medium'));
    expect(at('medium')).toBeLessThan(at('high'));
    expect(at('auto')).toBe(at('medium'));
    expect(lightTintOf({}).strength).toBe(at('medium'));
  });
});
