/**
 * Project access request service — request / list / approve / reject.
 *
 * Spec: engineering/specs/2026-05-26-deprecate-noaccount-email-auth-spec.md
 * § 4.3 (table) + § 5.2 (endpoints) + § 7 decision 7 (NOT_MEMBER flow).
 *
 * Authorization model:
 *   - Anyone authenticated can call `createRequest` (the existence of
 *     a project they don't belong to is sufficient context).
 *   - `listPendingByProject` / `approveRequest` / `rejectRequest`
 *     require owner role on the project — enforced at the route layer
 *     via `requireRole('owner')`, this service trusts the route gate.
 *   - `listByRequester` is the caller's own page (self-scoped).
 *
 * Invariants enforced here (PG also catches via partial UNIQUE index):
 *   - One pending request per (project, user) — Conflict.
 *   - `requestedRole` must be `'edit'` or `'view'` (never `'owner'`).
 *   - Cannot request access on a project you're already an active
 *     member of — Conflict (the user is just trying to navigate).
 *   - State transitions: pending → approved / rejected only; never
 *     back to pending. The `updateStatus` repo call guards this.
 *
 * Side effects on approve:
 *   - Inserts a `project_members` row for the requester with the
 *     `requestedRole` they asked for (per user-confirmed decision:
 *     applicant chooses role at request time; owner's approve = grant
 *     that exact role, no override).
 *   - Publishes `members-changed` so collab broadcasts cache
 *     invalidation to connected clients.
 *
 * Email notifications are dispatched by the route/handler layer, not
 * here — the application boundary owns logger + mail side effects.
 * This service returns the structured outcome so callers can decide.
 */

import { db } from "../db/client.js";
import * as accessRequestRepo from "./accessRequest.repo.js";
import * as projectMembersRepo from "./projectMembers.repo.js";
import { publishMembersChanged } from "../infra/control-events.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { t } from "@breatic/shared";
import type { ProjectRole } from "@breatic/shared";
import type { AccessRequest, AccessRequestWithRequester } from "./accessRequest.repo.js";

/** Roles a user is allowed to request — `owner` is never grantable. */
export type RequestableRole = Exclude<ProjectRole, "owner">;

function isRequestableRole(role: string): role is RequestableRole {
  return role === "edit" || role === "view";
}

/** Type guard for the Postgres unique-violation SQLSTATE. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

/**
 * Create a new access request.
 *
 * @throws {@link ValidationError} if `requestedRole` is not 'edit' or 'view'
 * @throws {@link ConflictError} if the user is already an active member
 *   on the project, or already has a pending request (partial UNIQUE)
 */
export async function createRequest(input: {
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  message: string | null;
}): Promise<AccessRequest> {
  if (!isRequestableRole(input.requestedRole)) {
    throw new ValidationError(t("server.error.validation"));
  }

  const existing = await projectMembersRepo.getRole(
    input.projectId,
    input.requesterUserId,
  );
  if (existing !== null) {
    throw new ConflictError(t("server.error.conflict"));
  }

  try {
    return await accessRequestRepo.create(input);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.error.conflict"));
    }
    throw err;
  }
}

/** List pending requests on a project. Route enforces owner gate. */
export async function listPendingByProject(
  projectId: string,
): Promise<AccessRequestWithRequester[]> {
  return accessRequestRepo.listPendingByProject(projectId);
}

/** List a user's own requests. Route enforces self-scope. */
export async function listByRequester(
  requesterUserId: string,
): Promise<AccessRequest[]> {
  return accessRequestRepo.listByRequester(requesterUserId);
}

/**
 * Approve a pending request — atomically transitions status and
 * inserts a `project_members` row for the requester with the role
 * they asked for.
 *
 * @throws {@link NotFoundError} if the request doesn't exist or is
 *   already reviewed / soft-deleted
 * @throws {@link ValidationError} if the stored `requestedRole` is
 *   somehow invalid (shouldn't happen if `createRequest` validated;
 *   defensive guard)
 */
export async function approveRequest(
  requestId: string,
  reviewerUserId: string,
): Promise<AccessRequest> {
  const request = await accessRequestRepo.findById(requestId);
  if (
    !request ||
    request.deletedAt !== null ||
    request.status !== "pending"
  ) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  if (!isRequestableRole(request.requestedRole)) {
    throw new ValidationError(t("server.error.validation"));
  }
  // Pin the narrowed role into a local const so TS keeps the
  // `'view' | 'edit'` narrowing across the async tx boundary.
  const grantedRole: RequestableRole = request.requestedRole;

  await db.transaction(async (tx) => {
    const updated = await accessRequestRepo.updateStatus(
      requestId,
      "approved",
      reviewerUserId,
      tx,
    );
    if (!updated) {
      // Concurrent reviewer raced — already-reviewed by the time
      // updateStatus ran. Surface as NotFound so the caller refreshes.
      throw new NotFoundError(t("server.error.notFound"));
    }
    await projectMembersRepo.upsertMember(
      request.projectId,
      request.requesterUserId,
      grantedRole,
      reviewerUserId,
      tx,
    );
  });

  await publishMembersChanged(request.projectId, {
    affectedUserId: request.requesterUserId,
    action: "invite",
    newRole: grantedRole,
  });

  const fresh = await accessRequestRepo.findById(requestId);
  if (!fresh) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  return fresh;
}

/**
 * Reject a pending request — sets status to 'rejected' without
 * touching project_members. No `members-changed` publish because no
 * member graph mutation happened; the requester's own status page
 * will refresh from `listByRequester`.
 *
 * @throws {@link NotFoundError} if the request doesn't exist or is
 *   already reviewed
 */
export async function rejectRequest(
  requestId: string,
  reviewerUserId: string,
): Promise<AccessRequest> {
  const request = await accessRequestRepo.findById(requestId);
  if (
    !request ||
    request.deletedAt !== null ||
    request.status !== "pending"
  ) {
    throw new NotFoundError(t("server.error.notFound"));
  }

  await db.transaction(async (tx) => {
    const updated = await accessRequestRepo.updateStatus(
      requestId,
      "rejected",
      reviewerUserId,
      tx,
    );
    if (!updated) {
      throw new NotFoundError(t("server.error.notFound"));
    }
  });

  const fresh = await accessRequestRepo.findById(requestId);
  if (!fresh) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  return fresh;
}
