/**
 * Project members repository — `project_members` table CRUD.
 *
 * Permission state lives entirely in PG (v10 §7.2). Yjs is consulted
 * only as a notification channel (PR-C); this repo is the single
 * source of truth for who has what role on what project.
 *
 * Owner uniqueness is enforced by a partial unique index in PG
 * (`project_members_one_owner_per_project`); writers do not need to
 * check it client-side. Soft delete is the only deletion mode (the
 * partial unique index treats `deleted_at IS NOT NULL` rows as gone).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { projectMembers } from "@breatic/core";
import type { ProjectMember, ProjectRole } from "@breatic/shared";
import type { DbTx } from "@server/modules/conversation.repo.js";

function toEntity(
  row: typeof projectMembers.$inferSelect,
): ProjectMember {
  return {
    projectId: row.projectId,
    userId: row.userId,
    role: row.role as ProjectRole,
    addedBy: row.addedBy,
    addedAt: row.addedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Get the active role for a user on a project, or `null` if the user
 * is not a member.
 *
 * Used by `loadProjectRole` (server middleware + collab onAuth).
 *
 * @param projectId - Project UUID
 * @param userId - User UUID
 * @returns Role, or null if no active membership
 */
export async function getRole(
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const rows = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? (rows[0].role as ProjectRole) : null;
}

/**
 * Get the user id of the active owner of a project.
 *
 * Owner uniqueness is enforced by the partial unique index
 * `project_members_one_owner_per_project`; at most one row matches.
 *
 * @param projectId - Project UUID
 * @returns Owner's user UUID, or null if the project has no active
 *   owner (should not happen — every project has an owner row in
 *   the same tx as project creation)
 */
export async function getOwner(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, "owner"),
        isNull(projectMembers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * List active members of a project.
 *
 * Caller-side ordering: owner first, then edits, then views (the
 * frontend joins this with `useUsers` for display info).
 *
 * @param projectId - Project UUID
 * @returns Members ordered by role rank desc, then addedAt asc
 */
export async function listByProjectId(
  projectId: string,
): Promise<ProjectMember[]> {
  const rows = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        isNull(projectMembers.deletedAt),
      ),
    );
  return rows.map(toEntity);
}

/**
 * Insert the owner row for a freshly created project.
 *
 * `addedBy` is null because the creator has no inviter. Must run in
 * the same transaction as the project insert; the caller passes the
 * `tx` handle.
 *
 * @param projectId - Project UUID
 * @param ownerUserId - The creator's user UUID
 * @param tx - Drizzle transaction handle
 */
export async function insertOwner(
  projectId: string,
  ownerUserId: string,
  tx: DbTx,
): Promise<void> {
  await tx.insert(projectMembers).values({
    projectId,
    userId: ownerUserId,
    role: "owner",
    addedBy: null,
  });
}

/**
 * Upsert a non-owner member (invite or revive previously-removed).
 *
 * If a row exists with `(projectId, userId)`:
 *   - `deletedAt IS NULL`: row is updated to the new role.
 *   - `deletedAt IS NOT NULL` (was removed): the row is "revived"
 *     — `deleted_at` cleared, `role` and `addedBy` set fresh.
 *
 * The route layer enforces `role !== 'owner'` (owner promotion goes
 * through transfer-owner, which is V1-deferred).
 *
 * @param projectId - Project UUID
 * @param userId - User UUID being invited
 * @param role - 'edit' | 'view'
 * @param addedBy - Inviter's user UUID
 * @param tx - Optional drizzle transaction handle (caller passes when
 *   the upsert must be atomic with other mutations in the same tx)
 */
export async function upsertMember(
  projectId: string,
  userId: string,
  role: Exclude<ProjectRole, "owner">,
  addedBy: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle
    .insert(projectMembers)
    .values({
      projectId,
      userId,
      role,
      addedBy,
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: {
        role,
        addedBy,
        addedAt: sql`now()`,
        deletedAt: null,
      },
    });
}

/**
 * Update the role of an existing active member.
 *
 * Caller MUST verify the target is not already an owner (V1: owner
 * role cannot be PATCH'd; transfer-owner deferred). Returns `false`
 * if no active row matched.
 *
 * @param projectId - Project UUID
 * @param userId - Target user UUID
 * @param role - New role ('edit' | 'view')
 * @returns `true` if a row was updated
 */
export async function updateRole(
  projectId: string,
  userId: string,
  role: Exclude<ProjectRole, "owner">,
): Promise<boolean> {
  const rows = await db
    .update(projectMembers)
    .set({ role })
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .returning({ projectId: projectMembers.projectId });
  return rows.length > 0;
}

/**
 * Soft-delete a member row.
 *
 * Caller MUST refuse to remove an owner (V1: owners are removed
 * only via transfer-owner, which is deferred). Returns `false` if
 * no active row matched.
 *
 * @param projectId - Project UUID
 * @param userId - Target user UUID
 * @returns `true` if a row was soft-deleted
 */
export async function softDelete(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(projectMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .returning({ projectId: projectMembers.projectId });
  return rows.length > 0;
}
