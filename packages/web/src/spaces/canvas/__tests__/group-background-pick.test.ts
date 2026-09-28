// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  GROUP_BACKGROUND_OPTIONS,
  GROUP_BACKGROUND_TINTS,
  groupBackgroundFor,
} from '@web/spaces/canvas/group-background';

describe('GROUP_BACKGROUND_TINTS', () => {
  it('is every option the picker offers, without "no colour"', () => {
    expect(GROUP_BACKGROUND_TINTS).toEqual(
      GROUP_BACKGROUND_OPTIONS.map((option) => option.value).filter(
        (value) => value !== undefined,
      ),
    );
  });
});

describe('groupBackgroundFor', () => {
  it('turns a roll into one of the tints', () => {
    for (const roll of [0, 0.14, 0.5, 0.86, 0.999]) {
      expect(GROUP_BACKGROUND_TINTS).toContain(groupBackgroundFor(roll));
    }
  });

  it('reaches every tint, so no batch colour is unreachable', () => {
    const seen = new Set(
      Array.from({ length: 1000 }, (_, i) => groupBackgroundFor(i / 1000)),
    );

    expect(seen.size).toBe(GROUP_BACKGROUND_TINTS.length);
  });

  it('stays inside the palette at the very top of the range', () => {
    // Math.random() never returns 1, and a roll that did would otherwise index
    // one past the end.
    expect(GROUP_BACKGROUND_TINTS).toContain(groupBackgroundFor(1));
  });
});
