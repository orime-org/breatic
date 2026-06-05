// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  daysUntilExpiry,
  expiringDays,
  EXPIRY_WARNING_DAYS,
} from '@web/pages/studio/container/credit-util';

// Fixed "now" = 2026-06-05T00:00:00Z (deterministic, no real clock).
const NOW = Date.UTC(2026, 5, 5);

describe('daysUntilExpiry', () => {
  it('counts whole days forward', () => {
    expect(daysUntilExpiry('2026-06-12T00:00:00.000Z', NOW)).toBe(7);
  });

  it('is negative once the date has passed', () => {
    expect(daysUntilExpiry('2026-06-01T00:00:00.000Z', NOW)).toBe(-4);
  });
});

describe('expiringDays (gift "expiring soon" window)', () => {
  it('returns the remaining days inside the warning window', () => {
    expect(expiringDays('2026-06-10T00:00:00.000Z', NOW)).toBe(5);
  });

  it('treats the boundary day as still expiring', () => {
    expect(expiringDays('2026-06-12T00:00:00.000Z', NOW)).toBe(
      EXPIRY_WARNING_DAYS,
    );
  });

  it('returns null when far from expiry', () => {
    expect(expiringDays('2026-07-20T00:00:00.000Z', NOW)).toBeNull();
  });

  it('returns null when already expired', () => {
    expect(expiringDays('2026-06-01T00:00:00.000Z', NOW)).toBeNull();
  });

  it('returns null when the lot never expires', () => {
    expect(expiringDays(null, NOW)).toBeNull();
  });
});
