// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project join requests repository — the only module that touches the
 * `project_join_requests` table.
 *
 * A studio member who is not on a project asks its owner to let them in. The
 * table mirrors `role_upgrade_requests`, and the same two rules hold here:
 *
 * REAPING. At most one pending request per (project, requester), enforced by a
 * partial unique index whose predicate cannot mention `now()`, so a timed-out
 * request keeps `status = 'pending'` until something flips it.
 * {@link createPending} reaps stale pendings on its key in the same
 * transaction that takes the slot.
 *
 * LOCKING BY ID, NOT BY STATUS. {@link lockRequest} locks on `id` alone and
 * reports the status it found: a `status = 'pending'` predicate in a
 * `FOR UPDATE` makes the loser of a concurrent decision read nothing, which is
 * indistinguishable from "no such request".
 */

import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db, projectJoinRequests } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { mintShareToken } from "@server/utils/share-token.js";

/** Where a request sits in its lifecycle. */
export type ProjectJoinStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

/** The two roles an owner can grant when letting someone in. */
export type GrantableRole = "viewer" | "editor";

/** A locked request, with what the decision path needs to judge it. */
export interface LockedJoinRequest {
  id: string;
  projectId: string;
  requesterUserId: string;
  status: ProjectJoinStatus;
  notificationId: string | null;
  /** True when the deadline has passed — the row is still `pending` either way. */
  expired: boolean;
}

/** A pending request as an owner change re-addresses it. */
export interface PendingJoinRequest {
  id: string;
  requesterUserId: string;
  shareToken: string;
  message: string | null;
  expiresAt: Date;
  notificationId: string | null;
}

/**
 * Flip timed-out pendings on one key to `expired`, freeing the unique slot.
 * @param projectId - The project asked about.
 * @param requesterUserId - The person asking.
 * @param tx - The enclosing transaction, shared with the insert that follows.
 * @returns The bell entries of the rows reaped; the caller retires them.
 */
export async function expireStalePending(
  projectId: string,
  requesterUserId: string,
  tx: DbTx,
): Promise<string[]> {
  const rows = await tx
    .update(projectJoinRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(projectJoinRequests.projectId, projectId),
        eq(projectJoinRequests.requesterUserId, requesterUserId),
        eq(projectJoinRequests.status, "pending"),
        isNull(projectJoinRequests.deletedAt),
        lte(projectJoinRequests.expiresAt, sql`now()`),
      ),
    )
    .returning({ notificationId: projectJoinRequests.notificationId });
  return rows
    .map((r) => r.notificationId)
    .filter((id): id is string => id !== null);
}

/** A freshly filed request, and the bell entries its reap left to take down. */
export interface CreatedJoinRequest {
  id: string;
  shareToken: string;
  retiredNotificationIds: string[];
}

/**
 * Insert a pending request, reaping any stale one on the same key first.
 * @param input - The request to create.
 * @param input.projectId - The project asked about.
 * @param input.requesterUserId - The person asking.
 * @param input.message - Optional note for the owner.
 * @param input.expiresAt - When the request stops being answerable.
 * @param input.tx - The enclosing transaction.
 * @returns The new request's id and token, plus bell entries of reaped rows.
 * @throws {Error} 23505 when a live pending already holds this key.
 */
export async function createPending(input: {
  projectId: string;
  requesterUserId: string;
  message: string | null;
  expiresAt: Date;
  tx: DbTx;
}): Promise<CreatedJoinRequest> {
  const retiredNotificationIds = await expireStalePending(
    input.projectId,
    input.requesterUserId,
    input.tx,
  );
  const rows = await input.tx
    .insert(projectJoinRequests)
    .values({
      projectId: input.projectId,
      requesterUserId: input.requesterUserId,
      message: input.message,
      status: "pending",
      shareToken: mintShareToken(),
      expiresAt: input.expiresAt,
    })
    .returning({ id: projectJoinRequests.id, shareToken: projectJoinRequests.shareToken });
  const row = rows[0];
  if (!row) throw new Error("projectJoinRequestsRepo.createPending: insert returned no row");
  return { id: row.id, shareToken: row.shareToken, retiredNotificationIds };
}

/**
 * Point a request at the bell entry that announces it. Used when the request
 * is filed and again when an owner change moves it to the new owner.
 * @param id - Request id.
 * @param notificationId - The owner's bell entry.
 * @param tx - The enclosing transaction.
 */
export async function setNotification(
  id: string,
  notificationId: string,
  tx: DbTx,
): Promise<void> {
  await tx
    .update(projectJoinRequests)
    .set({ notificationId })
    .where(eq(projectJoinRequests.id, id));
}

/**
 * Take the row lock the decision path serialises on, and report what it found.
 * @param id - Request id.
 * @param tx - The deciding transaction.
 * @returns The locked request, or null when there is no such live row.
 */
export async function lockRequest(
  id: string,
  tx: DbTx,
): Promise<LockedJoinRequest | null> {
  const rows = await tx
    .select({
      id: projectJoinRequests.id,
      projectId: projectJoinRequests.projectId,
      requesterUserId: projectJoinRequests.requesterUserId,
      status: projectJoinRequests.status,
      notificationId: projectJoinRequests.notificationId,
      expired: lte(projectJoinRequests.expiresAt, sql`now()`).mapWith(Boolean),
    })
    .from(projectJoinRequests)
    .where(and(eq(projectJoinRequests.id, id), isNull(projectJoinRequests.deletedAt)))
    .for("update");
  const row = rows[0];
  if (!row) return null;
  return { ...row, status: row.status as ProjectJoinStatus };
}

/**
 * Move a still-pending request to a terminal status.
 *
 * The `status = 'pending'` predicate is the serialisation point: of two
 * concurrent settlements exactly one UPDATE matches. `granted_role` is set
 * exactly when the status is `approved` (the table's CHECK enforces it).
 * @param id - Request id.
 * @param settlement - How it ends.
 * @param settlement.status - The terminal status.
 * @param settlement.decidedByUserId - The owner who ruled, or null.
 * @param settlement.grantedRole - The role granted; approvals only.
 * @param tx - The enclosing transaction.
 * @returns True when this call is the one that settled it.
 */
export async function settleIfPending(
  id: string,
  settlement:
    | { status: "approved"; decidedByUserId: string; grantedRole: GrantableRole }
    | { status: "rejected"; decidedByUserId: string }
    | { status: "expired" },
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .update(projectJoinRequests)
    .set({
      status: settlement.status,
      decidedByUserId: settlement.status === "expired" ? null : settlement.decidedByUserId,
      decidedAt: settlement.status === "expired" ? null : new Date(),
      grantedRole: settlement.status === "approved" ? settlement.grantedRole : null,
      ...(settlement.status === "expired"
        ? { expiresAt: sql`LEAST(${projectJoinRequests.expiresAt}, now())` }
        : {}),
    })
    .where(
      and(
        eq(projectJoinRequests.id, id),
        eq(projectJoinRequests.status, "pending"),
        isNull(projectJoinRequests.deletedAt),
      ),
    )
    .returning({ id: projectJoinRequests.id });
  return rows.length > 0;
}

/**
 * Expire the pending request one person has on a project, if any — they just
 * became a member by another route, so there is nothing left to ask for.
 * @param projectId - The project.
 * @param requesterUserId - The person who became a member.
 * @param tx - The transaction that wrote their member row.
 * @returns The bell entry to retire, or null when there was no pending request.
 */
export async function expirePendingFor(
  projectId: string,
  requesterUserId: string,
  tx: DbTx,
): Promise<{ notificationId: string | null } | null> {
  const rows = await tx
    .update(projectJoinRequests)
    .set({
      status: "expired",
      expiresAt: sql`LEAST(${projectJoinRequests.expiresAt}, now())`,
    })
    .where(
      and(
        eq(projectJoinRequests.projectId, projectId),
        eq(projectJoinRequests.requesterUserId, requesterUserId),
        eq(projectJoinRequests.status, "pending"),
        isNull(projectJoinRequests.deletedAt),
      ),
    )
    .returning({ notificationId: projectJoinRequests.notificationId });
  return rows[0] ?? null;
}

/**
 * The requester withdraws their own pending request on a project.
 * @param projectId - The project.
 * @param requesterUserId - The person withdrawing.
 * @param tx - The enclosing transaction.
 * @returns The bell entry to retire, or null when nothing was pending.
 */
export async function cancelPendingFor(
  projectId: string,
  requesterUserId: string,
  tx: DbTx,
): Promise<{ notificationId: string | null } | null> {
  const rows = await tx
    .update(projectJoinRequests)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(
      and(
        eq(projectJoinRequests.projectId, projectId),
        eq(projectJoinRequests.requesterUserId, requesterUserId),
        eq(projectJoinRequests.status, "pending"),
        isNull(projectJoinRequests.deletedAt),
        gt(projectJoinRequests.expiresAt, sql`now()`),
      ),
    )
    .returning({ notificationId: projectJoinRequests.notificationId });
  return rows[0] ?? null;
}

/**
 * A person's live request on a project, for the dialog.
 *
 * `expires_at > now()` is required: the unique index ignores the deadline, so
 * without it a request that timed out would still show as pending.
 * @param projectId - The project.
 * @param requesterUserId - The signed-in person.
 * @returns Their live request, or null.
 */
export async function findLiveFor(
  projectId: string,
  requesterUserId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const rows = await db
    .select({ id: projectJoinRequests.id, createdAt: projectJoinRequests.createdAt })
    .from(projectJoinRequests)
    .where(
      and(
        eq(projectJoinRequests.projectId, projectId),
        eq(projectJoinRequests.requesterUserId, requesterUserId),
        eq(projectJoinRequests.status, "pending"),
        isNull(projectJoinRequests.deletedAt),
        gt(projectJoinRequests.expiresAt, sql`now()`),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Every live pending request on a project, for re-addressing to a new owner.
 * @param projectId - The project whose owner changed.
 * @param tx - The transaction that wrote the new owner.
 * @returns The live pending requests.
 */
export async function listLivePendingForProject(
  projectId: string,
  tx: DbTx,
): Promise<PendingJoinRequest[]> {
  return tx
    .select({
      id: projectJoinRequests.id,
      requesterUserId: projectJoinRequests.requesterUserId,
      shareToken: projectJoinRequests.shareToken,
      message: projectJoinRequests.message,
      expiresAt: projectJoinRequests.expiresAt,
      notificationId: projectJoinRequests.notificationId,
    })
    .from(projectJoinRequests)
    .where(
      and(
        eq(projectJoinRequests.projectId, projectId),
        eq(projectJoinRequests.status, "pending"),
        isNull(projectJoinRequests.deletedAt),
        gt(projectJoinRequests.expiresAt, sql`now()`),
      ),
    );
}

/**
 * Which project a request is about, read WITHOUT a lock.
 *
 * The decision path locks the project before the request (the order every
 * project-scoped request path and the delete cascade share), so it needs the
 * project id first. A request's `project_id` never changes, so an unlocked
 * read is safe; whether it may still be answered is decided under the locks.
 * @param id - Request id.
 * @param tx - The deciding transaction.
 * @returns The project id, or null when there is no such live row.
 */
export async function getProjectIdOf(id: string, tx: DbTx): Promise<string | null> {
  const rows = await tx
    .select({ projectId: projectJoinRequests.projectId })
    .from(projectJoinRequests)
    .where(and(eq(projectJoinRequests.id, id), isNull(projectJoinRequests.deletedAt)));
  return rows[0]?.projectId ?? null;
}
