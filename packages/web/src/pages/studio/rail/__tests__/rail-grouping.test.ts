// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { splitStudios } from '@web/pages/studio/rail/rail-grouping';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

function studio(
  id: string,
  role: StudioSummary['myStudioRole'],
  type: StudioSummary['type'] = 'team',
): StudioSummary {
  return { id, slug: id, name: id, type, memberCount: 1, myStudioRole: role };
}

describe('splitStudios (rail ④⑤ — spec §0.2 / §4.2, current-role split)', () => {
  it('puts admin studios in owned (④我的), creator + member in joined (⑤我加入的)', () => {
    const { owned, joined } = splitStudios([
      studio('personal', 'admin', 'personal'),
      studio('myteam', 'admin'),
      studio('granted', 'maintainer'),
      studio('joined', 'guest'),
    ]);

    expect(owned.map((s) => s.id)).toEqual(['personal', 'myteam']);
    expect(joined.map((s) => s.id)).toEqual(['granted', 'joined']);
  });

  it('preserves input order within each group (the list arrives personal-first)', () => {
    const { owned, joined } = splitStudios([
      studio('a', 'guest'),
      studio('b', 'admin'),
      studio('c', 'maintainer'),
    ]);

    expect(owned.map((s) => s.id)).toEqual(['b']);
    expect(joined.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('treats a null role (a guest — never present in the studios list) as neither group', () => {
    const { owned, joined } = splitStudios([studio('x', null)]);

    expect(owned).toEqual([]);
    expect(joined).toEqual([]);
  });
});
