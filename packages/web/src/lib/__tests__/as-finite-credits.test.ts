// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { asFiniteCredits } from '@web/lib/as-finite-credits';

describe('asFiniteCredits (shared credits gate — node history + activity feed)', () => {
  it('returns a finite number unchanged, including 0 and fractional values', () => {
    // INV-8: raw value, never rounded; 0 shows, 1.5 shows as-is.
    expect(asFiniteCredits(0)).toBe(0);
    expect(asFiniteCredits(1.5)).toBe(1.5);
    expect(asFiniteCredits(42)).toBe(42);
  });

  it('returns undefined for absent / non-finite values (never NaN / undefined text)', () => {
    expect(asFiniteCredits(undefined)).toBeUndefined();
    expect(asFiniteCredits(null)).toBeUndefined();
    expect(asFiniteCredits(Number.NaN)).toBeUndefined();
    expect(asFiniteCredits(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asFiniteCredits('3')).toBeUndefined();
  });
});
