/**
 * Role-upgrade request service — viewer asks owner for editor rights.
 *
 * Three operations:
 *   - `request`: viewer creates a `role_upgrade_request` notification
 *     in the owner's inbox.
 *   - `approve`: owner decides → service updates `project_members.role`
 *     to 'edit' AND creates a `role_upgrade_approved` notification in
 *     the requester's inbox AND marks the original request as read.
 *   - `reject`: owner decides → service creates a
 *     `role_upgrade_rejected` notification in the requester's inbox
 *     AND marks the original request as read. No member-table change.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 6.3.
 *
 * Authorization model (route layer enforces gates):
 *   - request: caller must be an active member of the project, role 'view'
 *   - approve / reject: caller must be the project owner
 *
 * Atomicity: approve runs in a single db transaction so role bump +
 * approved notification + mark-read happen together; reject also runs
 * in a transaction for the same reason. If any step fails, the whole
 * decision is rolled back.
 */

import { db } from "@core/db/client.js";
import * as notificationRepo from "@core/modules/notification.repo.js";
import * as notificationService from "@core/modules/notification.service.js";
import * as projectMembersRepo from "@core/modules/projectMembers.repo.js";
import { NotFoundError, ForbiddenError, ValidationError } from "@core/errors.js";
import { t } from "@breatic/shared";
import type { Notification } from "@core/modules/notification.repo.js";

interface RoleUpgradeRequestInput {
  ownerUserId: string;
  requesterUserId: string;
  projectId: string;
  projectName: string;
  message?: string | null;
}

/**
 * Viewer creates a role-upgrade request. Inserts a single
 * notification in the owner's inbox.
 *
 * @returns the inserted notification (caller can echo the id back to
 *   the requester for client-side optimistic display).
 */
export async function request(
  input: RoleUpgradeRequestInput,
): Promise<Notification> {
  return notificationService.createRoleUpgradeRequest({
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    payload: {
      requesterUserId: input.requesterUserId,
      projectName: input.projectName,
      requestedRole: "edit",
      message: input.message ?? null,
    },
  });
}

interface DecisionInput {
  notificationId: string;
  ownerUserId: string;
  projectName: string;
}

/**
 * Owner approves a viewer's role-upgrade request.
 *
 * Atomic: (1) bump member role view → edit, (2) create approved
 * notification for the requester, (3) mark the request notification
 * as read on the owner's side.
 *
 * @throws {@link NotFoundError} if the request notification doesn't
 *   exist, was already decided (read), or doesn't belong to
 *   `ownerUserId`.
 * @throws {@link ValidationError} if the notification isn't a
 *   role-upgrade-request type (defense in depth — the route should
 *   already filter by id).
 */
export async function approve(input: DecisionInput): Promise<void> {
  await db.transaction(async (tx) => {
    const req = await loadAndGate(tx, input);
    const requesterUserId = String(req.payload.requesterUserId);
    const ok = await projectMembersRepo.updateRole(
      String(req.projectId),
      requesterUserId,
      "edit",
    );
    if (!ok) {
      throw new NotFoundError(t("server.error.notFound"));
    }
    await notificationService.createRoleUpgradeApproved({
      requesterUserId,
      projectId: String(req.projectId),
      payload: {
        projectName: input.projectName,
        newRole: "edit",
      },
      tx,
    });
    await notificationRepo.markRead(req.id, input.ownerUserId);
  });
}

/**
 * Owner rejects a viewer's role-upgrade request.
 *
 * Atomic: (1) create rejected notification for the requester,
 * (2) mark the request notification as read on the owner's side.
 *
 * @throws {@link NotFoundError} if the request notification doesn't
 *   exist, was already decided (read), or doesn't belong to
 *   `ownerUserId`.
 */
export async function reject(
  input: DecisionInput & { reason?: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    const req = await loadAndGate(tx, input);
    await notificationService.createRoleUpgradeRejected({
      requesterUserId: String(req.payload.requesterUserId),
      projectId: String(req.projectId),
      payload: {
        projectName: input.projectName,
        reason: input.reason ?? null,
      },
      tx,
    });
    await notificationRepo.markRead(req.id, input.ownerUserId);
  });
}

interface LoadedRequest {
  id: string;
  projectId: string;
  payload: { requesterUserId: string };
}

async function loadAndGate(
  _tx: unknown,
  input: DecisionInput,
): Promise<LoadedRequest> {
  const row = await notificationRepo.findById(input.notificationId);
  if (!row) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  if (row.userId !== input.ownerUserId) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (row.type !== "access.role_upgrade_request") {
    throw new ValidationError(t("server.error.validation"));
  }
  if (row.readAt !== null) {
    // Already decided — second click on stale BellMenu state.
    throw new NotFoundError(t("server.error.notFound"));
  }
  const payload = row.payload as { requesterUserId?: unknown };
  if (typeof payload.requesterUserId !== "string") {
    throw new ValidationError(t("server.error.validation"));
  }
  if (row.projectId === null) {
    throw new ValidationError(t("server.error.validation"));
  }
  return {
    id: row.id,
    projectId: row.projectId,
    payload: { requesterUserId: payload.requesterUserId },
  };
}
