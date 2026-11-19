// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ValidationError, env, type MiniToolsConfig } from "@breatic/core";
import { t, videoPresentationAtIngest, type VideoPresentationVersion } from "@breatic/shared";
import type { MiniToolSourceBinding } from "@breatic/shared/mini-tools";

/**
 * Require a tool input to be the selected version's (frames-split §7.11 fresh execution and analysis admission): the
 * selected P is complete, its grid, tool source and source keyframe statistics inside it, so no other object has to be
 * ready; a target-policy preparation in progress does not matter.
 * @param ref - The requested tool input.
 * @param ref.toolInputId - Its toolInputId.
 * @param ref.planSha256 - Its plan.
 * @param binding - The registered source.
 * @param sourceKey - Its storage key.
 * @param config - The acceptance snapshot.
 * @returns The selected version.
 * @throws {ValidationError} When the tool input is not the selected one.
 * @throws {Error} When ingest fails.
 */
export async function selectedToolInput(ref: { toolInputId: string; planSha256: string }, binding: MiniToolSourceBinding, sourceKey: string, config: MiniToolsConfig): Promise<VideoPresentationVersion> {
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: "read", storageKey: sourceKey, sourceFingerprint: binding.contentHash, targetPolicyVersion: config.presentation.policy_version,
  });
  const selected = snapshot.presentation;
  if (selected === null || selected.sourceFingerprint !== binding.contentHash || selected.toolInputId !== ref.toolInputId || selected.planSha256 !== ref.planSha256) {
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  return selected;
}

/**
 * Whether a selected version presents with transparency: its playback file is alpha-packed.
 * @param version - The selected version.
 * @returns True for a transparent source.
 * @throws {never} Never.
 */
export function presentsTransparent(version: VideoPresentationVersion): boolean {
  return version.playback.kind === "alpha-packed";
}
