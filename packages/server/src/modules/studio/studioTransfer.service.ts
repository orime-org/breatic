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
 *     the configured decision window.
 *   - `confirmTransfer`: the recipient accepts. In ONE db.transaction: mark
 *     the request read (the CAS serialization point), then demote the old
 *     admin to maintainer FIRST and promote the recipient to admin SECOND (order
 *     is load-bearing — promoting first would collide with the
 *     `studio_members_one_admin_per_studio` partial unique), then notify the
 *     old admin via `studio.transfer_approved`.
 *   - `cancelTransfer`: the recipient declines. Only marks the request read —
 *     no role change. Declining is refused once `expires_at` passes: expiry
 *     closes the request to both answers (the inbox queries also hide expired
 *     actionable rows).
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
import { getDecisionWindowMs } from "@server/config/limits.js";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";

/**
 * The current admin asks an existing member to take over as the studio admin.
 *
 * Resolves the studio by slug, refuses personal studios, and requires the
 * proposed new admin to be a distinct active non-guest member of the studio. Drops an
 * actionable `studio.transfer_request` notification in their inbox that
 * expires after the configured decision window. No role change happens here —
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

  const expiresAt = new Date(Date.now() + getDecisionWindowMs());
  const profiles = await studioRepo.getPersonalProfilesByCreators([
    fromAdminUserId,
  ]);
  const from = profiles.get(fromAdminUserId);
  await notificationService.createStudioTransferRequest({
    userId: toUserId,
    payload: {
      fromUserId: fromAdminUserId,
      fromName: from?.name ?? "",
      studioId: studio.id,
      studioName: studio.name,
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
 * @throws {ConflictError} the request is past its decision window
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

    // TOCTOU guard (adversarial review): the request-time non-guest check
    // (#1612 / D3) can go stale within the decision window — the recipient may have
    // been demoted to guest, or left, since the request. Re-verify BEFORE the
    // swap; otherwise updateRole would flip a guest's still-active row straight
    // to admin.
    //
    // One locked read of the whole membership — the same call the leave / kick
    // path makes, so the two queue on identical rows in identical order rather
    // than deadlocking. See `lockMembership` for why this cannot be narrowed
    // to the two rows we care about.
    const members = await studioMembersRepo.lockMembership(studioId, tx);
    const currentAdminUserId =
      members.find((m) => m.role === "admin")?.userId ?? null;
    const recipientRole =
      members.find((m) => m.userId === receiverUserId)?.role ?? null;

    // Which admin is this transfer actually moving? The request names its
    // initiator in a payload written a whole window ago; if the studio has
    // changed hands since, that request is stale. Confirming one anyway fails
    // in two distinct ways, both observed:
    //   - the studio went to a THIRD party — the promote collides with
    //     studio_members_one_admin_per_studio, surfacing as an unclassified
    //     500 rather than a conflict;
    //   - the studio went to the RECIPIENT already — the promote is a no-op so
    //     nothing collides, but the demote still runs and pushes the stale
    //     initiator to maintainer. If they had been demoted to guest, that is
    //     a silent privilege GRANT off a week-old notification.
    if (currentAdminUserId === null || currentAdminUserId !== fromUserId) {
      throw new ConflictError(t("server.error.conflict"));
    }
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
        studioId,
        accepterName: accepter?.name ?? "",
        accepterUserId: receiverUserId,
      },
      tx,
    });
  });
}

/**
 * The recipient cancels (declines) a transfer — marks the request read, no
 * role change. Idempotent on a second click: a missing / already-decided
 * request collapses to NotFound.
 *
 * Past the decision window a decline fails just as a confirm does: expiry
 * closes the request outright rather than leaving "no" available, so both
 * answers stop at the same instant. The mark-read CAS therefore runs inside
 * the transaction — otherwise a too-late decline would leave the request read
 * but undecided, invisible to its owner and impossible to answer.
 * @param notificationId - The `studio.transfer_request` notification id
 * @param receiverUserId - The recipient declining (owns the notification)
 * @throws {NotFoundError} the notification is missing, already decided, or not
 *   owned by `receiverUserId`
 * @throws {ConflictError} the request is past its decision window
 */
export async function cancelTransfer(
  notificationId: string,
  receiverUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const ok = await notificationRepo.markRead(
      notificationId,
      receiverUserId,
      tx,
    );
    if (!ok) throw new NotFoundError(t("server.error.not_found"));

    const row = await notificationRepo.findById(notificationId, tx);
    if (!row || row.type !== "studio.transfer_request") {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError(t("server.error.conflict"));
    }
  });
}
