// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Studio authorization primitive — `loadStudioRole`.
 *
 * Mirrors `loadProjectRole`: the shared "what studio-level role does this
 * user have" resolver, used by server (studio detail / governance, and the
 * project list and project entry that need to know whether a viewer is a
 * studio member) and worker (billing_source). It delegates to
 * `studioMembersRepo.getRole`, which folds the studio-active guard and
 * the membership lookup into one inner-join and collapses both "studio
 * missing/deleted" and "user not a member" to `null`.
 *
 * Lives in `@breatic/domain`, NOT `@breatic/core` (where `loadProjectRole`
 * lives): collab's `onAuthenticate` reads `project_members` only and
 * never needs the studio role, so studio auth is server+worker-only =
 * domain. (This refines the DD's earlier "core" placement, which assumed
 * collab would compute the studio role — superseded by the simplification
 * that collab reads `project_members` and never recomputes studio/baseline.)
 */

import { ForbiddenError } from "@breatic/core";
import { t, STUDIO_ROLE_RANK } from "@breatic/shared";
import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import type { StudioRole } from "@breatic/shared";

/**
 * Resolve the caller's studio-level role on a studio.
 * @param userId - Authenticated user UUID
 * @param studioId - Studio UUID
 * @returns The role, or `null` if the studio is missing/deleted or the
 *   user has no active membership
 */
export async function loadStudioRole(
  userId: string,
  studioId: string,
): Promise<StudioRole | null> {
  return studioMembersRepo.getRole(studioId, userId);
}

/**
 * Refuse unless the caller holds at least `min` on the studio.
 *
 * The same answer `requireStudioRole` gives for a route keyed by slug: a
 * missing studio and a non-member are both a plain 403, so the refusal does
 * not tell a stranger the studio exists.
 * @param userId - Authenticated user UUID
 * @param studioId - Studio UUID
 * @param min - Lowest role that passes
 * @returns Nothing when the caller passes
 * @throws {ForbiddenError} When the caller's role is below `min`, or they have none
 */
export async function assertStudioRole(
  userId: string,
  studioId: string,
  min: StudioRole,
): Promise<void> {
  const role = await loadStudioRole(userId, studioId);
  if (role === null || STUDIO_ROLE_RANK[role] < STUDIO_ROLE_RANK[min]) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
}
