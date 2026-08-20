// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The storage gate (#89, membership block five). Whoever calls it is asking
 * permission to write bytes, and is either allowed to continue or thrown out
 * of with a 507.
 *
 * It gates the two paths #89 covers — the upload handshake and canvas task
 * creation. Other paths that end in stored bytes (the mini-tool endpoints,
 * `POST /canvas/understand`) deliberately do not call it this round; the
 * contract is that whoever writes comes through here, not that everyone
 * already does.
 *
 * ONE PRE-CHECK, BEFORE THE ACTION, AND NEVER AGAIN. Nothing is frozen and
 * nothing is reserved, so storage CAN end up over the ceiling — an accepted
 * outcome (user 2026-08-19), the same shape as the credit pre-check next to it
 * on the generation path. Reserving would need a hold / settle / expire
 * lifecycle for a marginal gain, and re-checking after the work has started
 * would only mean throwing away work already paid for.
 *
 * THE JUDGEMENT IS ABOUT THE STUDIO'S ADMIN, NOT THE OPERATOR. Bytes land in
 * the studio that owns the project, and a studio's ceilings are its current
 * admin's. So a team's editor is measured against the admin's account — never
 * against their own personal studio, however full that is.
 *
 * IT DOES NOT LOOK AT HOW BIG THIS WRITE IS. More than zero bytes left means
 * go ahead; zero left means full, and is already refused (user 2026-08-19).
 *
 * IT COMPLETES THE REFUSAL ITSELF rather than reporting a verdict. A caller
 * either continues or is thrown out of — there is no third answer for it to
 * act on, and no way for it to learn that storage was short and then carry on.
 * That is what makes the notification honest: this module knows the refusal
 * actually happened, where a function that merely answered questions could
 * only guess.
 */

import { AppError, getStudioStorageQuota, logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { assetService } from "@breatic/domain";
import { accountStorageUsage } from "@server/modules/asset/assetUsage.service.js";
import {
  claimNoticeWindow,
  releaseNoticeWindow,
} from "@server/modules/asset/storage-notice-throttle.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { getUserById } from "@server/modules/auth/user.repo.js";
import { buildStorageQuotaExceededMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";

/** Which write is being attempted — only decides which sentence the user reads. */
export type StorageWritePurpose = "upload" | "generate";

/** HTTP 507 Insufficient Storage (RFC 4918 §11.5). */
const INSUFFICIENT_STORAGE = 507;

/**
 * Let a write proceed, or refuse it because the owning account's storage is
 * full.
 *
 * 507 rather than 409 or 413: 409 already means "that node is busy" to the
 * frontend's status-code switch, and 413 already means "this one file is too
 * big". 507 is the status the storage-quota case has (RFC 4918, and cloud
 * storage APIs use it for exactly this).
 * Answers nothing. Asking how much room is left is a different question with
 * a different audience — it belongs to the read side of the Studio and Project
 * property pages (#120), which will have no reason to refuse anything or to
 * mail anybody. Handing a caller numbers it does not need would only invite
 * one to make its own judgement beside this one.
 * @param projectId - The project the bytes are being written into; decides
 *   which studio's pool they land in, and therefore whose account is judged.
 * @param purpose - Upload or generate; only picks the wording of the refusal.
 * @throws {AppError} 507 when the account has no storage left.
 * @throws {NotFoundError} when the project does not exist.
 */
export async function assertStorageAllowance(
  projectId: string,
  purpose: StorageWritePurpose,
): Promise<void> {
  const studioId = await assetService.resolveOwnerStudioId(projectId);
  const { adminUserId, storageBytes } = await getStudioStorageQuota(studioId);

  // No ceiling to be over: the enterprise tier's capacity is agreed in a
  // contract rather than configured, so the product does not enforce it.
  // Returning here also spares the account-wide sum below, which nothing on
  // this path would then look at.
  if (storageBytes === null) return;

  const usedBytes = await accountStorageUsage(adminUserId);
  if (storageBytes - usedBytes <= 0) {
    // Logged on EVERY refusal, unlike the notice below. The bell is for the
    // admin and is deliberately quietened to one per window; this line is for
    // whoever is on call, and silencing it would leave "how often did this
    // gate fire today, and for whom" with no answer after the first hit.
    logger.info(
      { projectId, studioId, adminUserId, storageBytes, usedBytes, purpose },
      "storage_quota_exceeded",
    );
    await tellTheAdmin(adminUserId, studioId);
    throw new AppError(
      INSUFFICIENT_STORAGE,
      t(
        purpose === "upload"
          ? "server.storage.quota_exceeded_upload"
          : "server.storage.quota_exceeded_generate",
      ),
    );
  }
}

/**
 * Put a storage-full notice in the admin's bell and mail box. Never throws.
 *
 * The refusal is the promise; the notice is what makes it actionable, since
 * whoever was refused can neither raise the membership nor delete assets. So
 * nothing in here may turn a 507 into a 500 — every leg has its own way of
 * failing (Redis unreachable, the insert rejected, the mail backend down) and
 * all three end the same way: log it, and let the refusal stand.
 *
 * A lost Redis claim sends the notice rather than skipping it. A duplicate
 * bell row is a nuisance; silence about a full account is the thing the notice
 * exists to prevent. It does NOT then give a window back on the way out — this
 * request never took one, and deleting the key would throw away a window some
 * other request legitimately holds.
 * @param adminUserId - The account that is out of storage.
 * @param studioId - Where this particular refusal happened.
 */
async function tellTheAdmin(
  adminUserId: string,
  studioId: string,
): Promise<void> {
  // Two different states, and only one of them may be given back later:
  // `held` means this request is the one holding the window.
  let held = false;
  try {
    try {
      held = await claimNoticeWindow(adminUserId);
      if (!held) return;
    } catch (err) {
      logger.error({ err, adminUserId }, "storage_notice_window_unavailable");
    }

    await notificationService.createStorageQuotaExceeded({
      userId: adminUserId,
      payload: { studioId },
    });
    // Everything the mail needs is read INSIDE the best-effort boundary, the
    // same way the transfer and invite paths do it. Reading it out here would
    // put a database call between the bell insert and the catch below, and
    // that catch gives the window back on the grounds that nobody was told —
    // which stops being true the moment the insert succeeds.
    await sendBestEffortMail(async () => {
      const [admin, studio] = await Promise.all([
        getUserById(adminUserId),
        studioRepo.getById(studioId),
      ]);
      if (!admin || !studio) return null;
      return buildStorageQuotaExceededMail({
        recipientEmail: admin.email,
        studioName: studio.name,
      });
    }, { userId: adminUserId, subject: "storage_quota_exceeded" });
  } catch (err) {
    logger.error({ err, adminUserId, studioId }, "storage_notice_failed");
    // The window means "this account has been told". Nothing told them, so
    // give it back — otherwise the next refusal is silenced too and an account
    // that is still full goes a whole window unmentioned. Only if this request
    // is the one holding it: when the claim itself failed, the key here (if
    // any) belongs to somebody else.
    if (!held) return;
    try {
      await releaseNoticeWindow(adminUserId);
    } catch (releaseErr) {
      logger.error(
        { err: releaseErr, adminUserId },
        "storage_notice_window_release_failed",
      );
    }
  }
}
