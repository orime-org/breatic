// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** OpenRouter's Anthropic-compatible Messages endpoint, and its refusal forms, which its chat endpoint shares. */

import { messageOf, messagesTokens, type MessagesSpeaker, type Refusal } from "@provider/llm/upstreams/common.js";

/**
 * What OpenRouter's refusal means beyond its status.
 * @param status - The status.
 * @param body - The parsed body.
 * @returns The refusal, or undefined.
 */
export function openRouterRefusal(status: number, body: unknown): Refusal | undefined {
  // The missing model measured 2026-10-26; 402 from OpenRouter's error docs.
  if (status === 400 && messageOf(body).endsWith(" is not a valid model ID")) return "model_not_found";
  return status === 402 ? "insufficient_balance" : undefined;
}

export const openRouterMessages: MessagesSpeaker = {
  url: (baseUrl) => `${baseUrl}/messages`,
  auth: (key) => ({ authorization: `Bearer ${key}` }),
  rewrite(body) {
    // DeepSeek's thinking without a budget, which OpenRouter takes as adaptive.
    const thinking = body["thinking"];
    if (typeof thinking === "object" && thinking !== null && (thinking as Record<string, unknown>)["type"] === "enabled" && (thinking as Record<string, unknown>)["budget_tokens"] === undefined) {
      body["thinking"] = { type: "adaptive" };
    }
  },
  refusal: openRouterRefusal,
  cost(call) {
    const reported = call.usage?.["cost"];
    if (call.usage !== undefined && typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
      const { written: _written, ...tokens } = messagesTokens(call.usage);
      return { state: "known", usd: reported, source: "reported", tokens };
    }
    // Its message id is the generation its cost is looked up by.
    if (call.messageId?.startsWith("gen-") === true) return { state: "pending", lookup: { upstream: call.upstream, generationId: call.messageId } };
    return { state: "missing", reason: `${call.upstream} reported no cost and no generation for the call` };
  },
};
