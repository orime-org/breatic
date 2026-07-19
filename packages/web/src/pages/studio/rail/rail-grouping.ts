// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

/** The viewer's studios split into the rail's three groups (#1661). */
export interface RailStudioGroups {
  /** ① "Personal Studio" — the viewer's own personal studio (`type === 'personal'`). */
  personal: readonly StudioSummary[];
  /** ② "My Team Studios" — team studios I currently administer (`type === 'team' && myStudioRole === 'admin'`). */
  myTeam: readonly StudioSummary[];
  /** ③ "Joined Studios" — team studios I'm in but don't administer (`maintainer` / `guest`). */
  joined: readonly StudioSummary[];
}

/**
 * Split the viewer's studios into the rail's three groups (#1661): the personal
 * studio, the team studios I administer, and the team studios I joined. Personal
 * is peeled off by `type` FIRST — a personal studio's creator is also its admin,
 * so without the type gate it would leak into the team group (the bug #1661
 * fixes). The team split then uses the viewer's CURRENT role (transfer-safe, NOT
 * the immutable `createdByUserId` — see the ownership principle): `admin` → my
 * team (I administer it), `maintainer` / `guest` → joined (I'm in it, don't own
 * it). Input order is preserved. A `null` role (a non-member — never present in
 * the viewer's own studios list) falls into no group.
 * @param studios the viewer's studios from `GET /studios`, each with `type` + `myStudioRole`.
 * @returns the studios partitioned into `personal` (①), `myTeam` (②) and `joined` (③).
 */
export function splitStudios(
  studios: readonly StudioSummary[],
): RailStudioGroups {
  return {
    personal: studios.filter((s) => s.type === 'personal'),
    myTeam: studios.filter(
      (s) => s.type === 'team' && s.myStudioRole === 'admin',
    ),
    joined: studios.filter(
      (s) =>
        s.type === 'team' &&
        (s.myStudioRole === 'maintainer' || s.myStudioRole === 'guest'),
    ),
  };
}
