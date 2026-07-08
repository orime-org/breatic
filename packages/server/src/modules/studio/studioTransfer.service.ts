// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio transfer-admin handshake service (slice 3) — mirrors the
 * role-upgrade-request handshake (see roleUpgradeRequest.service), but moves
 * the studio admin role instead of a project member role.
 *
 * Three operations:
 *   - `requestTransfer`: the current admin asks an existing member to take
 *     over as admin. Drops an actionable `studio.transfer_request`
 *     notification (confirm/cancel) in the recipient's inbox, expiring after
 *     7 days.
 *   - `confirmTransfer`: the recipient accepts. In ONE db.transaction: mark
 *     the request read (the CAS serialization point), then demote the old
 *     admin to maintainer FIRST and promote the recipient to admin SECOND (order
 *     is load-bearing — promoting first would collide with the
 *     `studio_members_one_admin_per_studio` partial unique), then notify the
 *     old admin via `studio.transfer_approved`.
 *   - `cancelTransfer`: the recipient declines. Only marks the request read —
 *     no role change. An unconfirmed request also self-voids once its 7-day
 *     `expires_at` passes (the inbox queries hide expired actionable rows).
 *
 * Authorization model (route layer enforces gates):
 *   - requestTransfer: caller must be the studio admin (`requireStudioRole('admin')`)
 *   - confirm / cancel: caller must own the notification (the markRead userId guard)
 *
 * Atomicity & once-only: confirm runs in a single db transaction — the
 * mark-read CAS (UPDATE … WHERE read_at IS NULL) is the serialization point,
 * so under concurrency only the first confirm flips read_at and swaps roles;
 * the loser's UPDATE matches zero rows and the whole transaction rolls back. A
 * transfer is therefore applied EXACTLY ONCE, and the studio always has
 * exactly one active admin.
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { buildStudioTransferMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db } from "@breatic/core";
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
 * The current admin asks an existing member to take over as the studio admin.
 *
 * Resolves the studio by slug, refuses personal studios, and requires the
 * proposed new admin to be a distinct active non-guest member of the studio. Drops an
 * actionable `studio.transfer_request` notification in their inbox that
 * expires after {@link TRANSFER_TTL_DAYS} days. No role change happens here —
 * the swap is deferred until the recipient confirms.
 * @param slug - The studio's URL handle
 * @param fromAdminUserId - The acting admin initiating the transfer
 * @param toUserId - The member proposed as the new admin
 * @param origin - The request Origin for the best-effort email link; omit to skip the email
 * @throws {NotFoundError} studio not found, or the recipient is not an active member
 * @throws {ForbiddenError} the studio is personal (admin cannot be transferred)
 * @throws {ValidationError} the recipient is the acting admin themselves
 */
export async function requestTransfer(
  slug: string,
  fromAdminUserId: string,
  toUserId: string,
  origin?: string,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  if (toUserId === fromAdminUserId) {
    throw new ValidationError(t("server.error.validation"));
  }
  const role = await studioMembersRepo.getRole(studio.id, toUserId);
  if (!role) throw new NotFoundError(t("server.error.not_found"));
  // Only a non-guest (admin / maintainer) may receive the studio (#1612 / D3):
  // guests are read-only and must not become the admin.
  if (role === "guest") {
    throw new ValidationError(t("server.error.validation"));
  }

  const expiresAt = new Date(
    Date.now() + TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const profiles = await studioRepo.getPersonalProfilesByCreators([
    fromAdminUserId,
  ]);
  const from = profiles.get(fromAdminUserId);
  await notificationService.createStudioTransferRequest({
    userId: toUserId,
    payload: {
      fromUserId: fromAdminUserId,
      fromName: from?.name ?? "",
      fromHandle: from?.slug ?? "",
      studioId: studio.id,
      studioName: studio.name,
      studioSlug: studio.slug,
    },
    expiresAt,
  });

  // Best-effort transfer email — the bell notification above is the always-
  // delivered path; this only fires when an SMTP backend is configured and the
  // caller passed an origin (the route's HTTP Origin). A send failure must NOT
  // fail the request (the request + bell already landed).
  if (origin) {
    await sendBestEffortMail(async () => {
      // Resolve the recipient INSIDE the best-effort boundary — a DB read blip
      // must not fail this request (the transfer-request bell already committed).
      const recipient = await userRepo.getUserById(toUserId);
      if (!recipient) return null;
      return buildStudioTransferMail({
        recipientEmail: recipient.email,
        initiatorName: from?.name ?? "",
        studioName: studio.name,
        studioLink: `${origin}/studio/${slug}`,
      });
    }, { userId: toUserId, subject: "studio_transfer" });
  }
}

/**
 * The recipient confirms a transfer — atomically swaps the admin role to them.
 *
 * In one transaction: (1) mark-read CAS on the request (serialization point),
 * (2) re-read + gate the notification (right type, still within its TTL),
 * (3) demote the old admin to maintainer FIRST, (4) promote the recipient to admin
 * SECOND (order avoids the one-admin partial unique), (5) notify the old admin
 * with `studio.transfer_approved`.
 * @param notificationId - The `studio.transfer_request` notification id
 * @param receiverUserId - The recipient confirming (owns the notification)
 * @throws {NotFoundError} the notification is missing, already decided, not a
 *   transfer request, or a member role-swap finds no active row
 * @throws {ConflictError} the request has already expired (past its 7-day TTL)
 */
export async function confirmTransfer(
  notificationId: string,
  receiverUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialization point: the CAS mark-read flips the request to decided.
    // Under concurrency the row lock makes a losing confirm's UPDATE match
    // zero rows → won=false → abort, rolling back the whole transaction
    // before any role swap. A transfer is applied exactly once.
    const won = await notificationRepo.markRead(
      notificationId,
      receiverUserId,
      tx,
    );
    if (!won) throw new NotFoundError(t("server.error.not_found"));

    const row = await notificationRepo.findById(notificationId, tx);
    if (!row || row.type !== "studio.transfer_request") {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      // Expired requests self-void; confirming one is a no-op conflict.
      throw new ConflictError(t("server.error.conflict"));
    }
    const payload = row.payload as {
      fromUserId?: unknown;
      studioId?: unknown;
      studioName?: unknown;
      studioSlug?: unknown;
    };
    if (
      typeof payload.fromUserId !== "string" ||
      typeof payload.studioId !== "string"
    ) {
      throw new ValidationError(t("server.error.validation"));
    }
    const { fromUserId, studioId } = payload;
    const studioName =
      typeof payload.studioName === "string" ? payload.studioName : "";
    const studioSlug =
      typeof payload.studioSlug === "string" ? payload.studioSlug : "";

    // TOCTOU guard (adversarial review): the request-time non-guest check
    // (#1612 / D3) can go stale within the 7-day TTL — the recipient may have
    // been demoted to guest since the request. Re-verify BEFORE the swap;
    // otherwise updateRole would flip a guest's still-active row straight to
    // admin. Reads committed state; a ConflictError rolls the whole transaction
    // back (including the mark-read).
    const recipientRole = await studioMembersRepo.getRole(
      studioId,
      receiverUserId,
    );
    if (!recipientRole || recipientRole === "guest") {
      throw new ConflictError(t("server.error.conflict"));
    }

    // Demote the old admin FIRST, then promote the new one — the reverse order
    // would collide with studio_members_one_admin_per_studio (two active
    // admins) mid-transaction. The old admin drops ONE rank to maintainer
    // (#1612 / D1 one-rank-down demotion), not all the way to guest.
    const demoted = await studioMembersRepo.updateRole(
      studioId,
      fromUserId,
      "maintainer",
      tx,
    );
    if (!demoted) throw new NotFoundError(t("server.error.not_found"));
    const promoted = await studioMembersRepo.updateRole(
      studioId,
      receiverUserId,
      "admin",
      tx,
    );
    if (!promoted) throw new NotFoundError(t("server.error.not_found"));

    const profiles = await studioRepo.getPersonalProfilesByCreators([
      receiverUserId,
    ]);
    const accepter = profiles.get(receiverUserId);
    await notificationService.createStudioTransferApproved({
      userId: fromUserId,
      payload: {
        studioName,
        studioSlug,
        accepterName: accepter?.name ?? "",
        accepterHandle: accepter?.slug ?? "",
      },
      tx,
    });
  });
}

/**
 * The recipient cancels (declines) a transfer — marks the request read, no
 * role change. Idempotent on a second click: a missing / already-decided
 * request collapses to NotFound.
 * @param notificationId - The `studio.transfer_request` notification id
 * @param receiverUserId - The recipient declining (owns the notification)
 * @throws {NotFoundError} the notification is missing, already decided, or not
 *   owned by `receiverUserId`
 */
export async function cancelTransfer(
  notificationId: string,
  receiverUserId: string,
): Promise<void> {
  const ok = await notificationRepo.markRead(notificationId, receiverUserId);
  if (!ok) throw new NotFoundError(t("server.error.not_found"));
}
