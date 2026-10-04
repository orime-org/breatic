// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { pictureUrl } from "@server/modules/asset/picture.service.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { projectAuthService } from "@breatic/core";
import * as studioService from "@server/modules/studio/studio.service.js";
import { studioAuthService } from "@breatic/domain";
import { db, getLimitsForStudio } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError, ConflictError } from "@breatic/core";
import { ROLE_RANK } from "@breatic/shared";
import { copyName } from "@server/modules/project/copy-name.js";
import { mayArchive, mayManage, projectPermissions } from "@server/modules/project/projectGovernance.js";
import type {
  ProjectEntity,
  ProjectRole,
  ProjectSummary,
  SpaceType,
  StudioRole,
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
 * @param spaceType - Initial Space type seeded on first open (canvas
 *   today; document/timeline accepted but disabled in the create picker)
 * @param description - Optional description
 * @returns The newly created project entity
 * @throws {ForbiddenError} if the caller is not an `admin` or `maintainer`
 *   of `studioId` — which is also what a missing or soft-deleted studio
 *   produces, since the role lookup inner-joins a live `studios` row
 * @throws {ConflictError} if the studio already holds as many projects as its
 *   tier allows
 */
export async function create(
  userId: string,
  studioId: string,
  name: string,
  slug: string,
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
 * Create and duplicate must both call this. `duplicateProject` puts the copy
 * in the source's studio, so a gate on `create` alone leaves the ceiling false
 * while looking enforced. Restore takes the same lock and ceiling through
 * {@link studioProjectRoom}, asking for room only once it knows the project is
 * archived.
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
  const room = await studioProjectRoom(studioId, tx);
  if (room === null) throw new NotFoundError(t("server.error.not_found"));
  if (!(await room.hasRoom())) {
    throw new ConflictError(t("server.project.limit_reached", { limit: room.limit }));
  }
}

/** A locked studio's project ceiling, and whether it still has room under it. */
interface ProjectRoom {
  limit: number;
  hasRoom: () => Promise<boolean>;
}

/**
 * Lock the studio's row and read its project ceiling — the one place every
 * path that adds a live project (create, duplicate, restore) takes both.
 * `hasRoom` counts when called, so a caller can ask it after its own checks.
 * @param studioId - The studio
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns The ceiling and the room check, or null when no studio row has that id
 */
async function studioProjectRoom(studioId: string, tx: DbTx): Promise<ProjectRoom | null> {
  if (!(await studioRepo.lockStudio(studioId, tx))) return null;
  const { projects_per_studio: limit } = await getLimitsForStudio(studioId, tx);
  return {
    limit,
    hasRoom: async () => (await projectRepo.countLiveProjectsInStudio(studioId, tx)) < limit,
  };
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
 * Load a project for a user OPENING its page.
 *
 * Access ladder:
 *   1. The caller has a `project_members` role → return it.
 *   2. No row, but the caller is a member of the project's studio →
 *      `ForbiddenError`. The project is listed to them in the studio, so its
 *      existence is no secret; the client answers the 403 by offering to ask
 *      the owner to let them in (`project-join-request`).
 *   3. Otherwise (not a studio member, or the project is missing) →
 *      `NotFoundError`, so existence is never leaked outside the studio.
 * @param projectId - Project UUID being opened
 * @param userId - Authenticated user UUID
 * @returns The project entity, the caller's stored role, and whether they may rename and restore it
 * @throws {ForbiddenError} when the caller is in the studio but not on the project
 * @throws {NotFoundError} when the caller is outside the studio, or the project
 *   is missing / soft-deleted
 */
export async function loadForViewer(
  projectId: string,
  userId: string,
): Promise<{ project: ProjectEntity; myRole: ProjectRole; canManageMeta: boolean; canRestore: boolean }> {
  // The real role, not the write-capped one: an archived project still shows
  // its owner as owner; `project.archivedAt` tells the page it is read-only.
  const access = await projectAuthService.loadProjectAccess(userId, projectId);
  if (access !== null) {
    const project = await projectRepo.getProjectById(projectId);
    if (!project) throw new NotFoundError(t("server.error.not_found"));
    const studioRole = await studioAuthService.loadStudioRole(userId, project.studioId);
    const { canManageMeta, canRestore } = projectPermissions({
      studioRole,
      projectRole: access.role,
      archived: access.archived,
    });
    return { project, myRole: access.role, canManageMeta, canRestore };
  }

  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));

  const studioRole = await studioAuthService.loadStudioRole(userId, project.studioId);
  if (studioRole !== null) throw new ForbiddenError(t("server.error.forbidden"));
  throw new NotFoundError(t("server.error.not_found"));
}

/**
 * List the projects of a studio a viewer may see, for the studio container's
 * "projects" and "archived" tabs, each with the permissions its card menu shows.
 *
 * A non-member of the studio gets `[]` (the non-member shell shows no
 * projects, IA #267); every studio member gets every live project, tagged with
 * their own role on it. The archived list is the studio admin's alone.
 * @param studioId - Studio UUID whose projects to list
 * @param viewerUserId - Authenticated user UUID
 * @param options - Which list
 * @param options.archived - The archived list instead of the live one
 * @returns The visible project summaries (empty for non-members)
 * @throws {ForbiddenError} when anyone but the studio's admin asks for the archived list
 */
export async function listByStudioForViewer(
  studioId: string,
  viewerUserId: string,
  options: { archived: boolean },
): Promise<ProjectSummary[]> {
  const studioRole = await studioAuthService.loadStudioRole(viewerUserId, studioId);
  if (options.archived && !mayArchive({ studioRole, projectRole: null })) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (studioRole === null) return [];
  const rows = await projectRepo.listProjectsByStudioForViewer(
    studioId,
    viewerUserId,
    options.archived,
  );
  return rows.map((row) => ({
    ...row,
    ...projectPermissions({
      studioRole,
      projectRole: row.myRole,
      archived: row.archivedAt !== null,
    }),
  }));
}

/**
 * List a studio's visible projects by the studio's URL slug.
 *
 * Resolves the slug to a studio (404 if none), then delegates to
 * {@link listByStudioForViewer}. Backs `GET /studio/:slug/projects`.
 * @param slug - The studio's URL handle
 * @param viewerUserId - Authenticated user UUID
 * @param options - Which list
 * @param options.archived - The archived list instead of the live one
 * @returns The visible project summaries (empty for non-members)
 * @throws {NotFoundError} when no active studio has that slug
 * @throws {ForbiddenError} when anyone but the studio's admin asks for the archived list
 */
export async function listByStudioSlug(
  slug: string,
  viewerUserId: string,
  options: { archived: boolean },
): Promise<ProjectSummary[]> {
  const studio = await studioService.getStudioBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  return listByStudioForViewer(studio.id, viewerUserId, options);
}

/**
 * Update mutable project metadata.
 *
 * Gated by {@link assertMayManage}: the studio's admin or the project's
 * owner, on a live project.
 * @param projectId - Project UUID to update
 * @param userId - Authenticated user UUID
 * @param patch - Fields to update
 * @param patch.name - New project name
 * @param patch.description - New description; `null` clears it
 * @returns The updated project entity
 * @throws {NotFoundError} if the project doesn't exist or the caller is not
 *   in its studio
 * @throws {ForbiddenError} if the caller is neither the studio's admin nor the project's owner
 * @throws {ConflictError} if the project is archived
 */
export async function update(
  projectId: string,
  userId: string,
  patch: {
    name?: string;
    description?: string | null;
  },
): Promise<ProjectEntity> {
  await assertMayManage(projectId, userId);
  return writeMeta(projectId, patch);
}

/** A project, live or archived, and the caller's two roles on it. */
interface ManagementFacts {
  project: ProjectEntity;
  studioRole: StudioRole;
  projectRole: ProjectRole | null;
}

/**
 * Read, once, what `projectPermissions` decides on: the caller's role in the
 * project's studio and their stored role on the project. The stored role is
 * the real one, not the archive-capped one; the rule reads the archive state
 * itself. Plain reads, taken before any row lock.
 * @param projectId - Project UUID
 * @param userId - Authenticated user UUID
 * @returns The project and the caller's two roles
 * @throws {NotFoundError} when the project is missing / deleted, or the caller
 *   is not in its studio (existence is hidden from outsiders)
 */
async function managementFacts(projectId: string, userId: string): Promise<ManagementFacts> {
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  const [studioRole, access] = await Promise.all([
    studioAuthService.loadStudioRole(userId, project.studioId),
    projectAuthService.loadProjectAccess(userId, projectId),
  ]);
  if (studioRole === null) throw new NotFoundError(t("server.error.not_found"));
  return { project, studioRole, projectRole: access?.role ?? null };
}

/**
 * Require the caller may manage the project as an object: rename it, change
 * its cover (the cover upload ticket checks this before it signs anything)
 * and duplicate it.
 *
 * Asked as of a live project, so someone who may manage it hears that it is
 * archived (409) and someone who may not hears that they may not (403).
 * @param projectId - Project UUID
 * @param userId - Authenticated user UUID
 * @returns The project
 * @throws {NotFoundError} when the project is missing / deleted, or the caller
 *   is not in its studio
 * @throws {ForbiddenError} when the caller is in the studio but may not manage it
 * @throws {ConflictError} when the project is archived
 */
export async function assertMayManage(projectId: string, userId: string): Promise<ProjectEntity> {
  const { project, ...roles } = await managementFacts(projectId, userId);
  if (!mayManage(roles)) throw new ForbiddenError(t("server.error.forbidden"));
  if (project.archivedAt !== null) throw new ConflictError(t("server.project.archived"));
  return project;
}

/**
 * Write name / description / cover, unless the project was archived in the
 * meantime — the write itself carries the `archived_at IS NULL` condition, so
 * it serialises with the archive on the project row.
 * @param projectId - Project UUID
 * @param patch - Fields to write
 * @returns The updated project
 * @throws {ConflictError} when the project is no longer live to write to
 */
async function writeMeta(
  projectId: string,
  patch: Parameters<typeof projectRepo.updateProjectMeta>[1],
): Promise<ProjectEntity> {
  const updated = await projectRepo.updateProjectMeta(projectId, patch);
  if (!updated) throw new ConflictError(t("server.project.archived"));
  return updated;
}

/**
 * Point the project's cover at an uploaded picture.
 *
 * The URL is read off the ledger row, so the cover can only name an image the
 * project's own studio stores. The picture it replaces stays in the ledger.
 * Gated like a rename (see {@link assertMayManage}); this is the only
 * place `thumbnail_url` is written besides duplicating a project.
 * @param projectId - Project UUID
 * @param userId - Authenticated user UUID
 * @param assetId - The uploaded picture's ledger row
 * @returns The updated project entity
 * @throws {NotFoundError} if the project is gone or hidden from the caller, or
 *   its studio holds no live image row with that id
 * @throws {ForbiddenError} when the caller may not manage the project
 * @throws {ConflictError} when the project is archived
 */
export async function setCover(
  projectId: string,
  userId: string,
  assetId: string,
): Promise<ProjectEntity> {
  const project = await assertMayManage(projectId, userId);
  const url = await pictureUrl(project.studioId, assetId);
  return writeMeta(projectId, { thumbnailUrl: url });
}

/**
 * Duplicate a project — the duplicate is owned by the caller.
 *
 * The caller becomes the only member of the new project, as its owner (same
 * studio as the source); the source's members are not copied. The caller must
 * be the studio's admin or the source's owner, and an archived source is
 * refused at the check.
 *
 * Reads the source WITHOUT locking it, then waits for the studio row. If the
 * source is archived during that wait, the copy is still made from what was
 * read — snapshot semantics. The other places that add something to a
 * project (`projectInvite`, `projectJoinRequest`, `roleUpgradeRequest`,
 * `conversation`, `projectTransfer`) do take `lockLiveProject` first, because what they insert
 * hangs off the project. A duplicate is a free-standing new project, so no
 * lock is taken.
 * @param sourceId - UUID of the project to duplicate
 * @param userId - Authenticated user UUID (becomes new project owner)
 * @returns The newly created duplicate project entity
 * @throws {NotFoundError} if the source project does not exist, or the caller
 *   is not in its studio
 * @throws {ForbiddenError} if the caller is neither the studio's admin nor the
 *   source's owner
 * @throws {ConflictError} if the source is archived, or its studio already
 *   holds as many projects as its tier allows
 */
export async function duplicate(
  sourceId: string,
  userId: string,
): Promise<ProjectEntity> {
  await assertMayManage(sourceId, userId);

  return db.transaction(async (tx) => {
    // Read first, because the studio to lock is the SOURCE's — a copy lands
    // beside the thing it was copied from and counts against that studio.
    const source = await projectRepo.getProjectById(sourceId, tx);
    if (!source) throw new NotFoundError(t("server.error.not_found"));
    await assertStudioHasProjectRoom(source.studioId, tx);
    return projectRepo.duplicateProject(tx, userId, source, copyName(source.name));
  });
}

/**
 * Refuse a write to something that belongs to an archived project.
 *
 * For the writes gated on who owns a row (a conversation, an attachment)
 * rather than on the caller's project role — those never pass through
 * `loadProjectRole`, so its archive cap does not reach them.
 * @param projectId - The project the written row belongs to, or null when it belongs to none
 * @throws {ConflictError} when that project is archived
 */
export async function assertNotArchived(projectId: string | null): Promise<void> {
  if (projectId === null) return;
  const project = await projectRepo.getProjectById(projectId);
  if (project?.archivedAt != null) throw new ConflictError(t("server.project.archived"));
}

/**
 * Archive a project. Studio admin only; the project's own owner does not get
 * to. It becomes read-only for every member until restored.
 * @param projectId - Project UUID
 * @param userId - Authenticated user UUID; must be the studio's admin
 * @throws {NotFoundError} when the project is missing / deleted or hidden from the caller
 * @throws {ForbiddenError} when the caller is not the studio's admin
 * @throws {ConflictError} when the project is already archived
 */
export async function archive(projectId: string, userId: string): Promise<void> {
  if (!mayArchive(await managementFacts(projectId, userId))) throw new ForbiddenError(t("server.error.forbidden"));
  const outcome = await db.transaction((tx) => projectRepo.archiveProject(projectId, userId, tx));
  if (outcome === "missing") throw new NotFoundError(t("server.error.not_found"));
  if (outcome === "unchanged") throw new ConflictError(t("server.project.already_archived"));
}

/**
 * Restore an archived project. Studio admin only, and only while the studio
 * has room for one more live project — an archived project does not take a
 * slot, so restoring one takes it back.
 * @param projectId - Project UUID
 * @param userId - Authenticated user UUID; must be the studio's admin
 * @throws {NotFoundError} when the project is missing / deleted or hidden from the caller
 * @throws {ForbiddenError} when the caller is not the studio's admin
 * @throws {ConflictError} when the project is not archived, or the studio is
 *   at its project limit
 */
export async function restore(projectId: string, userId: string): Promise<void> {
  const { project, ...roles } = await managementFacts(projectId, userId);
  if (!mayArchive(roles)) throw new ForbiddenError(t("server.error.forbidden"));
  const result = await db.transaction(async (tx) => {
    const room = await studioProjectRoom(project.studioId, tx);
    if (room === null) return { outcome: "missing" as const, limit: 0 };
    return { outcome: await projectRepo.restoreProject(projectId, tx, room.hasRoom), limit: room.limit };
  });
  const { outcome, limit } = result;
  if (outcome === "missing") throw new NotFoundError(t("server.error.not_found"));
  if (outcome === "unchanged") throw new ConflictError(t("server.project.not_archived"));
  if (outcome === "full") throw new ConflictError(t("server.project.restore_limit_reached", { limit }));
}
