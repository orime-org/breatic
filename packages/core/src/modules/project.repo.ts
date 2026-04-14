/**
 * Project repository — data access with soft delete support.
 */

import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects } from "../db/schema.js";
import type { ProjectEntity } from "@breatic/shared";

function toEntity(row: typeof projects.$inferSelect): ProjectEntity {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description,
    canvasData: (row.canvasData ?? {}) as Record<string, unknown>,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Get a project by ID (excludes soft-deleted). */
export async function getProjectById(id: string): Promise<ProjectEntity | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** List projects for a user (excludes soft-deleted). */
export async function listProjectsByUser(
  userId: string,
  limit = 20,
  offset = 0,
): Promise<ProjectEntity[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
    .orderBy(desc(projects.updatedAt))
    .limit(Math.min(limit, 100))
    .offset(offset);
  return rows.map(toEntity);
}

/** Create a new project. */
export async function createProject(
  userId: string,
  name: string,
  description?: string,
): Promise<ProjectEntity> {
  const rows = await db
    .insert(projects)
    .values({ userId, name, description })
    .returning();
  return toEntity(rows[0]!);
}

/** Update canvas data snapshot. */
export async function updateCanvas(
  id: string,
  canvasData: Record<string, unknown>,
): Promise<void> {
  await db
    .update(projects)
    .set({ canvasData, updatedAt: new Date() })
    .where(eq(projects.id, id));
}

/**
 * Update mutable project metadata (name / description / thumbnail).
 *
 * Only fields with a defined value are updated — `undefined` is
 * skipped so callers can PATCH a single field. `null` is a legal
 * value for `description` and `thumbnailUrl` and will clear them.
 *
 * @param id - Project UUID
 * @param patch - Fields to update
 * @returns The updated project, or `null` if no row matched
 */
export async function updateProjectMeta(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    thumbnailUrl?: string | null;
  },
): Promise<ProjectEntity | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.thumbnailUrl !== undefined) set.thumbnailUrl = patch.thumbnailUrl;

  const rows = await db
    .update(projects)
    .set(set)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .returning();
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Duplicate a project and all of its Yjs documents inside a single
 * transaction.
 *
 * Copies:
 *   - The `projects` row (new UUID, same name with " (copy)" suffix,
 *     same description / thumbnail / `canvas_data` JSONB snapshot)
 *   - Every `yjs_documents` row whose name begins with
 *     `project-<sourceId>/` — rewriting the prefix to the new UUID so
 *     `canvas` and every per-node editor document carry over
 *
 * Does NOT copy:
 *   - Conversations, messages, tasks, or node_history (those belong
 *     to the user's past work and a duplicate should start with a
 *     fresh timeline)
 *   - Project / user memory rows (same reasoning — memory is derived
 *     from past conversations the duplicate doesn't have)
 *
 * Asset URLs inside the Yjs blobs continue to point at the original
 * OSS / S3 objects. This is intentional: we don't re-upload anything
 * on duplicate, so the copy is cheap and fast. If a later feature
 * needs truly independent storage for forks, that's a separate
 * cascade.
 *
 * @param userId - Owner of the new project (must match caller at
 *   the service layer — this repo function does NOT itself check
 *   ownership of the source; that happens in project.service.ts)
 * @param sourceId - UUID of the project to duplicate
 * @returns The freshly created project entity, or `null` if the
 *   source project does not exist or is soft-deleted
 */
export async function duplicateProject(
  userId: string,
  sourceId: string,
): Promise<ProjectEntity | null> {
  return db.transaction(async (tx) => {
    // Load the source inside the transaction so we can't race a
    // concurrent delete between fetch and copy.
    const sourceRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, sourceId), isNull(projects.deletedAt)))
      .limit(1);
    const source = sourceRows[0];
    if (!source) return null;

    // Insert the new project row. The DB generates a new UUID; we
    // read it back via .returning() to drive the Yjs copy below.
    const [inserted] = await tx
      .insert(projects)
      .values({
        userId,
        name: `${source.name} (copy)`,
        description: source.description,
        canvasData: (source.canvasData ?? {}) as Record<string, unknown>,
        thumbnailUrl: source.thumbnailUrl,
      })
      .returning();
    if (!inserted) return null;

    // Copy every Yjs document whose name starts with
    // `project-<sourceId>/` — this covers `canvas` and every
    // `node/<nodeId>` per-node editor doc. `substring(name from N+1)`
    // strips the old prefix, then we concatenate the new one.
    //
    // `yjs_documents` is not part of the Drizzle schema (it's
    // managed by the collab package's ensureTable) so we drop to
    // raw SQL via `sql` template tag.
    const oldPrefix = `project-${sourceId}/`;
    const newPrefix = `project-${inserted.id}/`;
    await tx.execute(sql`
      INSERT INTO yjs_documents (name, data, updated_at)
      SELECT ${newPrefix} || substring(name from ${oldPrefix.length + 1}),
             data,
             NOW()
      FROM yjs_documents
      WHERE name LIKE ${oldPrefix + "%"}
    `);

    return toEntity(inserted);
  });
}

/** Soft-delete a project by setting its `deleted_at` timestamp. */
export async function deleteProject(id: string): Promise<void> {
  await db
    .update(projects)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(projects.id, id));
}
