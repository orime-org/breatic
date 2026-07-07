// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project transfer-owner handshake service (#1611) — mirrors the studio
 * transfer-admin handshake (see studioTransfer.service), but moves the project
 * OWNER role instead of the studio admin role.
 *
 * Three operations:
 *   - `requestProjectTransfer`: the current project owner asks a non-guest
 *     studio member to take over as owner. Drops an actionable
 *     `project.transfer_request` notification (confirm/cancel) in the
 *     recipient's inbox, expiring after 7 days.
 *   - `confirmProjectTransfer`: the recipient accepts. In ONE db.transaction:
 *     mark the request read (the CAS serialization point), then demote the old
 *     owner to editor FIRST (#1611 / D1 "降一档") and promote the recipient to
 *     owner SECOND via `materializeOwner` (insert / revive / promote — the
 *     recipient may not yet be a project member), then notify the old owner via
 *     `project.transfer_approved`. AFTER the tx commits, append the
 *     `member:ownership-transferred` activity (best-effort audit).
 *   - `cancelProjectTransfer`: the recipient declines. Only marks the request
 *     read — no role change. An unconfirmed request self-voids once its 7-day
 *     `expires_at` passes.
 *
 * Authorization model (route layer enforces the initiator gate):
 *   - requestProjectTransfer: caller must be the project owner (`requireRole('owner')`);
 *     the service re-verifies (defense-in-depth) since only the owner — NOT the
 *     studio admin — may initiate a project transfer (ADR D4).
 *   - confirm / cancel: caller must own the notification (the markRead userId guard).
 *
 * Atomicity & once-only: confirm runs in a single db transaction — the
 * mark-read CAS (UPDATE … WHERE read_at IS NULL) is the serialization point, so
 * under concurrency only the first confirm swaps roles; the loser's UPDATE
 * matches zero rows and the whole transaction rolls back. The
 * `project_members_one_owner_per_project` partial unique is the data-integrity
 * backstop: a transfer is applied EXACTLY ONCE and the project always has
 * exactly one active owner.
 */

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { db, projectMembersRepo } from "@breatic/core";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";

/** Days an unconfirmed transfer request stays actionable before it self-voids. */
const TRANSFER_TTL_DAYS = 7;

/**
 * The current project owner asks a non-guest studio member to take over as owner.
 *
 * Loads the project + its studio, refuses personal-studio projects, verifies the
 * caller is the current owner (ADR D4: only the owner initiates — not the studio
 * admin), and requires the recipient to be a distinct non-guest member of the
 * project's studio. Drops an actionable `project.transfer_request` notification
 * that expires after {@link TRANSFER_TTL_DAYS} days. No role change here — the
 * swap is deferred until the recipient confirms.
 * @param projectId - The project whose owner role is being transferred
 * @param fromUserId - The acting owner initiating the transfer
 * @param toUserId - The studio member proposed as the new owner
 * @throws {NotFoundError} project / studio not found, or the recipient is not a
 *   member of the project's studio
 * @throws {ForbiddenError} the studio is personal, or the caller is not the owner
 * @throws {ValidationError} the recipient is the acting owner, or is a guest
 */
export async function requestProjectTransfer(
  projectId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  const studio = await studioRepo.getById(project.studioId);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  // Only the current owner may initiate (ADR D4) — the studio admin cannot.
  const currentOwner = await projectMembersRepo.getOwner(projectId);
  if (currentOwner !== fromUserId) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (toUserId === fromUserId) {
    throw new ValidationError(t("server.error.validation"));
  }
  // The recipient must be a non-guest (admin / maintainer) member of the studio.
  const recipientRole = await studioMembersRepo.getRole(studio.id, toUserId);
  if (!recipientRole) throw new NotFoundError(t("server.error.not_found"));
  if (recipientRole === "guest") {
    throw new ValidationError(t("server.error.validation"));
  }

  const expiresAt = new Date(
    Date.now() + TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const profiles = await studioRepo.getPersonalProfilesByCreators([fromUserId]);
  const from = profiles.get(fromUserId);
  await notificationService.createProjectTransferRequest({
    userId: toUserId,
    payload: {
      fromUserId,
      fromName: from?.name ?? "",
      fromHandle: from?.slug ?? "",
      projectId,
      projectName: project.name,
      projectSlug: project.slug,
    },
    expiresAt,
  });
}

/**
 * The recipient confirms a transfer — atomically swaps the owner role to them.
 *
 * In one transaction: (1) mark-read CAS on the request (serialization point),
 * (2) re-read + gate the notification (right type, still within its TTL),
 * (3) demote the old owner to editor FIRST, (4) promote the recipient to owner
 * SECOND via materializeOwner (order avoids the one-owner partial unique),
 * (5) notify the old owner with `project.transfer_approved`. After the tx
 * commits, append the `member:ownership-transferred` activity (best-effort).
 * @param notificationId - The `project.transfer_request` notification id
 * @param receiverUserId - The recipient confirming (owns the notification)
 * @throws {NotFoundError} the notification is missing, already decided, not a
 *   project transfer request, or the old owner row is gone (stale request)
 * @throws {ConflictError} the request has already expired (past its 7-day TTL)
 * @throws {ValidationError} the notification payload is malformed
 */
export async function confirmProjectTransfer(
  notificationId: string,
  receiverUserId: string,
): Promise<void> {
  let activity: { projectId: string; oldOwnerId: string } | null = null;
  await db.transaction(async (tx) => {
    const won = await notificationRepo.markRead(
      notificationId,
      receiverUserId,
      tx,
    );
    if (!won) throw new NotFoundError(t("server.error.not_found"));

    const row = await notificationRepo.findById(notificationId, tx);
    if (!row || row.type !== "project.transfer_request") {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError(t("server.error.conflict"));
    }
    const payload = row.payload as {
      fromUserId?: unknown;
      projectId?: unknown;
      projectName?: unknown;
      projectSlug?: unknown;
    };
    if (
      typeof payload.fromUserId !== "string" ||
      typeof payload.projectId !== "string"
    ) {
      throw new ValidationError(t("server.error.validation"));
    }
    const { fromUserId, projectId } = payload;
    const projectName =
      typeof payload.projectName === "string" ? payload.projectName : "";
    const projectSlug =
      typeof payload.projectSlug === "string" ? payload.projectSlug : "";

    // Demote the old owner to editor FIRST (drops zero owners), then promote the
    // recipient to owner SECOND — the reverse order would collide with
    // project_members_one_owner_per_project. materializeOwner inserts / revives
    // / promotes the recipient, covering the case where they were not yet a
    // project member.
    const demoted = await projectMembersRepo.updateRole(
      projectId,
      fromUserId,
      "editor",
      tx,
    );
    if (!demoted) throw new NotFoundError(t("server.error.not_found"));
    await projectMembersRepo.materializeOwner(projectId, receiverUserId, tx);

    const profiles = await studioRepo.getPersonalProfilesByCreators([
      receiverUserId,
    ]);
    const accepter = profiles.get(receiverUserId);
    await notificationService.createProjectTransferApproved({
      userId: fromUserId,
      payload: {
        projectName,
        projectSlug,
        accepterName: accepter?.name ?? "",
        accepterHandle: accepter?.slug ?? "",
      },
      tx,
    });
    activity = { projectId, oldOwnerId: fromUserId };
  });

  // Activity row AFTER the swap committed (best-effort audit; the helper
  // announces the live `activity:new` signal itself). The actor is the old
  // owner — they transferred the project away.
  if (activity !== null) {
    const done = activity as { projectId: string; oldOwnerId: string };
    await recordProjectActivity({
      projectId: done.projectId,
      actorUserId: done.oldOwnerId,
      type: "member:ownership-transferred",
      payload: { previousOwnerId: done.oldOwnerId, newOwnerId: receiverUserId },
    });
  }
}

/**
 * The recipient cancels (declines) a transfer — marks the request read, no role
 * change. Idempotent on a second click: a missing / already-decided request
 * collapses to NotFound.
 * @param notificationId - The `project.transfer_request` notification id
 * @param receiverUserId - The recipient declining (owns the notification)
 * @throws {NotFoundError} the notification is missing, already decided, or not
 *   owned by `receiverUserId`
 */
export async function cancelProjectTransfer(
  notificationId: string,
  receiverUserId: string,
): Promise<void> {
  const ok = await notificationRepo.markRead(notificationId, receiverUserId);
  if (!ok) throw new NotFoundError(t("server.error.not_found"));
}
