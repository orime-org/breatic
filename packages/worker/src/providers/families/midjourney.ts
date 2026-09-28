// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Midjourney's style reference: the canvas slot writes `style_images` as a
 * list (capped at one in the catalog), and the endpoint takes one url as
 * `sref`. No prompt scaffold — `sref` is a typed style slot.
 */

import type { ModelFamily } from "@worker/providers/shared.js";

const midjourney: ModelFamily = {
  MODELS: new Set(["midjourney"]),
  CONSUMES: new Set(["style_images"]),
  /**
   * Send the first style image as `sref`.
   * @param prompt - The reader's prompt.
   * @param params - The validated run params.
   * @returns The prompt unchanged and `sref` when a style image was given.
   */
  prepare: async (
    prompt: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ prompt: string; fields: Record<string, unknown> }> => {
    const style = params.style_images;
    const first = Array.isArray(style) ? style[0] : undefined;
    return { prompt, fields: typeof first === "string" && first !== "" ? { sref: first } : {} };
  },
};

export default midjourney;
