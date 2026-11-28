// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { projects, studios } from "@core/db/schema.js";

/**
 * Read a Project's owning Studio only while both entities remain live.
 * @param projectId - The Project whose registered media is being accessed.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns The owning Studio id, or undefined when either entity is deleted.
 * @throws {Error} When the database query fails.
 */
export async function findLiveOwnerStudioId(projectId: string, tx?: DbTx): Promise<string | undefined> {
  const [row] = await (tx ?? db).select({ studioId: projects.studioId })
    .from(projects)
    .innerJoin(studios, eq(studios.id, projects.studioId))
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt), isNull(studios.deletedAt)))
    .limit(1);
  return row?.studioId;
}

/**
 * The live Projects of a Studio (#1580): the ones whose pages show the Studio's credits, told when they change. Live
 * is what server's `countLiveProjectsInStudio` counts: neither archived nor deleted.
 * @param studioId - The Studio.
 * @returns The Projects' ids, in no particular order.
 * @throws {Error} When the database query fails.
 */
export async function listLiveProjectIdsInStudio(studioId: string): Promise<string[]> {
  const rows = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.studioId, studioId), isNull(projects.deletedAt), isNull(projects.archivedAt)));
  return rows.map((row) => row.id);
}

/**
 * Reads the studio a project belongs to.
 *
 * Lives here rather than in whichever service happens to need it, because
 * two packages do: the asset layer attributes every asset to the owning
 * studio, and the server reads the same column for authorisation. A query
 * written twice is a query that comes apart, which is the drift the
 * one-table-one-repo rule exists to prevent — and this one was in a service
 * where the line-reading guard could not see it, because the call spans two
 * lines and the guard matched `db.select` on one.
 *
 * Soft-deleted projects read as absent, matching every other list and lookup
 * in the repository.
 * @param projectId - Project to look up.
 * @param tx - An enclosing transaction, when the caller holds one.
 * @returns The owning studio's id, or undefined when no live project has
 *   that id.
 */
export async function findOwnerStudioId(
  projectId: string,
  tx?: DbTx,
): Promise<string | undefined> {
  const rows = await (tx ?? db)
    .select({ studioId: projects.studioId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return rows[0]?.studioId;
}

/**
 * Whether collab has already copied a duplicated Project's documents (inner#1706), so a lifecycle command delivered
 * again copies nothing and cannot overwrite what the user has since done in the copy.
 * @param projectId - The copy.
 * @returns True once its completion is recorded; false while it is being copied or when no such row exists.
 * @throws {Error} When the database query fails.
 */
export async function isDuplicateCompleted(projectId: string): Promise<boolean> {
  const [row] = await db.select({ at: projects.duplicateCompletedAt }).from(projects)
    .where(eq(projects.id, projectId)).limit(1);
  return row?.at !== null && row?.at !== undefined;
}

/**
 * Record that collab has copied a duplicated Project's documents, which is when it opens. Only the first record
 * counts.
 * @param projectId - The copy.
 * @returns Nothing.
 * @throws {Error} When the database write fails.
 */
export async function markDuplicateCompleted(projectId: string): Promise<void> {
  await db.update(projects).set({ duplicateCompletedAt: sql`now()` })
    .where(and(eq(projects.id, projectId), isNull(projects.duplicateCompletedAt)));
}
