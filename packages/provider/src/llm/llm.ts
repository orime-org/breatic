// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProviderConfig } from "@provider/config/schema.js";
import type { LlmApi } from "@provider/llm/api.js";
import type { ProviderOptions } from "@provider/provider.js";

/**
 * The LLM part of a provider instance.
 * @param config - The validated configuration.
 * @param options - The caller's options.
 * @returns The LLM API.
 */
export function createLlm(config: ProviderConfig, options: ProviderOptions): LlmApi {
  void config; void options;
  const missing = (): never => {
    throw new Error("The LLM part is not implemented");
  };
  return { prepare: missing, costOf: missing, understand: missing, judge: missing, capabilities: missing };
}
