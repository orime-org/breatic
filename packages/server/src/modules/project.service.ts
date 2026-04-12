/**
 * Project service — business logic for canvas projects.
 *
 * Enforces ownership checks at the service layer before delegating
 * to the project repository. Projects support soft delete.
 */

import * as projectRepo from "./project.repo.js";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError } from "../errors.js";
import type { ProjectEntity } from "@breatic/shared";

/**
 * Validate that a project exists and belongs to the given user.
 *
 * @param projectId - Project UUID
 * @param userId - Requesting user UUID
 * @returns The validated project entity
 * @throws NotFoundError if project does not exist or is soft-deleted
 * @throws ForbiddenError if userId does not match the project owner
 */
async function validateOwnership(
  projectId: string,
  userId: string,
): Promise<ProjectEntity> {
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  if (project.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  return project;
}

/**
 * Create a new project.
 *
 * @param userId - Owner user UUID
 * @param name - Project name
 * @param description - Optional project description
 * @returns The newly created project entity
 */
export async function create(
  userId: string,
  name: string,
  description?: string,
): Promise<ProjectEntity> {
  return projectRepo.createProject(userId, name, description);
}

/**
 * Get a project by ID with ownership enforcement.
 *
 * @param projectId - Project UUID
 * @param userId - Requesting user UUID
 * @returns The project entity
 * @throws NotFoundError if project does not exist
 * @throws ForbiddenError if userId does not match the project owner
 */
export async function get(projectId: string, userId: string): Promise<ProjectEntity> {
  return validateOwnership(projectId, userId);
}

/**
 * Assert that the given user may access the given project.
 *
 * Shared entry point for REST route handlers and Collab auth hooks
 * that need to reject cross-tenant access before doing any work. A
 * thin alias over {@link get} that discards the returned entity so
 * call sites read as an assertion rather than a fetch.
 *
 * @param projectId - Project UUID from untrusted client input
 * @param userId - Authenticated user UUID from the session
 * @throws NotFoundError if project does not exist or is soft-deleted
 * @throws ForbiddenError if the user does not own the project
 */
export async function assertAccess(
  projectId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(projectId, userId);
}

/**
 * List projects for a user, ordered by most recently updated.
 *
 * @param userId - Owner user UUID
 * @param limit - Maximum number of results
 * @param offset - Pagination offset
 * @returns Array of project entities
 */
export async function list(
  userId: string,
  limit?: number,
  offset?: number,
): Promise<ProjectEntity[]> {
  return projectRepo.listProjectsByUser(userId, limit, offset);
}

/**
 * Save a canvas data snapshot to a project.
 *
 * @param projectId - Project UUID
 * @param userId - Requesting user UUID
 * @param canvasData - Canvas state to persist
 * @throws NotFoundError if project does not exist
 * @throws ForbiddenError if userId does not match the project owner
 */
export async function saveCanvas(
  projectId: string,
  userId: string,
  canvasData: Record<string, unknown>,
): Promise<void> {
  await validateOwnership(projectId, userId);
  await projectRepo.updateCanvas(projectId, canvasData);
}

/**
 * Update mutable project metadata (name / description / thumbnail).
 *
 * @param projectId - Project UUID
 * @param userId - Requesting user UUID
 * @param patch - Fields to update (undefined skipped, null clears)
 * @returns The updated project entity
 * @throws NotFoundError if project does not exist or was soft-deleted
 * @throws ForbiddenError if userId does not match the project owner
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
  await validateOwnership(projectId, userId);
  const updated = await projectRepo.updateProjectMeta(projectId, patch);
  if (!updated) throw new NotFoundError(t("server.error.not_found"));
  return updated;
}

/**
 * Duplicate a project — create a new project row with a fresh UUID
 * and copy every Yjs document belonging to the source project.
 *
 * The new project belongs to the same user. Ownership of the source
 * is enforced: a user cannot duplicate another user's project even
 * if they know its UUID. (This is the same cross-tenant guard as
 * every other project-scoped route; see PR #48.)
 *
 * Asset URLs inside the duplicated Yjs blobs continue to reference
 * the original OSS / S3 objects. That is intentional — duplication
 * is cheap and does not re-upload anything. See the repo layer for
 * the full list of what is and is not carried over.
 *
 * @param sourceId - UUID of the project to duplicate
 * @param userId - Authenticated user UUID (also becomes the new
 *   project's owner)
 * @returns The freshly created project entity
 * @throws NotFoundError if the source project does not exist
 * @throws ForbiddenError if the user does not own the source project
 */
export async function duplicate(
  sourceId: string,
  userId: string,
): Promise<ProjectEntity> {
  await validateOwnership(sourceId, userId);
  const copy = await projectRepo.duplicateProject(userId, sourceId);
  if (!copy) throw new NotFoundError(t("server.error.not_found"));
  return copy;
}

/**
 * Soft-delete a project after validating ownership.
 *
 * @param projectId - Project UUID
 * @param userId - Requesting user UUID
 * @throws NotFoundError if project does not exist
 * @throws ForbiddenError if userId does not match the project owner
 */
export async function deleteProject(
  projectId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(projectId, userId);
  await projectRepo.deleteProject(projectId);
}
