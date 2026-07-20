// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import {
  EMPTY_IMAGE_DEFAULT,
  EMPTY_IMAGE_MAX,
  EMPTY_IMAGE_MIN,
  clampDimension,
  normalizeDimensionInput,
  sizeForRatio,
} from '@web/spaces/canvas/empty-image/empty-image-size';

describe('clampDimension', () => {
  it('passes a valid integer through unchanged', () => {
    expect(clampDimension(1024)).toBe(1024);
  });

  it('rounds a fractional value to the nearest integer', () => {
    expect(clampDimension(1023.6)).toBe(1024);
    expect(clampDimension(100.2)).toBe(100);
  });

  it('clamps below the minimum up to EMPTY_IMAGE_MIN', () => {
    expect(clampDimension(5)).toBe(EMPTY_IMAGE_MIN);
    expect(clampDimension(0)).toBe(EMPTY_IMAGE_MIN);
    expect(clampDimension(-40)).toBe(EMPTY_IMAGE_MIN);
  });

  it('clamps above the maximum down to EMPTY_IMAGE_MAX', () => {
    expect(clampDimension(9999)).toBe(EMPTY_IMAGE_MAX);
    expect(clampDimension(4097)).toBe(EMPTY_IMAGE_MAX);
  });

  it('falls back to EMPTY_IMAGE_MIN for non-finite input', () => {
    expect(clampDimension(Number.NaN)).toBe(EMPTY_IMAGE_MIN);
    expect(clampDimension(Number.POSITIVE_INFINITY)).toBe(EMPTY_IMAGE_MAX);
  });
});

describe('normalizeDimensionInput (blur validation)', () => {
  it('empty / whitespace falls back to the default', () => {
    expect(normalizeDimensionInput('')).toBe(String(EMPTY_IMAGE_DEFAULT));
    expect(normalizeDimensionInput('   ')).toBe(String(EMPTY_IMAGE_DEFAULT));
  });

  it('clamps an over-range value down to the max', () => {
    expect(normalizeDimensionInput('10000')).toBe(String(EMPTY_IMAGE_MAX));
  });

  it('clamps an under-range value up to the min', () => {
    expect(normalizeDimensionInput('3')).toBe(String(EMPTY_IMAGE_MIN));
  });

  it('passes a valid value through', () => {
    expect(normalizeDimensionInput('800')).toBe('800');
  });
});

describe('sizeForRatio', () => {
  it('produces a square for 1:1 at the default long edge', () => {
    expect(sizeForRatio(1)).toEqual({
      width: EMPTY_IMAGE_DEFAULT,
      height: EMPTY_IMAGE_DEFAULT,
    });
  });

  it('anchors the wide long edge for landscape ratios', () => {
    expect(sizeForRatio(16 / 9)).toEqual({ width: 1024, height: 576 });
    expect(sizeForRatio(3 / 2)).toEqual({ width: 1024, height: 683 });
  });

  it('anchors the tall long edge for portrait ratios', () => {
    expect(sizeForRatio(9 / 16)).toEqual({ width: 576, height: 1024 });
    expect(sizeForRatio(2 / 3)).toEqual({ width: 683, height: 1024 });
  });

  it('keeps both axes within [MIN, MAX]', () => {
    for (const ratio of [16 / 9, 3 / 2, 4 / 3, 1, 3 / 4, 2 / 3, 9 / 16]) {
      const size = sizeForRatio(ratio);
      expect(size.width).toBeGreaterThanOrEqual(EMPTY_IMAGE_MIN);
      expect(size.width).toBeLessThanOrEqual(EMPTY_IMAGE_MAX);
      expect(size.height).toBeGreaterThanOrEqual(EMPTY_IMAGE_MIN);
      expect(size.height).toBeLessThanOrEqual(EMPTY_IMAGE_MAX);
    }
  });

  it('preserves the requested ratio within rounding tolerance', () => {
    for (const ratio of [16 / 9, 3 / 2, 4 / 3, 3 / 4, 2 / 3, 9 / 16]) {
      const { width, height } = sizeForRatio(ratio);
      expect(width / height).toBeCloseTo(ratio, 1);
    }
  });
});
