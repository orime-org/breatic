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
 * go ahead; zero means full (user 2026-08-19: 「剩余的存储容量大于 0，那就
 * 允许当前操作（等于 0 肯定不行了）」).
 *
 * IT COMPLETES THE REFUSAL ITSELF rather than reporting a verdict. Callers get
 * an allowance back or an exception — there is no third answer for them to act
 * on, and no way for a caller to learn that storage was short and then carry
 * on. That is what makes the notification honest: this module knows the
 * refusal actually happened, where a function that merely answered questions
 * could only guess.
 */

import { AppError, getStudioStorageQuota } from "@breatic/core";
import { t } from "@breatic/shared";
import { assetService } from "@breatic/domain";
import { accountStorageUsage } from "@server/modules/asset/assetUsage.service.js";

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
