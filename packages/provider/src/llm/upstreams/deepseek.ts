// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** DeepSeek's API, its models' official upstream. */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { aiSdkFetch } from "@provider/http/request.js";
import { asWritten, cachesOnItsOwn, messageOf, type Vendor } from "@provider/llm/upstreams/common.js";

export const deepseek: Vendor = {
  sdkName: "deepseek",
  build: (decl, apiKey) => createDeepSeek({ baseURL: decl.base_url, apiKey, fetch: aiSdkFetch }),
  vendorId: asWritten,
  gateway: false,
  // DeepSeek's deepest level; inner#1650 measured Flash 1017 at it.
  reasoning: { on: () => ({ thinking: { type: "enabled" }, reasoningEffort: "max" }), off: { thinking: { type: "disabled" } } },
  cache: cachesOnItsOwn,
  // The missing model measured 2026-10-27; 402 from DeepSeek's error code page.
  refusal: (status, body) => {
    if (status === 400 && messageOf(body).startsWith("The supported API model names are")) return "model_not_found";
    return status === 402 ? "insufficient_balance" : undefined;
  },
};
