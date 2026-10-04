// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project authorization primitive — `loadProjectRole`.
 *
 * The single shared "what role does this user have on this project"
 * resolver, imported by BOTH:
 *
 *   - server `requireRole` middleware + `project.service`
 *   - collab `onAuthenticate` hook
 *
 * It lives in `@breatic/core` because auth / role resolution must be
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
import type { ProjectAccess } from "@core/auth/projectMembers.repo.js";
import type { ProjectRole } from "@breatic/shared";

/**
 * Resolve the role a caller may WRITE with on a project.
 *
 * An archived project is read-only for everyone, so every member reads as
 * viewer there. This is the single point that makes it so: every write gate
 * (server `requireRole` / `assertAccess`, collab `onAuthenticate`) reads it.
 * @param userId - Authenticated user UUID
 * @param projectId - Project UUID from request input
 * @returns The role (viewer on an archived project), or `null` if the project
 *   is missing/deleted or the user has no active membership
 */
export async function loadProjectRole(
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const access = await projectMembersRepo.getAccess(projectId, userId);
  if (access === null) return null;
  return access.archived ? "viewer" : access.role;
}

/**
 * Resolve a caller's real role on a project and whether it is archived — what
 * the project page shows. A write is gated on it only through the project
 * management rule, which reads the archive state alongside the role; every
 * other write gates on {@link loadProjectRole}.
 * @param userId - Authenticated user UUID
 * @param projectId - Project UUID from request input
 * @returns The stored role and archive state, or `null` if the project is
 *   missing/deleted or the user has no active membership
 */
export async function loadProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccess | null> {
  return projectMembersRepo.getAccess(projectId, userId);
}
