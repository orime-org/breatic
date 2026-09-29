// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Central LLM call wrapper (#1625 Slice 3, resilience).
 *
 * Every LLM call in the codebase routes through here so the retry budget
 * (`maxRetries`) is set from `config/agent.yaml` in ONE place, instead of each
 * call site silently inheriting the AI SDK default (2). The AI SDK's built-in
 * retry is exponential-backoff-only (no jitter injection point), so this layer
 * governs the retry COUNT, not the backoff shape. A call site may still pass an
 * explicit `maxRetries` to override the config default.
 *
 * Being the one way in is also why every prompt is cleaned here: the model is
 * wrapped so each step's prompt loses its Unicode tag characters before it is
 * sent, except in what the model wrote itself -- its reasoning, text and tool
 * calls go back unchanged (`strip-unicode-tags.ts`).
 */

import { generateText, streamText, wrapLanguageModel, type LanguageModel } from "ai";
import { getAgentConfig } from "@breatic/core";

import { unicodeTagMiddleware } from "@domain/agent/strip-unicode-tags.js";

/**
 * The model, wrapped so every prompt it is sent is cleaned first.
 * @param model - The model a call site built.
 * @returns The same model behind the cleaning middleware.
 * @throws {TypeError} when the model is named by id: the SDK resolves an id
 *   through its global provider, which has no place for the middleware.
 */
function cleaned(model: LanguageModel): Exclude<LanguageModel, string> {
  if (typeof model === "string") {
    throw new TypeError(`A model named by id ("${model}") cannot be cleaned; pass getModel()'s model`);
  }
  return wrapLanguageModel({ model, middleware: unicodeTagMiddleware });
}

/**
 * `generateText` with the configured retry budget injected.
 * @param opts - The same options as the AI SDK `generateText`. An explicit
 *   `maxRetries` overrides the `agent.yaml` default.
 * @returns The AI SDK `generateText` result promise.
 * @throws {TypeError} when `opts.model` is a model id rather than a model.
 */
export function generateTextRetry(
  opts: Parameters<typeof generateText>[0],
): ReturnType<typeof generateText> {
  return generateText({
    maxRetries: getAgentConfig().llm_max_retries,
    ...opts,
    model: cleaned(opts.model),
  });
}

/**
 * `streamText` with the configured retry budget injected. Returns the stream
 * result object unchanged (streaming semantics preserved).
 * @param opts - The same options as the AI SDK `streamText`. An explicit
 *   `maxRetries` overrides the `agent.yaml` default.
 * @returns The AI SDK `streamText` result.
 * @throws {TypeError} when `opts.model` is a model id rather than a model.
 */
export function streamTextRetry(
  opts: Parameters<typeof streamText>[0],
): ReturnType<typeof streamText> {
  return streamText({
    maxRetries: getAgentConfig().llm_max_retries,
    ...opts,
    model: cleaned(opts.model),
  });
}
