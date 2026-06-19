// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  creatableStudios,
  defaultCreateStudioId,
} from '@web/pages/studio/container/dialogs/studio-create';
import type {
  StudioDetail,
  StudioSummary,
} from '@web/pages/studio/shared/studio-types';

const personal: StudioSummary = {
  id: 's-me',
  slug: 'me',
  name: 'Me',
  type: 'personal',
  memberCount: 1,
  myStudioRole: 'admin',
};
const teamAdmin: StudioSummary = {
  id: 's-a',
  slug: 'team-a',
  name: 'Team A',
  type: 'team',
  memberCount: 3,
  myStudioRole: 'admin',
};
const teamMaintainer: StudioSummary = {
  id: 's-c',
  slug: 'team-c',
  name: 'Team C',
  type: 'team',
  memberCount: 5,
  myStudioRole: 'maintainer',
};
const teamGuest: StudioSummary = {
  id: 's-m',
  slug: 'team-m',
  name: 'Team M',
  type: 'team',
  memberCount: 8,
  myStudioRole: 'guest',
};

const ALL = [personal, teamAdmin, teamMaintainer, teamGuest];

describe('creatableStudios (spec §8.2 — admin or maintainer may create)', () => {
  it('keeps admin and maintainer studios, drops guest studios', () => {
    expect(creatableStudios(ALL).map((s) => s.id)).toEqual([
      's-me',
      's-a',
      's-c',
    ]);
  });

  it('returns an empty list when the viewer is only a guest', () => {
    expect(creatableStudios([teamGuest])).toEqual([]);
  });
});

describe('defaultCreateStudioId (spec §7.1 — default selection)', () => {
  const asDetail = (s: StudioSummary): StudioDetail => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    type: s.type,
    memberCount: s.memberCount,
    myStudioRole: s.myStudioRole,
  });

  it('defaults to the personal studio for a global (rail) entry — no current studio', () => {
    expect(defaultCreateStudioId(ALL)).toBe('s-me');
  });

  it('defaults to the current studio when the viewer is its admin', () => {
    expect(defaultCreateStudioId(ALL, asDetail(teamAdmin))).toBe('s-a');
  });

  it('falls back to the personal studio when the viewer is only a guest of the current studio', () => {
    expect(defaultCreateStudioId(ALL, asDetail(teamGuest))).toBe('s-me');
  });

  it('falls back to the personal studio when the viewer is a maintainer (not admin) of the current studio', () => {
    // Spec §7.1: defaulting to the current studio requires admin; a maintainer can
    // still create there (it stays in the selector), but the default is personal.
    expect(defaultCreateStudioId(ALL, asDetail(teamMaintainer))).toBe('s-me');
  });

  it('returns undefined when no creatable studio exists', () => {
    expect(defaultCreateStudioId([teamGuest])).toBeUndefined();
  });
});
