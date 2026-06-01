/**
 * Project authorization primitive — `loadProjectRole`.
 *
 * The single shared "what role does this user have on this project"
 * resolver, imported by BOTH:
 *
 *   - server `requireRole` middleware + `project.service`
 *   - collab `onAuthenticate` hook
 *
 * It lives in @breatic/core because auth / role resolution must be
 * identical across every backend service. collab used to hand-roll
 * its own copy (raw SQL in `collab/auth.ts`), which drifted from this
 * one; both now call this single primitive.
 *
 * Returns `null` in two cases — the project does not exist (or is
 * soft-deleted), or the user is not an active member. Both collapse
 * to `null` so a caller surfaces one generic `403 Forbidden` and
 * never leaks project existence to a non-member by distinguishing
 * 404 vs 403 (the BUG-048 cross-tenant-probe class). The
 * project-active guard lives inside `projectMembersRepo.getRole`'s
 * inner-join, so this layer holds no raw `db` access.
 */

import * as projectMembersRepo from "@core/auth/projectMembers.repo.js";
import type { ProjectRole } from "@breatic/shared";

/**
 * Resolve the caller's role on a project.
 *
 * @param userId - Authenticated user UUID
 * @param projectId - Project UUID from request input
 * @returns The role, or `null` if the project is missing/deleted or
 *   the user has no active membership
 */
export async function loadProjectRole(
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  return projectMembersRepo.getRole(projectId, userId);
}
