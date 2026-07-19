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

describe('splitStudios (rail — personal / my-team / joined, three-way #1661)', () => {
  it('splits into personal (type), my-team (team+admin), joined (team+maintainer/guest)', () => {
    const { personal, myTeam, joined } = splitStudios([
      studio('me', 'admin', 'personal'),
      studio('myteam', 'admin'),
      studio('granted', 'maintainer'),
      studio('joined', 'guest'),
    ]);

    expect(personal.map((s) => s.id)).toEqual(['me']);
    expect(myTeam.map((s) => s.id)).toEqual(['myteam']);
    expect(joined.map((s) => s.id)).toEqual(['granted', 'joined']);
  });

  it('keeps a personal studio OUT of my-team even though its role is admin', () => {
    // A personal studio's creator is its admin; the split is by `type` first, so
    // personal never leaks into the team group (the whole point of #1661).
    const { personal, myTeam } = splitStudios([studio('me', 'admin', 'personal')]);
    expect(personal.map((s) => s.id)).toEqual(['me']);
    expect(myTeam).toEqual([]);
  });

  it('preserves input order within each group (the list arrives personal-first)', () => {
    const { myTeam, joined } = splitStudios([
      studio('a', 'guest'),
      studio('b', 'admin'),
      studio('c', 'maintainer'),
    ]);

    expect(myTeam.map((s) => s.id)).toEqual(['b']);
    expect(joined.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('treats a null role (a non-member — never present in the studios list) as no group', () => {
    const { personal, myTeam, joined } = splitStudios([studio('x', null)]);

    expect(personal).toEqual([]);
    expect(myTeam).toEqual([]);
    expect(joined).toEqual([]);
  });
});
