// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The storage gate: whoever is about to write bytes comes through here first
 * (#89, membership block five).
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
 * IT COMPLETES THE REFUSAL ITSELF rather than reporting a verdict. Callers get
 * an allowance back or an exception — there is no third answer for them to act
 * on, and no way for a caller to learn that storage was short and then carry
 * on. That is what makes the notification honest: this module knows the
 * refusal actually happened, where a function that merely answered questions
 * could only guess.
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

/** What the account has left, once the gate has let a write through. */
export interface StorageAllowance {
  /** The admin's tier's storage ceiling in bytes; `null` on the enterprise tier. */
  limitBytes: number | null;
  /** The admin's account-wide usage, summed across every studio it administers. */
  usedBytes: number;
  /** `limitBytes - usedBytes`; `null` when there is no ceiling to subtract from. */
  remainingBytes: number | null;
}

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
 * @param projectId - The project the bytes are being written into; decides
 *   which studio's pool they land in, and therefore whose account is judged.
 * @param purpose - Upload or generate; only picks the wording of the refusal.
 * @returns What is left, for a caller that wants to show it.
 * @throws {AppError} 507 when the account has no storage left.
 * @throws {NotFoundError} when the project does not exist.
 */
export async function assertStorageAllowance(
  projectId: string,
  purpose: StorageWritePurpose,
): Promise<StorageAllowance> {
  const studioId = await assetService.resolveOwnerStudioId(projectId);
  const { adminUserId, storageBytes } = await getStudioStorageQuota(studioId);
  const usedBytes = await accountStorageUsage(adminUserId);

  // No ceiling to be over: the enterprise tier's capacity is agreed in a
  // contract rather than configured, so the product does not enforce it.
  if (storageBytes === null) {
    return { limitBytes: null, usedBytes, remainingBytes: null };
  }

  const remainingBytes = storageBytes - usedBytes;
  if (remainingBytes <= 0) {
    // Logged on EVERY refusal, unlike the notice below. The bell is for the
    // admin and is deliberately quietened to one per window; this line is for
    // whoever is on call, and silencing it would leave "how often did this
    // gate fire today, and for whom" with no answer after the first hit.
    logger.info(
      { studioId, adminUserId, storageBytes, usedBytes, purpose },
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
  return { limitBytes: storageBytes, usedBytes, remainingBytes };
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
 * exists to prevent.
 * @param adminUserId - The account that is out of storage.
 * @param studioId - Where this particular refusal happened.
 */
async function tellTheAdmin(
  adminUserId: string,
  studioId: string,
): Promise<void> {
  try {
    let firstThisWindow = true;
    try {
      firstThisWindow = await claimNoticeWindow(adminUserId);
    } catch (err) {
      logger.error({ err, adminUserId }, "storage_notice_window_unavailable");
    }
    if (!firstThisWindow) return;

    const studio = await studioRepo.getById(studioId);
    const studioName = studio?.name ?? "";
    await notificationService.createStorageQuotaExceeded({
      userId: adminUserId,
      payload: { studioId, studioName },
    });
    await sendBestEffortMail(async () => {
      const admin = await getUserById(adminUserId);
      if (!admin) return null;
      return buildStorageQuotaExceededMail({
        recipientEmail: admin.email,
        studioName,
      });
    }, { userId: adminUserId, subject: "storage_quota_exceeded" });
  } catch (err) {
    logger.error({ err, adminUserId, studioId }, "storage_notice_failed");
    // The window was claimed before any of this was attempted, and it means
    // "this account has been told". Nothing told them, so give it back —
    // otherwise the next refusal is silenced too and an account that is still
    // full goes a whole window unmentioned.
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
