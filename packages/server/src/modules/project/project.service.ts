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
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { projectAuthService, projectMembersRepo } from "@breatic/core";
import * as studioService from "@server/modules/studio/studio.service.js";
import { studioAuthService } from "@breatic/domain";
import { db, getLimitsForStudio } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError, ConflictError } from "@breatic/core";
import { ROLE_RANK } from "@breatic/shared";
import type {
  ProjectEntity,
  ProjectRole,
  ProjectSummary,
  ProjectVisibility,
  SpaceType,
} from "@breatic/shared";

/**
 * Throw if the user does not have at least `minRole` on the project.
 *
 * Defaults to `'viewer'` — callers that need stronger checks pass
 * `'editor'` or `'owner'` explicitly. Routes with `requireRole`
 * middleware do not need this redundantly, but inner services
 * (conversation.service, BullMQ task path) call it as defense in
 * depth.
 * @param projectId - Project UUID from untrusted client input
 * @param userId - Authenticated user UUID
 * @param minRole - Minimum role required (defaults to `'viewer'`)
 * @throws {NotFoundError} if the project does not exist or the
 *   caller has no membership (we collapse 404 and 403-no-membership
 *   into 404 to avoid leaking project existence to outsiders)
 * @throws {ForbiddenError} if the caller's membership is below
 *   `minRole`
 */
export async function assertAccess(
  projectId: string,
  userId: string,
  minRole: ProjectRole = "viewer",
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
 *   1. `projects` row (in studio `studioId`)
 *   2. `project_members` row (`role='owner'`)
 *
 * The default Canvas Space is NOT seeded here any more: the Yjs
 * document store moved to a separate database that can't share this
 * business transaction. Instead collab lazy-seeds the `project-{id}/meta`
 * doc AND the first Space's content doc together on its first load,
 * using the `initial_space_type` stored here (deterministic Space id
 * derived from the project id, so concurrent first-loads converge). No
 * identity is seeded or backfilled anywhere in that path: names and avatars
 * are read from the project member roster at render time and never live in
 * Yjs (#1882). The "project exists ⇒ ≥1 Space" invariant the frontend
 * relies on is preserved by that read-time seed, not an eager write.
 * @param userId - Authenticated user UUID (becomes the project owner)
 * @param studioId - Studio the project is created in (the gate checks the
 *   caller's role on it — only an `admin` or `maintainer` may create)
 * @param name - Project name
 * @param slug - URL slug for `/project/{slug}-{uuid}` (format-validated
 *   app-side, NOT unique)
 * @param visibility - `'studio'` (open baseline) | `'private'` (explicit
 *   members only)
 * @param spaceType - Initial Space type seeded on first open (canvas
 *   today; document/timeline accepted but disabled in the create picker)
 * @param description - Optional description
 * @returns The newly created project entity
 * @throws {ForbiddenError} if the caller is not an `admin` or `maintainer`
 *   of `studioId`
 * @throws {NotFoundError} if no studio has that id
 * @throws {ConflictError} if the studio already holds as many projects as its
 *   tier allows
 */
export async function create(
  userId: string,
  studioId: string,
  name: string,
  slug: string,
  visibility: ProjectVisibility,
  spaceType: SpaceType,
  description?: string,
): Promise<ProjectEntity> {
  await requireStudioCreateAccess(userId, studioId);

  return db.transaction(async (tx) => {
    await assertStudioHasProjectRoom(studioId, tx);
    return projectRepo.createProject(
      tx,
      studioId,
      userId,
      name,
      slug,
      visibility,
      spaceType,
      description,
    );
  });
}

/**
 * Refuse if the studio already holds as many projects as its tier allows.
 *
 * The ceiling belongs to the STUDIO and is read from the tier of its current
 * admin — not from the tier of whoever is creating. A maintainer on the
 * narrowest tier creating inside a studio run by a wide-tier account gets the
 * wide ceiling, because the studio's capacity is paid for by whoever
 * administers it. A transfer moves the studio onto the new admin's ceiling
 * with no row here changing.
 *
 * Takes the studio's row first. Counting and then inserting is not a decision
 * when two requests do it at once — both count, both see room, both insert.
 * The row taken is the one the counted set belongs to, so two studios never
 * wait on each other while every path that adds to ONE studio queues up.
 *
 * Both entry points must call this. `duplicateProject` puts the copy in the
 * source's studio, so a gate on `create` alone leaves the ceiling false while
 * looking enforced.
 * @param studioId - The studio the new project would land in
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @throws {NotFoundError} if no studio row has that id. Neither caller can
 *   reach this today: `create` is already past `requireStudioCreateAccess`,
 *   whose role lookup inner-joins a live `studios` row, and `duplicate` starts
 *   from a live project, whose `studio_id` is a restrict FK. It is here because
 *   `lockStudio` can answer "no such row" and swallowing that would turn a
 *   corrupt state into a wrong ceiling
 * @throws {ConflictError} if the studio is already at its tier's ceiling
 */
async function assertStudioHasProjectRoom(
  studioId: string,
  tx: DbTx,
): Promise<void> {
  if (!(await studioRepo.lockStudio(studioId, tx))) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const { projects_per_studio: limit } = await getLimitsForStudio(studioId, tx);
  const used = await projectRepo.countLiveProjectsInStudio(studioId, tx);
  if (used >= limit) {
    throw new ConflictError(t("server.project.limit_reached", { limit }));
  }
}

/**
 * Authorize the caller to create a project in the target studio.
 *
 * Only a studio `admin` or `maintainer` may create; a `guest` (or a non-member,
 * role `null`) may not. That is the whole rule — a division of what each studio
 * role can do. An earlier version of this comment justified it with "a studio's
 * credits are shared, so a guest must not spend them", which was never the
 * reason and is not one now (user 2026-08-13).
 *
 * Today only personal studios exist (single admin), so only `admin` is
 * exercised against real data; the `maintainer` branch activates with team
 * studios.
 *
 * **Creating is the only one of the four project-lifecycle actions that asks a
 * STUDIO role.** Copying, deleting and transferring ownership all ask a
 * PROJECT role (`viewer`, `owner`, `owner`), which is why a studio guest with
 * `viewer` on one project can fork a new project into that studio today.
 * user 2026-08-13 settled the direction: all four belong on the studio role.
 * Tracked as its own task; not changed here, since it is a permission model
 * decision rather than part of the per-studio project ceiling.
 * @param userId - Authenticated user UUID
 * @param studioId - The studio the project would be created in
 * @throws {ForbiddenError} if the caller is not an admin/maintainer of the studio
 */
async function requireStudioCreateAccess(
  userId: string,
  studioId: string,
): Promise<void> {
  const role = await studioAuthService.loadStudioRole(userId, studioId);
  if (role !== "admin" && role !== "maintainer") {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
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
  await assertAccess(projectId, userId, "viewer");
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  return project;
}

/**
 * Load a project for a user OPENING its page, applying open-baseline access
 * (slice 2) and materializing a viewer row on first entry.
 *
 * This is the project-load path `GET /projects/:id` uses — deliberately
 * distinct from {@link get}, which other callers (role-upgrade approval) use to
 * fetch a project the caller ALREADY has a row on. Those must never materialize
 * a membership as a side effect, so the baseline grant lives here, not in `get`.
 *
 * Access ladder:
 *   1. The caller already has a `project_members` role → return it unchanged.
 *   2. No row, but the project is `visibility = 'studio'` AND the caller is a
 *      member of the project's studio → grant access, materialize a baseline
 *      `viewer` row (on this server path, BEFORE the client opens collab, so
 *      collab reads the persisted row), and return `myRole = 'viewer'`.
 *   3. Otherwise (private with no row, not a studio member, or the project is
 *      missing) → `NotFoundError`, collapsing all three so project existence
 *      is never leaked.
 * @param projectId - Project UUID being opened
 * @param userId - Authenticated user UUID
 * @returns The project entity plus the caller's effective role
 * @throws {NotFoundError} when the caller has no access, or the project is
 *   missing / soft-deleted
 */
export async function loadForViewer(
  projectId: string,
  userId: string,
): Promise<{ project: ProjectEntity; myRole: ProjectRole }> {
  const role = await projectAuthService.loadProjectRole(userId, projectId);
  if (role !== null) {
    const project = await projectRepo.getProjectById(projectId);
    if (!project) throw new NotFoundError(t("server.error.not_found"));
    return { project, myRole: role };
  }

  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));

  if (project.visibility === "studio") {
    const studioRole = await studioAuthService.loadStudioRole(userId, project.studioId);
    if (studioRole !== null) {
      await projectMembersRepo.materializeBaselineViewer(projectId, userId);
      return { project, myRole: "viewer" };
    }
  }

  throw new NotFoundError(t("server.error.not_found"));
}

/**
 * List the projects of a studio a viewer may see, for the studio container's
 * "projects" tab (slice 2 — replaces the old personal-Studio project list).
 *
 * Resolves the viewer's studio role and applies open-baseline visibility:
 *   - non-member → `[]` (the non-member shell shows no projects, IA #267);
 *   - member → studio-visible projects + the private ones they have a role on;
 *   - admin → every project in the studio (governance).
 *
 * The visibility predicate runs in the repo's single SQL query; this layer
 * only resolves the studio role and short-circuits non-members so the repo is
 * never queried for someone with no business listing the studio's projects.
 * @param studioId - Studio UUID whose projects to list
 * @param viewerUserId - Authenticated user UUID
 * @returns The visible project summaries (empty for non-members)
 */
export async function listByStudioForViewer(
  studioId: string,
  viewerUserId: string,
): Promise<ProjectSummary[]> {
  const studioRole = await studioAuthService.loadStudioRole(viewerUserId, studioId);
  if (studioRole === null) return [];
  return projectRepo.listProjectsByStudioForViewer(
    studioId,
    viewerUserId,
    studioRole === "admin",
  );
}

/**
 * List a studio's visible projects by the studio's URL slug.
 *
 * Resolves the slug to a studio (404 if none), then delegates to
 * {@link listByStudioForViewer}. Backs `GET /studio/:slug/projects`.
 * @param slug - The studio's URL handle
 * @param viewerUserId - Authenticated user UUID
 * @returns The visible project summaries (empty for non-members)
 * @throws {NotFoundError} when no active studio has that slug
 */
export async function listByStudioSlug(
  slug: string,
  viewerUserId: string,
): Promise<ProjectSummary[]> {
  const studio = await studioService.getStudioBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  return listByStudioForViewer(studio.id, viewerUserId);
}

/**
 * Update mutable project metadata.
 *
 * Requires at least `editor` on the project — name / description /
 * thumbnail are content edits, not just admin operations. The
 * `requireRole('editor')` middleware on the PUT route enforces the
 * same; this service-side check is defense in depth for non-route
 * callers.
 * @param projectId - Project UUID to update
 * @param userId - Authenticated user UUID; must have at least `editor` access
 * @param patch - Fields to update
 * @param patch.name - New project name
 * @param patch.description - New description; `null` clears it
 * @param patch.thumbnailUrl - New thumbnail URL; `null` clears it
 * @returns The updated project entity
 * @throws {NotFoundError} if the project doesn't exist or the
 *   caller has no membership
 * @throws {ForbiddenError} if the caller is below `editor`
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
  await assertAccess(projectId, userId, "editor");
  const updated = await projectRepo.updateProjectMeta(projectId, patch);
  if (!updated) throw new NotFoundError(t("server.error.not_found"));
  return updated;
}

/**
 * Duplicate a project — the duplicate is owned by the caller.
 *
 * The caller becomes the owner of the new project (same studio as
 * the source). Source must be visible to the caller (any active
 * membership counts; you can fork something you can read) — which is a
 * PROJECT role, while creating a project asks a STUDIO role. That mismatch is
 * a known open question, not a settled design; see `requireStudioCreateAccess`.
 *
 * Reads the source WITHOUT locking it, then waits for the studio row. If the
 * source is deleted during that wait, the copy is still made from what was
 * read — snapshot semantics, and deliberately so. The four other places that
 * add something to a project (`projectInvite`, `roleUpgradeRequest`,
 * `conversation`, `projectTransfer`) do take `lockLiveProject` first, but for a
 * reason that does not apply here: what they insert HANGS OFF the project, so
 * without the lock a live row commits against a dead project — undecidable and
 * unreapable. A duplicate is a free-standing new project; deleting the source
 * leaves it perfectly consistent. No invariant is broken, so no lock is taken.
 * @param sourceId - UUID of the project to duplicate
 * @param userId - Authenticated user UUID (becomes new project owner)
 * @returns The newly created duplicate project entity
 * @throws {NotFoundError} if the source project does not exist
 *   or the caller has no membership
 * @throws {ConflictError} if the source's studio already holds as many
 *   projects as its tier allows
 */
export async function duplicate(
  sourceId: string,
  userId: string,
): Promise<ProjectEntity> {
  await assertAccess(sourceId, userId, "viewer");

  return db.transaction(async (tx) => {
    // Read first, because the studio to lock is the SOURCE's — a copy lands
    // beside the thing it was copied from and counts against that studio.
    const source = await projectRepo.getProjectById(sourceId, tx);
    if (!source) throw new NotFoundError(t("server.error.not_found"));
    await assertStudioHasProjectRoom(source.studioId, tx);
    return projectRepo.duplicateProject(tx, userId, source);
  });
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
