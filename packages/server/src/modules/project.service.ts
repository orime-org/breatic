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
