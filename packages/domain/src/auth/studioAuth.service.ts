// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio authorization primitive — `loadStudioRole`.
 *
 * Mirrors `loadProjectRole`: the shared "what studio-level role does this
 * user have" resolver, used by server (studio detail / governance + the
 * project-visibility filter that needs to know whether a viewer is a
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
