/**
 * Project access request repository — `project_access_requests` table CRUD.
 *
 * NOT_MEMBER users can request access to a project they can't see.
 * Three entry paths feed this table (see `share_links` table doc):
 *
 *   path 1: direct URL visit on a project the caller has no role on
 *   path 2: email invite link click (sender used ShareDialog)
 *   path 3: forwarded share link (path 2's link given to a third party)
 *
 * Partial UNIQUE (project_id, requester_user_id) WHERE deleted_at IS NULL
 * AND status = 'pending' enforces "one pending request per (project,
 * user)" — on conflict, this repo's `create()` throws and the service
 * surfaces it as Conflict.
 *
 * Soft delete is the only deletion mode (matching project-wide rule).
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import { projectAccessRequests, users } from "@core/db/schema.js";
import type { DbTx } from "@core/modules/conversation.repo.js";

export type AccessRequestStatus = "pending" | "approved" | "rejected";

export interface AccessRequest {
  id: string;
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  message: string | null;
  status: AccessRequestStatus;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Same row but with the requester's display fields joined in. Used by
 * `listPendingByProject` so the BellMenu can render real names + emails
 * instead of UUIDs (one query, no N+1 from the client side).
 */
export interface AccessRequestWithRequester extends AccessRequest {
  requester: {
    id: string;
    username: string | null;
    email: string;
  };
}

function toEntity(
  row: typeof projectAccessRequests.$inferSelect,
): AccessRequest {
  return {
    id: row.id,
    projectId: row.projectId,
    requesterUserId: row.requesterUserId,
    requestedRole: row.requestedRole,
    message: row.message,
    status: row.status as AccessRequestStatus,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Insert a new access request.
 *
 * The partial unique index `par_one_pending_per_user_per_project_idx`
 * raises `23505` if the requester already has a pending request on
 * this project — the service catches and rethrows as Conflict.
 *
 * @returns The newly created row's entity.
 */
export async function create(input: {
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  message: string | null;
}): Promise<AccessRequest> {
  const rows = await db
    .insert(projectAccessRequests)
    .values({
      projectId: input.projectId,
      requesterUserId: input.requesterUserId,
      requestedRole: input.requestedRole,
      message: input.message,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("accessRequestRepo.create: insert returned no row");
  }
  return toEntity(row);
}

/**
 * Fetch a single access request by id (no soft-delete filter so the
 * service can verify the row exists even if it's been canceled).
 */
export async function findById(id: string): Promise<AccessRequest | null> {
  const rows = await db
    .select()
    .from(projectAccessRequests)
    .where(eq(projectAccessRequests.id, id))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Get a user's currently-pending request on a project, if any.
 *
 * Reads the same set that the partial unique index covers, so this
 * function is the canonical "does the user already have a pending
 * request here?" check.
 */
export async function findPendingByRequester(
  projectId: string,
  requesterUserId: string,
): Promise<AccessRequest | null> {
  const rows = await db
    .select()
    .from(projectAccessRequests)
    .where(
      and(
        eq(projectAccessRequests.projectId, projectId),
        eq(projectAccessRequests.requesterUserId, requesterUserId),
        eq(projectAccessRequests.status, "pending"),
        isNull(projectAccessRequests.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * List pending requests on a project (owner/admin BellMenu view).
 *
 * Joins users so the caller can render real names/emails without a
 * second roundtrip. FK guarantees a row in users so the LEFT JOIN
 * always matches (but we still type the requester as a regular field
 * because the JOIN technically could return null if a soft-deleted
 * user is involved — defensive).
 */
export async function listPendingByProject(
  projectId: string,
): Promise<AccessRequestWithRequester[]> {
  const rows = await db
    .select({
      req: projectAccessRequests,
      user: {
        id: users.id,
        username: users.username,
        email: users.email,
      },
    })
    .from(projectAccessRequests)
    .leftJoin(users, eq(users.id, projectAccessRequests.requesterUserId))
    .where(
      and(
        eq(projectAccessRequests.projectId, projectId),
        eq(projectAccessRequests.status, "pending"),
        isNull(projectAccessRequests.deletedAt),
      ),
    )
    .orderBy(desc(projectAccessRequests.createdAt));
  return rows.map((row) => ({
    ...toEntity(row.req),
    requester: {
      id: row.user?.id ?? row.req.requesterUserId,
      username: row.user?.username ?? null,
      email: row.user?.email ?? "",
    },
  }));
}

/** List all requests issued by a user (their own status page). */
export async function listByRequester(
  requesterUserId: string,
): Promise<AccessRequest[]> {
  const rows = await db
    .select()
    .from(projectAccessRequests)
    .where(
      and(
        eq(projectAccessRequests.requesterUserId, requesterUserId),
        isNull(projectAccessRequests.deletedAt),
      ),
    )
    .orderBy(desc(projectAccessRequests.createdAt));
  return rows.map(toEntity);
}

/**
 * Update a pending request's status to approved/rejected.
 *
 * Caller MUST pass `tx` when transitioning to 'approved' because the
 * service also inserts a `project_members` row in the same transaction.
 * Returns `false` if no pending row matched (e.g. already reviewed).
 */
export async function updateStatus(
  id: string,
  newStatus: Exclude<AccessRequestStatus, "pending">,
  reviewerUserId: string,
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .update(projectAccessRequests)
    .set({
      status: newStatus,
      reviewedByUserId: reviewerUserId,
      reviewedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectAccessRequests.id, id),
        eq(projectAccessRequests.status, "pending"),
        isNull(projectAccessRequests.deletedAt),
      ),
    )
    .returning({ id: projectAccessRequests.id });
  return rows.length > 0;
}
