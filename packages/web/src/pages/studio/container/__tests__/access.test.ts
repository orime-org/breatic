// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  canManageItem,
  canRenderItemCard,
  effectiveItemRole,
} from '@web/pages/studio/container/access';
import type {
  ItemRole,
  ItemVisibility,
  StudioRole,
} from '@web/pages/studio/shared/studio-types';

// Exhaustive (studioRole × visibility × myRole) truth table for invariant 1.
// Expected values are hand-authored literals (NOT recomputed from the impl)
// so the matrix genuinely pins the rule rather than mirroring the code.
const RENDER_MATRIX: ReadonlyArray<
  [StudioRole, ItemVisibility, ItemRole | null, boolean]
> = [
  ['admin', 'studio', 'owner', true],
  ['admin', 'studio', 'editor', true],
  ['admin', 'studio', 'viewer', true],
  ['admin', 'studio', null, true],
  ['admin', 'private', 'owner', true],
  ['admin', 'private', 'editor', true],
  ['admin', 'private', 'viewer', true],
  ['admin', 'private', null, true],
  ['member', 'studio', 'owner', true],
  ['member', 'studio', 'editor', true],
  ['member', 'studio', 'viewer', true],
  ['member', 'studio', null, true],
  ['member', 'private', 'owner', true],
  ['member', 'private', 'editor', true],
  ['member', 'private', 'viewer', true],
  ['member', 'private', null, false], // the ONLY hidden case
];

describe('studio access — canRenderItemCard (invariant 1: visibility filter)', () => {
  it.each(RENDER_MATRIX)(
    'studio=%s / vis=%s / role=%s → render=%s',
    (studioRole, visibility, myRole, expected) => {
      expect(canRenderItemCard(studioRole, { visibility, myRole })).toBe(
        expected,
      );
    },
  );

  it('the matrix is exhaustive (all 16 role × visibility × myRole combos)', () => {
    expect(RENDER_MATRIX).toHaveLength(2 * 2 * 4);
  });

  it('a plain Member never sees a private item they have no role on', () => {
    expect(
      canRenderItemCard('member', { visibility: 'private', myRole: null }),
    ).toBe(false);
  });
});

// Exhaustive (studioRole × isOwner) truth table for invariant 2.
const MANAGE_MATRIX: ReadonlyArray<[StudioRole, boolean, boolean]> = [
  ['admin', true, true],
  ['admin', false, true],
  ['member', true, true],
  ['member', false, false], // non-owner Member: no governance
];

describe('studio access — canManageItem (invariant 2: governance buttons)', () => {
  it.each(MANAGE_MATRIX)(
    'studio=%s / owner=%s → manage=%s',
    (studioRole, isOwner, expected) => {
      expect(canManageItem(studioRole, isOwner)).toBe(expected);
    },
  );

  it('a non-owner Member never gets governance controls', () => {
    expect(canManageItem('member', false)).toBe(false);
  });
});

describe('studio access — effectiveItemRole', () => {
  it('falls back to baseline viewer when role is null', () => {
    expect(effectiveItemRole(null)).toBe('viewer');
  });

  it('keeps the explicit role otherwise', () => {
    expect(effectiveItemRole('editor')).toBe('editor');
  });
});
