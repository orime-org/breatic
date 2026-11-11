// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Anthropic's API, Claude's official upstream. */

import { createAnthropic } from "@ai-sdk/anthropic";
import { aiSdkFetch } from "@provider/http/request.js";
import { anthropicRefusal } from "@provider/llm/upstreams/anthropic.messages.js";
import { cacheControl, type Vendor } from "@provider/llm/upstreams/common.js";

/** Anthropic's error types and the statuses its error docs give them (https://platform.claude.com/docs/en/api/errors). */
const ANTHROPIC_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

export const anthropic: Vendor = {
  sdkName: "anthropic",
  inBandStatus: (error) => {
    const type = (error as { type?: unknown } | null)?.type;
    return typeof type === "string" && Object.hasOwn(ANTHROPIC_STATUS, type) ? ANTHROPIC_STATUS[type] : undefined;
  },
  build: (decl, apiKey) => createAnthropic({ baseURL: decl.base_url, apiKey, fetch: aiSdkFetch }),
  // Ids are written the way OpenRouter names Claude (`claude-opus-5.5`); Anthropic serves `claude-opus-5-5`.
  vendorId: (modelId) => modelId.replace(/(\d)\.(\d)/g, "$1-$2"),
  gateway: false,
  reasoning: { on: () => ({ thinking: { type: "adaptive", display: "summarized" }, effort: "high" }), off: {} },
  cache: (_modelId, ttl) => cacheControl(ttl),
  refusal: anthropicRefusal,
};
