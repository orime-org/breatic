// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a caller's uploads ended (inner#1367 §4.2a).
 *
 * Finishing an upload answers 202 and runs as a job; this is where the
 * browser learns what that job did. The grant carries the outcome — the
 * ledger row it registered as, or why it was voided — so an upload with no
 * node, which has no task row, is answered the same way as one with.
 */

import type { UploadStatus } from "@breatic/shared";
import * as assetRepo from "@domain/asset/asset.repo.js";
import { findOwnGrants, type UploadGrant } from "@domain/asset/upload-grant.repo.js";
import { uploadDeadline } from "@domain/asset/upload-deadline.js";
import { failureOutcome } from "@domain/node-task/failure-outcome.js";
import { referenceUploadAsset } from "@domain/asset/upload-terminal.service.js";

/**
 * Where one of the caller's grants stands.
 *
 * Still finishing past its deadline answers expired without writing it: the
 * job's own calls are cut at the same deadline, and it settles the grant when
 * it ends.
 * @param grant - The grant.
 * @returns Its status.
 * @throws {Error} When the current asset or its Project association cannot be read or accepted.
 */
async function statusOfGrant(grant: UploadGrant): Promise<UploadStatus> {
  const key = grant.storageKey;
  if (grant.voidedAt !== null) {
    return { key, state: "failed", reason: grant.failureReason ?? "aborted" };
  }
  if (grant.consumedAt !== null) {
    // A transfer (inner#1006) finishes without a row; it is referenced by key.
    if (grant.assetSource === "transfer") return { key, state: "transferred" };
    const asset = grant.assetId === null ? null : await assetRepo.findLiveInStudio(grant.studioId, grant.assetId);
    // A consumed grant always names its row; one that does not, or names a row
    // since deleted, has nothing to hand over.
    if (asset === null || asset.deletedAt !== null) return { key, state: "unknown" };
    await referenceUploadAsset(grant, asset.id);
    return {
      key,
      state: "completed",
      result: {
        assetId: asset.id,
        fileUrl: asset.fileUrl,
        kind: asset.kind,
        width: asset.width,
        height: asset.height,
      },
    };
  }
  return failureOutcome(await uploadDeadline(grant)) === "expired"
    ? { key, state: "failed", reason: "expired" }
    : { key, state: "finishing" };
}

/**
 * Answer, for each key in order, where the caller's upload under it stands.
 * @param userId - Who is asking; only their own grants are read.
 * @param storageKeys - The keys asked about.
 * @returns One status per key, in the order asked.
 */
export async function statusOf(
  userId: string,
  storageKeys: readonly string[],
): Promise<UploadStatus[]> {
  const grants = new Map(
    (await findOwnGrants(userId, storageKeys)).map((g) => [g.storageKey, g]),
  );
  return Promise.all(
    storageKeys.map((key) => {
      const grant = grants.get(key);
      return grant === undefined
        ? Promise.resolve<UploadStatus>({ key, state: "unknown" })
        : statusOfGrant(grant);
    }),
  );
}
