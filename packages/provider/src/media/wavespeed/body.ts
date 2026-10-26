// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MediaBinding } from "@provider/config/schema.js";
import type { MediaInput } from "@provider/media/runner.js";

/**
 * The body of a model's own call on WaveSpeed: each of our params under the
 * binding's field, its value spelled the upstream's way, an absent value and
 * an unbound param left out, and the prompt under `prompt_field` when there is one.
 * @param binding - The model's WaveSpeed binding.
 * @param input - Our prepared params and prompt.
 * @returns The body.
 */
export function buildBody(binding: MediaBinding, input: MediaInput): Record<string, unknown> {
  void binding; void input;
  throw new Error("buildBody is not implemented");
}
