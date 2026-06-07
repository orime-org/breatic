// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

/** The viewer's studios split into the rail's two groups (spec §4.2). */
export interface RailStudioGroups {
  /** ④ 我的 studio — studios I currently administer (`myStudioRole === 'admin'`). */
  owned: readonly StudioSummary[];
  /** ⑤ 我加入的 studio — studios I'm in but don't own (`creator` / `member`). */
  joined: readonly StudioSummary[];
}

/**
 * Split the viewer's studios into the rail's 我的 (④) / 我加入的 (⑤) groups by
 * the viewer's CURRENT role (spec §0.2 — transfer-safe, NOT by the immutable
 * `createdByUserId`): `admin` → owned (I administer it), `creator` / `member` →
 * joined (I'm in it but don't own it). Input order is preserved (the list
 * arrives personal-first from `GET /studios`). A `null` role (a guest — never
 * present in the viewer's own studios list) falls into neither group.
 * @param studios the viewer's studios from `GET /studios`, each with `myStudioRole`.
 * @returns the studios partitioned into `owned` (④) and `joined` (⑤).
 */
export function splitStudios(
  studios: readonly StudioSummary[],
): RailStudioGroups {
  return {
    owned: studios.filter((s) => s.myStudioRole === 'admin'),
    joined: studios.filter(
      (s) => s.myStudioRole === 'creator' || s.myStudioRole === 'member',
    ),
  };
}
