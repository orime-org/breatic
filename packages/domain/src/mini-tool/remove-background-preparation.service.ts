// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolAnalysisRequest, MiniToolSourceBinding } from "@breatic/shared/mini-tools";

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
 * @throws {Error} When source resolution, served model selection or catalog pricing fails.
 */
export async function prepareVideoRemoveBackground(
  source: MiniToolAnalysisRequest["source"],
  model: string,
): Promise<PreparedVideoRemoveBackground> {
  void source; void model;
  throw new Error("Video background removal preparation is not implemented");
}
