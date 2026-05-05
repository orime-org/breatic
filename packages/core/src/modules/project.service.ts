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

import * as projectRepo from "./project.repo.js";
import * as projectAuthService from "./projectAuth.service.js";
import * as studioService from "./studio.service.js";
import * as userRepo from "./user.repo.js";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError } from "../errors.js";
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
 *
 * @param projectId - Project UUID from untrusted client input
 * @param userId - Authenticated user UUID
 * @param minRole - Minimum role required (defaults to `'view'`)
 * @throws {@link NotFoundError} if the project does not exist or the
 *   caller has no membership (we collapse 404 and 403-no-membership
 *   into 404 to avoid leaking project existence to outsiders)
 * @throws {@link ForbiddenError} if the caller's membership is below
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
 * Resolves (or lazily creates) the caller's personal studio so
 * `projects.studio_id` and the owner row in `project_members` are
 * filled in correctly. Returns the freshly created project.
 *
 * @param userId - Authenticated user UUID (becomes the project owner)
 * @param name - Project name
 * @param description - Optional description
 */
export async function create(
  userId: string,
  name: string,
  description?: string,
): Promise<ProjectEntity> {
  const user = await userRepo.getUserById(userId);
  const studio = await studioService.ensurePersonalStudio(
    userId,
    user?.username ?? null,
  );
  return projectRepo.createProject(studio.id, userId, name, description);
}

/**
 * Fetch a project the caller has at least `view` access to.
 *
 * Returns the entity unchanged. Routes that need to surface the
 * caller's role to the frontend (`ProjectDetail.myRole`) should
 * compose this with `loadProjectRole`.
 *
 * @throws {@link NotFoundError} on missing project / no membership
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
 * feature (see spec §16 ★ "/studio 协作中的项目入口"); not exposed
 * here in V1.
 */
export async function list(
  userId: string,
  limit?: number,
  offset?: number,
): Promise<ProjectEntity[]> {
  const user = await userRepo.getUserById(userId);
  const studio = await studioService.ensurePersonalStudio(
    userId,
    user?.username ?? null,
  );
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
 *
 * @throws {@link NotFoundError} if the project doesn't exist or the
 *   caller has no membership
 * @throws {@link ForbiddenError} if the caller is below `edit`
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
 *
 * @param sourceId - UUID of the project to duplicate
 * @param userId - Authenticated user UUID (becomes new project owner)
 * @throws {@link NotFoundError} if the source project does not exist
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
 */
export async function deleteProject(
  projectId: string,
  userId: string,
): Promise<void> {
  await assertAccess(projectId, userId, "owner");
  await projectRepo.deleteProject(projectId);
}
