// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ValidationError, env, getStorageAdapter, type MiniToolsConfig } from "@breatic/core";
import { t, videoPresentationAtIngest, videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor, type VideoPresentationLedgerReceipt } from "@breatic/shared";
import type { MiniToolSourceBinding } from "@breatic/shared/mini-tools";

/**
 * Require a tool input to be the selected version's, with its ledger ready at that toolInputId's own objects (§7.11,
 * fresh execution and analysis admission); a target-policy preparation in progress does not matter.
 * @param ref - The requested tool input.
 * @param ref.toolInputId - Its toolInputId.
 * @param ref.planSha256 - Its plan.
 * @param binding - The registered source.
 * @param sourceKey - Its storage key.
 * @param config - The acceptance snapshot.
 * @returns The selected version and its receipt.
 * @throws {ValidationError} When the tool input is not the selected, ready one.
 * @throws {Error} When ingest fails.
 */
export async function selectedToolInput(ref: { toolInputId: string; planSha256: string }, binding: MiniToolSourceBinding, sourceKey: string, config: MiniToolsConfig): Promise<{ versionId: string; receipt: VideoPresentationLedgerReceipt }> {
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: "read", storageKey: sourceKey, sourceFingerprint: binding.contentHash, targetPolicyVersion: config.presentation.policy_version,
  });
  const selected = snapshot.presentation;
  const receipt = snapshot.ledger?.state === "ready" ? snapshot.ledger.receipt : null;
  const storage = await getStorageAdapter();
  if (selected === null || selected.sourceFingerprint !== binding.contentHash || selected.toolInputId !== ref.toolInputId || selected.planSha256 !== ref.planSha256
    || receipt === null || receipt.sourceFingerprint !== binding.contentHash || receipt.toolInputId !== ref.toolInputId || receipt.planSha256 !== ref.planSha256
    || receipt.url !== storage.publicUrl(videoSourceLedgerKeyFor(sourceKey, ref.toolInputId))
    || receipt.table.url !== storage.publicUrl(videoSourceLedgerTableKeyFor(sourceKey, ref.toolInputId))) throw new ValidationError(t("server.mini_tool.foreignSource"));
  return { versionId: selected.versionId, receipt };
}
