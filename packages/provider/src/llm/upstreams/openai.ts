// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** OpenAI's API, its models' official upstream. */

import { createOpenAI } from "@ai-sdk/openai";
import { aiSdkFetch } from "@provider/http/request.js";
import { asWritten, cachesOnItsOwn, errorOf, type Vendor } from "@provider/llm/upstreams/common.js";

export const openai: Vendor = {
  sdkName: "openai",
  build: (decl, apiKey) => createOpenAI({ baseURL: decl.base_url, apiKey, fetch: aiSdkFetch }),
  vendorId: asWritten,
  gateway: false,
  reasoning: { on: () => ({ reasoningEffort: "high" }), off: { reasoningEffort: "none" } },
  cache: cachesOnItsOwn,
  // Measured 2026-10-27.
  refusal: (status, body) => {
    if (status === 404 && errorOf(body).code === "model_not_found") return "model_not_found";
    return status === 429 && errorOf(body).type === "insufficient_quota" ? "insufficient_balance" : undefined;
  },
};
