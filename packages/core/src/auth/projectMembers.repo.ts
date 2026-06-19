// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import { and, eq, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import type { DbTx } from "@core/db/client.js";
import { projectMembers, projects } from "@core/db/schema.js";
import type { ProjectMember, ProjectRole } from "@breatic/shared";

/**
 * Map a raw `project_members` drizzle row to the shared domain entity.
 * @param row - selected `project_members` row from drizzle
 * @returns the `ProjectMember` domain entity
 */
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
 * Get the active role for a user on an **active** project, or `null`.
 *
 * The single source of truth for "what may this user do on this
 * project", shared by `loadProjectRole` (server `requireRole`
 * middleware + collab `onAuthenticate`). Both null branches —
 * project missing/soft-deleted, and user-not-a-member — collapse to
 * `null` so a caller surfaces one generic 403 and never leaks
 * project existence to a non-member.
 *
 * The `projects` inner-join with `projects.deleted_at IS NULL` folds
 * the project-existence guard into the same query. Project soft-delete
 * already cascades to its `project_members` rows in one transaction
 * (`project.repo.deleteProject`), so the member-row `deleted_at`
 * filter alone would suffice — the project join is defence-in-depth
 * that keeps a deleted project unreachable even if a member row ever
 * lingered, and it lets this one query replace a separate existence
 * SELECT (no raw `db` access outside this repo).
 * @param projectId - Project UUID
 * @param userId - User UUID
 * @returns Role, or null if the project is missing/deleted or the
 *   user has no active membership
 */
export async function getRole(
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const rows = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
        isNull(projects.deletedAt),
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
 * Count a project's EXPLICITLY invited members (`added_by IS NOT NULL`):
 * editors / viewers added via an invite. The creator-owner row and the
 * auto-materialized baseline viewers (open baseline) BOTH have
 * `added_by = null` and are intentionally EXCLUDED — the project
 * collaborator cap bounds the explicit invite roster only, and must never
 * block open-baseline viewing access.
 * @param projectId - Project UUID
 * @returns Count of active explicitly-invited members.
 */
export async function countExplicitMembers(projectId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        isNull(projectMembers.deletedAt),
        isNotNull(projectMembers.addedBy),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * Insert the owner row for a freshly created project.
 *
 * `addedBy` is null because the creator has no inviter. Must run in
 * the same transaction as the project insert; the caller passes the
 * `tx` handle.
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
 * @param projectId - Project UUID
 * @param userId - User UUID being invited
 * @param role - 'editor' | 'viewer'
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
 * Materialize an open-baseline viewer row on first project entry (slice 2).
 *
 * Called by `project.service.loadForViewer` the moment a studio member opens
 * a studio-visible project they have no `project_members` row for yet. The
 * write happens on the server's project-load path, BEFORE the client opens
 * its collab WebSocket, so collab's `loadProjectRole` always reads an already
 * persisted row — collab itself never materializes and never recomputes the
 * studio role.
 *
 * Conflict semantics (`ON CONFLICT (project_id, user_id) DO UPDATE ... WHERE
 * deleted_at IS NOT NULL`) cover three states of the existing row:
 *   - no row        → INSERT an active `viewer` row.
 *   - soft-deleted  → REVIVE it to an active `viewer` (a previously-removed
 *     member who again qualifies for baseline access must regain an ACTIVE
 *     row; a bare `DO NOTHING` would leave the row soft-deleted, so the
 *     server would grant access while collab's `loadProjectRole` still read
 *     `null` and refused the WebSocket — a split-brain "server grants /
 *     collab rejects" state).
 *   - active        → NO-OP (the `setWhere` predicate fails). This is the
 *     concurrency tie-break (two racing first-entries → one INSERT wins, the
 *     loser conflicts on the composite PK and no-ops) AND the guarantee that
 *     an existing `editor` / `owner` is NEVER downgraded to `viewer`.
 *
 * Because `loadForViewer` only calls this when `loadProjectRole` already
 * returned `null` (no active row), the active-row branch is only reachable
 * via a race (a concurrent invite or a sibling tab) — and in every such race
 * the existing active row wins.
 * @param projectId - Project UUID being entered
 * @param userId - The entering user's UUID (becomes a baseline viewer)
 * @param tx - Optional drizzle transaction handle
 */
export async function materializeBaselineViewer(
  projectId: string,
  userId: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle
    .insert(projectMembers)
    .values({
      projectId,
      userId,
      role: "viewer",
      addedBy: null,
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: {
        role: "viewer",
        addedBy: null,
        addedAt: sql`now()`,
        deletedAt: null,
      },
      setWhere: sql`${projectMembers.deletedAt} IS NOT NULL`,
    });
}

/**
 * Update the role of an existing active member.
 *
 * Caller MUST verify the target is not already an owner (V1: owner
 * role cannot be PATCH'd; transfer-owner deferred). Returns `false`
 * if no active row matched.
 * @param projectId - Project UUID
 * @param userId - Target user UUID
 * @param role - New role ('editor' | 'viewer')
 * @param tx - Optional drizzle transaction handle so the role bump can join
 *   the caller's atomic decision (e.g. role-upgrade approve)
 * @returns `true` if a row was updated
 */
export async function updateRole(
  projectId: string,
  userId: string,
  role: Exclude<ProjectRole, "owner">,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
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

/**
 * Soft-delete every active membership a user holds in one studio's projects —
 * the access-revocation half of a studio kick (slice 3).
 *
 * Scoped by a subquery on `projects.studio_id` so only rows in THAT studio's
 * active projects are cleared; the user's memberships in other studios are
 * untouched. Soft-delete only (rows physically remain). Runs in the kick's
 * transaction (the caller passes `tx`) so it is atomic with the
 * `studio_members` soft-delete and the owner reassignment.
 * @param studioId - Studio UUID whose project access is being revoked
 * @param userId - The kicked member's user UUID
 * @param tx - Optional drizzle transaction handle
 * @returns the number of `project_members` rows soft-deleted
 */
export async function softDeleteAllInStudioForUser(
  studioId: string,
  userId: string,
  tx?: DbTx,
): Promise<number> {
  const handle = tx ?? db;
  const rows = await handle
    .update(projectMembers)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
        inArray(
          projectMembers.projectId,
          handle
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(eq(projects.studioId, studioId), isNull(projects.deletedAt)),
            ),
        ),
      ),
    )
    .returning({ projectId: projectMembers.projectId });
  return rows.length;
}

/**
 * List the projects a user actively OWNS within one studio — read BEFORE the
 * kick's soft-delete so the caller knows which projects to hand to the admin.
 *
 * Inner-joins `projects` to scope by `studio_id` and filters role='owner' +
 * both rows active. Returns bare project ids (the caller reassigns each via
 * `materializeOwner` in the same tx).
 * @param studioId - Studio UUID
 * @param userId - The kicked member's user UUID
 * @param tx - Optional drizzle transaction handle
 * @returns the ids of active projects the user owns in this studio
 */
export async function listOwnedProjectsInStudio(
  studioId: string,
  userId: string,
  tx?: DbTx,
): Promise<string[]> {
  const handle = tx ?? db;
  const rows = await handle
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.role, "owner"),
        isNull(projectMembers.deletedAt),
        eq(projects.studioId, studioId),
        isNull(projects.deletedAt),
      ),
    );
  return rows.map((r) => r.projectId);
}

/**
 * Hand a project to the studio admin — insert, revive, or promote the admin
 * to active owner. The owner-reassignment half of a studio kick (slice 3).
 *
 * ON CONFLICT (project_id, user_id) DO UPDATE with no `setWhere`: a missing
 * row inserts an active owner; an existing row (active viewer/editor or
 * soft-deleted) is promoted/revived to active owner. The caller MUST have
 * already soft-deleted the kicked owner's row in the same tx — otherwise this
 * second active owner hits the `project_members_one_owner_per_project` partial
 * unique and throws.
 * @param projectId - Project UUID being reassigned
 * @param userId - The studio admin's user UUID (becomes the new owner)
 * @param tx - Optional drizzle transaction handle
 */
export async function materializeOwner(
  projectId: string,
  userId: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle
    .insert(projectMembers)
    .values({ projectId, userId, role: "owner", addedBy: null })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role: "owner", addedBy: null, addedAt: sql`now()`, deletedAt: null },
    });
}
