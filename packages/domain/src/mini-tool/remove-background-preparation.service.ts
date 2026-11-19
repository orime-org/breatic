// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolAnalysisRequest, MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import { AppError } from "@breatic/core";
import { t } from "@breatic/shared";
import { resolveSource } from "@domain/mini-tool/analysis.service.js";
import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";

/** Source truth and the removal model's params, in our names, for one preparation; its call is admitted and priced with the plan. */
export interface PreparedVideoRemoveBackground {
  binding: MiniToolSourceBinding;
  sourceKey: string;
  model: string;
  params: { video: string; background_color: "Transparent"; output_container_and_codec: "webm_vp9"; preserve_audio: true };
}

/**
 * Prepare one registered video for the internally selected and priced removal model without executing it.
 * @param source - The press-frozen source reference; registered measurements remain authoritative.
 * @param model - The deployment-selected catalog name, not a user-selected provider endpoint.
 * @returns An independent source binding and the model's params for subsequent admission.
 * @throws {ValidationError} When the source has no live measured video registration.
 * @throws {AppError} When the pinned model is not in the catalog.
 * @throws {Error} When source lookup fails.
 */
export async function prepareVideoRemoveBackground(
  source: MiniToolAnalysisRequest["source"],
  model: string,
): Promise<PreparedVideoRemoveBackground> {
  const { binding, sourceKey } = await resolveSource(structuredClone(source));
  // Whether this deployment serves the model, the vendor's length limit and the price are decided where the plan's call
  // is admitted (model-call-admission.ts, inner#1306 §11.5).
  if (getModelCatalog().video.find((candidate) => candidate.name === model) === undefined) throw new AppError(503, t("server.mini_tool.unavailable"));
  const params: PreparedVideoRemoveBackground["params"] = {
    video: binding.canonicalURL,
    background_color: "Transparent",
    output_container_and_codec: "webm_vp9",
    preserve_audio: true,
  };
  return { binding, sourceKey, model, params };
}
