// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Central LLM call wrapper (#1625 Slice 3, resilience).
 *
 * Every LLM call in the codebase routes through here so the retry budget
 * (`maxRetries`) is set from `config/agent.yaml` in ONE place, instead of each
 * call site silently inheriting the AI SDK default (2). The AI SDK's built-in
 * retry is exponential-backoff-only (no jitter injection point), so this layer
 * governs the retry COUNT, not the backoff shape. A call site may still pass an
 * explicit `maxRetries` to override the config default.
 */

import { generateText, streamText } from "ai";
import { getAgentConfig } from "@breatic/core";

/**
 * `generateText` with the configured retry budget injected.
 * @param opts - The same options as the AI SDK `generateText`. An explicit
 *   `maxRetries` overrides the `agent.yaml` default.
 * @returns The AI SDK `generateText` result promise.
 */
export function generateTextRetry(
  opts: Parameters<typeof generateText>[0],
): ReturnType<typeof generateText> {
  return generateText({ maxRetries: getAgentConfig().llm_max_retries, ...opts });
}

/**
 * `streamText` with the configured retry budget injected. Returns the stream
 * result object unchanged (streaming semantics preserved).
 * @param opts - The same options as the AI SDK `streamText`. An explicit
 *   `maxRetries` overrides the `agent.yaml` default.
 * @returns The AI SDK `streamText` result.
 */
export function streamTextRetry(
  opts: Parameters<typeof streamText>[0],
): ReturnType<typeof streamText> {
  return streamText({ maxRetries: getAgentConfig().llm_max_retries, ...opts });
}
