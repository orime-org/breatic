// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Mureka V9.5 Song (breatic#1393): compose_from is ours alone. It picks
 * whether a run uses the style, song and vocals or the melody (each slot's
 * `when` in the catalog), and no upstream has a field for it.
 */

import type { ModelFamily } from "@worker/providers/shared.js";

const murekaSong: ModelFamily = {
  MODELS: new Set(["mureka-v9.5-generate-song"]),
  CONSUMES: new Set(["compose_from"]),
  PREPARE_IS_PAID: false,
  /**
   * Leave the prompt as it is; the setting has done its work in resolving the params.
   * @param prompt - The style prompt.
   * @returns The prompt unchanged and no fields.
   */
  prepare: async (prompt: string): Promise<{ prompt: string; fields: Record<string, unknown> }> =>
    Promise.resolve({ prompt, fields: {} }),
};

export default murekaSong;
