// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Google's Gemini API, Gemini's official upstream. */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { aiSdkFetch } from "@provider/http/request.js";
import { asWritten, cachesOnItsOwn, errorOf, type Vendor } from "@provider/llm/upstreams/common.js";

export const google: Vendor = {
  sdkName: "google",
  build: (decl, apiKey) => createGoogleGenerativeAI({ baseURL: decl.base_url, apiKey, fetch: aiSdkFetch }),
  vendorId: asWritten,
  gateway: false,
  reasoning: {
    on: () => ({ thinkingConfig: { thinkingBudget: -1, includeThoughts: true } }),
    off: { thinkingConfig: { thinkingBudget: 0 } },
    // Gemini 3 takes a named level in place of a budget (Google's Gemini 3.8 migration guide: replace
    // thinking_budget with thinking_level); sending both is an error.
    at: (level) => ({ thinkingConfig: { thinkingLevel: level, includeThoughts: true } }),
  },
  cache: cachesOnItsOwn,
  // Measured 2026-10-27; the free tier never answered with a balance refusal.
  refusal: (status, body) => (status === 404 && errorOf(body).status === "NOT_FOUND" ? "model_not_found" : undefined),
};
