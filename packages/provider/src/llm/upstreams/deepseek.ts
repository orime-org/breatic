// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** DeepSeek's API, its models' official upstream. */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { aiSdkFetch } from "@provider/http/request.js";
import { asWritten, cachesOnItsOwn, type Vendor } from "@provider/llm/upstreams/common.js";
import { deepSeekRefusal } from "@provider/llm/upstreams/deepseek.messages.js";

export const deepseek: Vendor = {
  sdkName: "deepseek",
  build: (decl, apiKey) => createDeepSeek({ baseURL: decl.base_url, apiKey, fetch: aiSdkFetch }),
  vendorId: asWritten,
  gateway: false,
  // DeepSeek's deepest level; inner#1650 measured Flash 1017 at it.
  reasoning: { on: () => ({ thinking: { type: "enabled" }, reasoningEffort: "max" }), off: { thinking: { type: "disabled" } } },
  cache: cachesOnItsOwn,
  refusal: deepSeekRefusal,
};
