// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { formatCredits } from '@web/lib/format-credits';

describe('formatCredits (shared credits gate — node history + activity feed)', () => {
  it('returns a finite number unchanged, including 0 and fractional values', () => {
    // INV-8: raw value, never rounded; 0 shows, 1.5 shows as-is.
    expect(formatCredits(0)).toBe(0);
    expect(formatCredits(1.5)).toBe(1.5);
    expect(formatCredits(42)).toBe(42);
  });

  it('returns undefined for absent / non-finite values (never NaN / undefined text)', () => {
    expect(formatCredits(undefined)).toBeUndefined();
    expect(formatCredits(null)).toBeUndefined();
    expect(formatCredits(Number.NaN)).toBeUndefined();
    expect(formatCredits(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatCredits('3')).toBeUndefined();
  });
});
