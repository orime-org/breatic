// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

/** The viewer's studios split into the rail's two groups (spec §4.2). */
export interface RailStudioGroups {
  /** ④ "My studios" — studios I currently administer (`myStudioRole === 'admin'`). */
  owned: readonly StudioSummary[];
  /** ⑤ "Joined studios" — studios I'm in but don't own (`creator` / `member`). */
  joined: readonly StudioSummary[];
}

/**
 * Split the viewer's studios into the rail's "My studios" (④) / "Joined
 * studios" (⑤) groups by
 * the viewer's CURRENT role (spec §0.2 — transfer-safe, NOT by the immutable
 * `createdByUserId`): `admin` → owned (I administer it), `maintainer` / `guest` →
 * joined (I'm in it but don't own it). Input order is preserved (the list
 * arrives personal-first from `GET /studios`). A `null` role (a non-member —
 * never present in the viewer's own studios list) falls into neither group.
 * @param studios the viewer's studios from `GET /studios`, each with `myStudioRole`.
 * @returns the studios partitioned into `owned` (④) and `joined` (⑤).
 */
export function splitStudios(
  studios: readonly StudioSummary[],
): RailStudioGroups {
  return {
    owned: studios.filter((s) => s.myStudioRole === 'admin'),
    joined: studios.filter(
      (s) => s.myStudioRole === 'maintainer' || s.myStudioRole === 'guest',
    ),
  };
}
