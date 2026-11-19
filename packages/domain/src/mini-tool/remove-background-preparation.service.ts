// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolAnalysisRequest, MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import { AppError } from "@breatic/core";
import { t } from "@breatic/shared";
import { resolveSource } from "@domain/mini-tool/analysis.service.js";
import { estimateModelCredits, getModelCatalog } from "@domain/model-catalog/model-catalog.js";

/** Source truth, pinned provider inputs and the catalog's already multiplied quote for one preparation. */
export interface PreparedVideoRemoveBackground {
  binding: MiniToolSourceBinding;
  sourceKey: string;
  model: string;
  provider: { provider: "wavespeed"; model_id: "bria/fibo/video-background-remover" };
  params: { video: string; background_color: "Transparent"; output_container_and_codec: "webm_vp9"; preserve_audio: true };
  credits: number;
}

/**
 * Prepare one registered video for the internally selected and priced removal model without executing it.
 * @param source - The press-frozen source reference; registered measurements remain authoritative.
 * @param model - The deployment-selected catalog name, not a user-selected provider endpoint.
 * @returns An independent source binding, provider body and catalog quote for subsequent admission.
 * @throws {ValidationError} When the source has no live measured video registration.
 * @throws {AppError} When the pinned model is unavailable or the measured video exceeds its declared duration.
 * @throws {Error} When source lookup or catalog pricing fails.
 */
export async function prepareVideoRemoveBackground(
  source: MiniToolAnalysisRequest["source"],
  model: string,
): Promise<PreparedVideoRemoveBackground> {
  const { binding, sourceKey } = await resolveSource(structuredClone(source));
  const entry = getModelCatalog().video.find((candidate) => candidate.name === model);
  const provider = entry?.providers[0];
  if (!entry?.pricing || entry.providers.length !== 1 || provider?.name !== "wavespeed"
    || provider.model_id !== "bria/fibo/video-background-remover" || !provider.available) {
    throw new AppError(503, t("server.mini_tool.unavailable"));
  }
  const maxSeconds = entry.params.video?.max_total_duration;
  if (maxSeconds !== undefined && binding.mediaInfo.duration > maxSeconds) {
    throw new AppError(400, t("server.mini_tool.sourceTooLong", { minutes: Math.round(maxSeconds / 60) }));
  }
  const params: PreparedVideoRemoveBackground["params"] = {
    video: binding.canonicalURL,
    background_color: "Transparent",
    output_container_and_codec: "webm_vp9",
    preserve_audio: true,
  };
  const selectedProvider: PreparedVideoRemoveBackground["provider"] = {
    provider: provider.name,
    model_id: provider.model_id,
  };
  const quote = await estimateModelCredits(model, {
    params, durations: { video: [binding.mediaInfo.duration] }, sources: ["video"],
  });
  if (quote === undefined) throw new AppError(503, t("server.mini_tool.unavailable"));
  return { binding, sourceKey, model, provider: selectedProvider, params, credits: quote.credits };
}
