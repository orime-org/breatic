// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project service — business logic for canvas projects.
 *
 * v10: ownership lives in `project_members` rather than on the
 * project row. Permission decisions go through
 * {@link projectAuthService.loadProjectRole}; this service exposes a
 * thin {@link assertAccess} for callers that aren't behind the
 * `requireRole` route middleware (internal services, BullMQ
 * handlers, the legacy assertAccess-only call sites).
 *
 * Project creation is layered: studio.service guarantees a personal
 * studio exists, then project.repo.createProject seeds the project +
 * owner row in one transaction.
 */

import * as projectRepo from "@server/modules/project/project.repo.js";
import { projectAuthService } from "@breatic/core";
import * as studioService from "@server/modules/studio/studio.service.js";
import { db } from "@breatic/core";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError } from "@breatic/core";
import { ROLE_RANK } from "@breatic/shared";
import type { ProjectEntity, ProjectRole } from "@breatic/shared";

/**
 * Throw if the user does not have at least `minRole` on the project.
 *
 * Defaults to `'view'` — callers that need stronger checks pass
 * `'edit'` or `'owner'` explicitly. Routes with `requireRole`
 * middleware do not need this redundantly, but inner services
 * (conversation.service, BullMQ task path) call it as defense in
 * depth.
 * @param projectId - Project UUID from untrusted client input
 * @param userId - Authenticated user UUID
 * @param minRole - Minimum role required (defaults to `'view'`)
 * @throws {NotFoundError} if the project does not exist or the
 *   caller has no membership (we collapse 404 and 403-no-membership
 *   into 404 to avoid leaking project existence to outsiders)
 * @throws {ForbiddenError} if the caller's membership is below
 *   `minRole`
 */
export async function assertAccess(
  projectId: string,
  userId: string,
  minRole: ProjectRole = "view",
): Promise<void> {
  const role = await projectAuthService.loadProjectRole(userId, projectId);
  if (role === null) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
}

/**
 * Create a new project owned by the caller.
 *
 * Atomically writes, in a single transaction:
 *   1. `projects` row (in caller's personal studio)
 *   2. `project_members` row (`role='owner'`)
 *
 * The default Canvas Space is NOT seeded here any more: the Yjs
 * document store moved to a separate database that can't share this
 * business transaction. Instead collab lazy-seeds the `project-{id}/meta`
 * doc with one default Space on its first load (deterministic Space id
 * derived from the project id, so concurrent first-loads converge), and
 * the awareness hook backfills the creator's real name/avatar when they
 * first connect. The "project exists ⇒ ≥1 Space" invariant the frontend
 * relies on is preserved by that read-time seed, not an eager write.
 * @param userId - Authenticated user UUID (becomes the project owner)
 * @param name - Project name
 * @param description - Optional description
 * @returns The newly created project entity
 * @throws {NotFoundError} if the user has no personal studio yet (they
 *   have not completed the slug-setup onboarding step — a user without a
 *   studio cannot own a project)
 */
export async function create(
  userId: string,
  name: string,
  description?: string,
): Promise<ProjectEntity> {
  const studio = await requirePersonalStudio(userId);

  return db.transaction(async (tx) =>
    projectRepo.createProject(tx, studio.id, userId, name, description),
  );
}

/**
 * Resolve the caller's personal studio, throwing if they have not yet
 * completed onboarding.
 *
 * Personal studios are created explicitly in the slug-setup step, no
 * longer auto-created on demand. Project routes are reachable only after
 * the frontend onboarding gate, so a missing studio here means a direct
 * API call by a half-onboarded account — surface it as 404 (same
 * existence-hiding convention as `assertAccess`).
 * @param userId - Authenticated user UUID
 * @returns The user's personal studio
 * @throws {NotFoundError} if the user has no personal studio
 */
async function requirePersonalStudio(
  userId: string,
): Promise<{ id: string }> {
  const studio = await studioService.getPersonalStudio(userId);
  if (!studio) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return studio;
}

/**
 * Fetch a project the caller has at least `view` access to.
 *
 * Returns the entity unchanged. Routes that need to surface the
 * caller's role to the frontend (`ProjectDetail.myRole`) should
 * compose this with `loadProjectRole`.
 * @param projectId - Project UUID to fetch
 * @param userId - Authenticated user UUID; must have at least `view` access
 * @returns The project entity
 * @throws {NotFoundError} on missing project / no membership
 */
export async function get(projectId: string, userId: string): Promise<ProjectEntity> {
  await assertAccess(projectId, userId, "view");
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  return project;
}

/**
 * List projects in the caller's personal studio (V1).
 *
 * V1 personal-Studio mode: every user has exactly one studio.
 * "Projects shared with me but owned by others" is a Studio-phase
 * feature (see spec §16 ★ "shared-projects entry on /studio"); not exposed
 * here in V1.
 * @param userId - Authenticated user UUID (owner of the personal studio)
 * @param limit - Page size
 * @param offset - Pagination offset
 * @returns The user's project entities in their personal studio
 * @throws {NotFoundError} if the user has no personal studio yet
 *   (onboarding incomplete)
 */
export async function list(
  userId: string,
  limit?: number,
  offset?: number,
): Promise<ProjectEntity[]> {
  const studio = await requirePersonalStudio(userId);
  return projectRepo.listProjectsByStudio(studio.id, limit, offset);
}

/**
 * Update mutable project metadata.
 *
 * Requires at least `edit` on the project — name / description /
 * thumbnail are content edits, not just admin operations. The
 * `requireRole('edit')` middleware on the PUT route enforces the
 * same; this service-side check is defense in depth for non-route
 * callers.
 * @param projectId - Project UUID to update
 * @param userId - Authenticated user UUID; must have at least `edit` access
 * @param patch - Fields to update
 * @param patch.name - New project name
 * @param patch.description - New description; `null` clears it
 * @param patch.thumbnailUrl - New thumbnail URL; `null` clears it
 * @returns The updated project entity
 * @throws {NotFoundError} if the project doesn't exist or the
 *   caller has no membership
 * @throws {ForbiddenError} if the caller is below `edit`
 */
export async function update(
  projectId: string,
  userId: string,
  patch: {
    name?: string;
    description?: string | null;
    thumbnailUrl?: string | null;
  },
): Promise<ProjectEntity> {
  await assertAccess(projectId, userId, "edit");
  const updated = await projectRepo.updateProjectMeta(projectId, patch);
  if (!updated) throw new NotFoundError(t("server.error.not_found"));
  return updated;
}

/**
 * Duplicate a project — the duplicate is owned by the caller.
 *
 * The caller becomes the owner of the new project (same studio as
 * the source). Source must be visible to the caller (any active
 * membership counts; you can fork something you can read).
 * @param sourceId - UUID of the project to duplicate
 * @param userId - Authenticated user UUID (becomes new project owner)
 * @returns The newly created duplicate project entity
 * @throws {NotFoundError} if the source project does not exist
 *   or the caller has no membership
 */
export async function duplicate(
  sourceId: string,
  userId: string,
): Promise<ProjectEntity> {
  await assertAccess(sourceId, userId, "view");
  const copy = await projectRepo.duplicateProject(userId, sourceId);
  if (!copy) throw new NotFoundError(t("server.error.not_found"));
  return copy;
}

/**
 * Soft-delete a project after verifying the caller is `owner`.
 *
 * Cascades soft delete to conversations, tasks, node history, member
 * rows, project memories and yjs documents (all in one tx).
 * @param projectId - Project UUID to delete
 * @param userId - Authenticated user UUID; must be the project `owner`
 */
export async function deleteProject(
  projectId: string,
  userId: string,
): Promise<void> {
  await assertAccess(projectId, userId, "owner");
  await projectRepo.deleteProject(projectId);
}
