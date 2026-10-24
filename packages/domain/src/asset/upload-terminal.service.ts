// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { assetRepo, db, NotFoundError, projectAssetReferenceService, type DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import * as grants from "@domain/asset/upload-grant.repo.js";
import type { UploadGrant } from "@domain/asset/upload-grant.repo.js";

/** A registration or refusal requesting the one durable terminal. */
export type UploadTerminalIntent = { kind: "completed"; assetId: string } | { kind: "failed"; reason: string } | { kind: "replay" };

/** Only a committed terminal can authorize a corresponding node announcement. */
export type UploadTerminal =
  | { state: "consumed"; grant: UploadGrant; newlyConsumed: boolean }
  | { state: "void"; grant: UploadGrant };

/**
 * Associate a registered upload before exposing it as usable in its Project.
 * @param grant - The server-issued scope and verified file name.
 * @param assetId - The canonical registered asset identity.
 * @param tx - An enclosing business transaction, when supplied.
 * @throws {Error} When a scoped asset is absent or the association cannot commit.
 */
export async function referenceUploadAsset(grant: UploadGrant, assetId: string, tx?: DbTx): Promise<void> {
  if (grant.projectId === null) return;
  await projectAssetReferenceService.recordProjectAssetReferences({
    projectId: grant.projectId,
    assetIds: [assetId],
    ...(grant.filename !== null && { displayNames: { [assetId]: grant.filename } }),
  }, tx);
}

/**
 * Serialize all four report intents on the same immutable grant identity.
 *
 * The transaction contains database operations only. History and activity are
 * accepted before requesting completion; Redis publication follows the returned
 * committed terminal. A retry repairs its Project association using the fixed
 * asset id, independently of the new report's hash or outcome (inner#1707).
 * @param storageKey - The unique server-issued upload key.
 * @param intent - Registration or the actual refusal reason.
 * @returns The committed terminal whose side effects may now be replayed.
 * @throws {NotFoundError} When no grant exists for the key.
 * @throws {Error} When association, locking or terminal commitment fails.
 */
export async function settleUploadTerminal(storageKey: string, intent: UploadTerminalIntent): Promise<UploadTerminal> {
  return db.transaction(async (tx) => {
    const grant = await grants.lockGrantByKey(storageKey, tx);
    if (grant === null) throw new NotFoundError(t("server.error.not_found"));
    if (grant.consumedAt !== null) {
      const existing = grant.assetId === null ? null : await assetRepo.findLiveInStudio(grant.studioId, grant.assetId, tx);
      if (existing !== null) await referenceUploadAsset(grant, existing.id, tx);
      return { state: "consumed", grant, newlyConsumed: false };
    }
    if (grant.voidedAt !== null) return { state: "void", grant };
    if (intent.kind === "replay") throw new Error("Cannot replay an upload grant without a committed terminal");

    if (intent.kind === "completed") {
      await referenceUploadAsset(grant, intent.assetId, tx);
      if (!await grants.consumeGrant({ storageKey, userId: grant.userId, assetId: intent.assetId }, tx)) {
        throw new Error("Locked upload grant did not accept its completion");
      }
    } else if (!await grants.voidGrant(storageKey, intent.reason, tx)) {
      throw new Error("Locked upload grant did not accept its refusal");
    }

    const committed = await grants.findGrantByKey(storageKey, tx);
    if (committed === null) throw new Error("Upload grant missing before terminal commit");
    if (committed.consumedAt !== null) return { state: "consumed", grant: committed, newlyConsumed: true };
    if (committed.voidedAt !== null) return { state: "void", grant: committed };
    throw new Error("Upload grant remained pending after terminal update");
  });
}
