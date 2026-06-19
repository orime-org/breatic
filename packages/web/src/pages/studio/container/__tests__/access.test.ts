// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  canCreateInStudio,
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
  ['guest', 'studio', 'owner', true],
  ['guest', 'studio', 'editor', true],
  ['guest', 'studio', 'viewer', true],
  ['guest', 'studio', null, true],
  ['guest', 'private', 'owner', true],
  ['guest', 'private', 'editor', true],
  ['guest', 'private', 'viewer', true],
  ['guest', 'private', null, false], // the ONLY hidden case
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

  it('a plain Guest never sees a private item they have no role on', () => {
    expect(
      canRenderItemCard('guest', { visibility: 'private', myRole: null }),
    ).toBe(false);
  });
});

// Exhaustive (studioRole × isOwner) truth table for invariant 2.
const MANAGE_MATRIX: ReadonlyArray<[StudioRole, boolean, boolean]> = [
  ['admin', true, true],
  ['admin', false, true],
  ['guest', true, true],
  ['guest', false, false], // non-owner Guest: no governance
];

describe('studio access — canManageItem (invariant 2: governance buttons)', () => {
  it.each(MANAGE_MATRIX)(
    'studio=%s / owner=%s → manage=%s',
    (studioRole, isOwner, expected) => {
      expect(canManageItem(studioRole, isOwner)).toBe(expected);
    },
  );

  it('a non-owner Guest never gets governance controls', () => {
    expect(canManageItem('guest', false)).toBe(false);
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

// Decision A: the studio shell is public, so a guest (`null` studio role — a
// non-member viewing) can reach the tabs. A non-member sees only studio-visible
// items and manages nothing. Exhaustive over (visibility × myRole).
const GUEST_RENDER_MATRIX: ReadonlyArray<
  [ItemVisibility, ItemRole | null, boolean]
> = [
  ['studio', 'owner', true],
  ['studio', 'editor', true],
  ['studio', 'viewer', true],
  ['studio', null, true],
  ['private', 'owner', true],
  ['private', 'editor', true],
  ['private', 'viewer', true],
  ['private', null, false], // guest, private, no role → hidden
];

describe('studio access — guest (null studio role, decision A)', () => {
  it.each(GUEST_RENDER_MATRIX)(
    'guest / vis=%s / role=%s → render=%s',
    (visibility, myRole, expected) => {
      expect(canRenderItemCard(null, { visibility, myRole })).toBe(expected);
    },
  );

  it('a guest sees a studio-visible item but never a private item they have no role on', () => {
    expect(canRenderItemCard(null, { visibility: 'studio', myRole: null })).toBe(
      true,
    );
    expect(
      canRenderItemCard(null, { visibility: 'private', myRole: null }),
    ).toBe(false);
  });

  it('a guest never gets governance controls', () => {
    expect(canManageItem(null, false)).toBe(false);
  });
});

describe('studio access — canCreateInStudio (spec §0.2/§8.2 create gate)', () => {
  const MATRIX: ReadonlyArray<[StudioRole | null, boolean]> = [
    ['admin', true],
    ['maintainer', true],
    ['guest', false],
    [null, false],
  ];
  it.each(MATRIX)('role=%s → canCreate=%s', (role, expected) => {
    expect(canCreateInStudio(role)).toBe(expected);
  });
});
