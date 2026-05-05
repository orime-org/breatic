/**
 * Project authorization service — `loadProjectRole`.
 *
 * Single-source-of-truth permission lookup, consumed by:
 *
 *   - server `requireRole` middleware (this PR)
 *   - collab `onAuthenticate` hook (PR-C)
 *
 * Returns `null` in two cases:
 *
 *   - the project does not exist (or is soft-deleted)
 *   - the user is not an active member of that project
 *
 * Both surface as `403 Forbidden` at the caller — never leaking
 * project existence to a non-member by distinguishing 404 vs 403.
 * (Cross-tenant existence probing was the BUG-048 class of issue.)
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects } from "../db/schema.js";
import * as projectMembersRepo from "./projectMembers.repo.js";
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
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (projectRows.length === 0) return null;

  return projectMembersRepo.getRole(projectId, userId);
}
