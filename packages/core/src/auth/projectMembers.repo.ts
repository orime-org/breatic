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

import { and, eq, isNull, isNotNull, inArray, ne, sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import type { DbTx } from "@core/db/client.js";
import { projectMembers, projects, studioMembers } from "@core/db/schema.js";
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
 * Read a member's project role **inside a transaction, holding a row lock** on
 * that member row.
 *
 * Distinct from {@link getRole}, which is the unlocked read behind
 * `requireRole` / `onAuthenticate`. A mutation that decides based on the
 * unlocked read is acting on a snapshot taken outside its own transaction,
 * and every write in this repo that follows such a decision is an upsert
 * clearing `deleted_at` ({@link materializeOwner},
 * {@link materializeBaselineViewer}) — so a membership revocation committing
 * in that window is not merely missed, it is UNDONE. Locking the row makes
 * the concurrent writer queue instead of interleaving.
 *
 * `FOR UPDATE OF project_members` locks only this table; the `projects` join
 * is a liveness guard, and locking the project row would serialise unrelated
 * membership work across every member of that project.
 *
 * **Lock ordering (invariant, shared with the studio-membership paths): take
 * `studio_members` rows BEFORE `project_members` rows.** Leaving / being
 * kicked locks the studio rows first and then writes project rows; a caller
 * that grabbed the project row first would deadlock against it.
 * @param projectId - Project UUID
 * @param userId - User UUID
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns Role, or null if the project is missing/deleted or the user has no
 *   active membership
 */
export async function lockMemberRole(
  projectId: string,
  userId: string,
  tx: DbTx,
): Promise<ProjectRole | null> {
  const rows = await tx
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
    .for("update", { of: projectMembers })
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
 * List a project's eligible OWNER-transfer recipients (2026-07-08).
 *
 * A recipient must satisfy BOTH layers (ADR D3): already an active project
 * member with the `editor` or `viewer` role (the current `owner` is excluded by
 * the role filter) AND an active NON-guest member of the project's studio. The
 * studio join blocks "outside collaborators" (project members who are not studio
 * members) so ownership can never leave the studio, and excludes guests.
 * Returns bare `{ userId, role }` (the caller merges display profiles).
 * @param projectId - Project UUID
 * @returns The eligible recipients' user ids + their current project role
 */
export async function listTransferCandidates(
  projectId: string,
): Promise<Array<{ userId: string; role: Exclude<ProjectRole, "owner"> }>> {
  const rows = await db
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .innerJoin(
      studioMembers,
      and(
        eq(studioMembers.userId, projectMembers.userId),
        eq(studioMembers.studioId, projects.studioId),
        isNull(studioMembers.deletedAt),
        ne(studioMembers.role, "guest"),
      ),
    )
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        inArray(projectMembers.role, ["editor", "viewer"]),
        isNull(projectMembers.deletedAt),
        isNull(projects.deletedAt),
      ),
    );
  return rows.map((r) => ({
    userId: r.userId,
    role: r.role as Exclude<ProjectRole, "owner">,
  }));
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
 * Change a member's role only if they still hold the role the caller assumed
 * AND the deciding user still owns the project — both checked inside the one
 * statement that does the write.
 *
 * A deferred decision is answered days after it was filed, so everything it
 * assumed may have moved: the member could have been promoted or removed, and
 * the decider could have transferred the project away. Reading those facts and
 * then writing is a race; the point of this function is that there is nothing
 * between the check and the write to race with.
 *
 * It deliberately takes NO row lock. A single statement locks only the row it
 * changes and never waits on a second one, so this path cannot take part in a
 * deadlock — which matters because the other writers on this table (the
 * project-delete cascade, the studio kick) already form one. The `EXISTS` is
 * unlocked, leaving a statement-wide window in which someone who has just
 * stopped being the owner could still land a decision. That is a bounded
 * cost and a deliberate one: the write never touches an owner row, so "exactly
 * one owner per project" cannot break — the worst case drops from corrupt data
 * to one microsecond of stale authority.
 * @param projectId - Project UUID
 * @param userId - The member being re-roled
 * @param fromRole - The role they must still hold for the write to happen
 * @param toRole - The role to move them to
 * @param deciderUserId - The user whose ownership authorises this
 * @param tx - Optional drizzle transaction handle
 * @returns `true` if the row was updated; `false` when either premise failed
 */
export async function updateRoleUnderOwner(
  projectId: string,
  userId: string,
  fromRole: Exclude<ProjectRole, "owner">,
  toRole: Exclude<ProjectRole, "owner">,
  deciderUserId: string,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
    .update(projectMembers)
    .set({ role: toRole })
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.role, fromRole),
        isNull(projectMembers.deletedAt),
        sql`EXISTS (
          SELECT 1 FROM ${projectMembers} AS decider
          WHERE decider.project_id = ${projectId}
            AND decider.user_id = ${deciderUserId}
            AND decider.role = 'owner'
            AND decider.deleted_at IS NULL
        )`,
      ),
    )
    .returning({ projectId: projectMembers.projectId });
  return rows.length > 0;
}

/**
 * Soft-delete a member row.
 *
 * Caller MUST refuse to remove an owner (owners change hands only via
 * transfer-owner), and MUST make that decision under
 * {@link lockMemberRole} in the same transaction — this statement matches on
 * `deleted_at IS NULL` alone, so it happily deletes a row that became the
 * owner after an unlocked check said otherwise. Returns `false` if no active
 * row matched.
 * @param projectId - Project UUID
 * @param userId - Target user UUID
 * @param tx - Optional drizzle transaction handle
 * @returns `true` if a row was soft-deleted
 */
export async function softDelete(
  projectId: string,
  userId: string,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
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
 * List the projects a user actively OWNS within one studio, **holding a row
 * lock on each** — read BEFORE the leave/kick soft-deletes them, so the caller
 * knows which projects to hand to the admin.
 *
 * Inner-joins `projects` to scope by `studio_id` and filters role='owner' +
 * both rows active. Returns bare project ids (the caller reassigns each via
 * {@link materializeOwner} in the same tx).
 *
 * The lock, and the mandatory `tx`, are what make the result still true by the
 * time the caller acts on it. Unlocked, a project transfer committing in the
 * gap moves one of these projects to somebody else — and the caller, still
 * believing this user owns it, hands it to the admin as well and collides with
 * `project_members_one_owner_per_project`. There is no correct way to call
 * this outside a transaction, so it does not offer one.
 *
 * `FOR UPDATE OF project_members` locks only the membership rows; the
 * `projects` join is a scope filter, and locking project rows would serialise
 * unrelated work across the studio.
 * @param studioId - Studio UUID
 * @param userId - The departing member's user UUID
 * @param tx - The enclosing transaction; the lock is meaningless without one
 * @returns the ids of active projects the user owns in this studio
 */
export async function lockOwnedProjectsInStudio(
  studioId: string,
  userId: string,
  tx: DbTx,
): Promise<string[]> {
  const rows = await tx
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
    )
    .for("update", { of: projectMembers });
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
