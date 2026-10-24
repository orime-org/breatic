// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { and, eq, isNull } from "drizzle-orm";
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
 * @returns The owning studio's id, or undefined when no live project has
 *   that id.
 */
export async function findOwnerStudioId(
  projectId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ studioId: projects.studioId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return rows[0]?.studioId;
}

/**
 * Reads who created a project and the studio it belongs to, for the
 * collaboration milestone (inner#1442 design §4.8).
 * @param projectId - Project to look up.
 * @returns Both, or undefined when no live project has that id.
 */
export async function findCreatorAndStudio(
  projectId: string,
): Promise<{ createdByUserId: string; studioId: string } | undefined> {
  const rows = await db
    .select({ createdByUserId: projects.createdByUserId, studioId: projects.studioId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return rows[0];
}
