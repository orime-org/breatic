// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** OpenRouter's Anthropic-compatible Messages endpoint, and its refusal forms, which its chat endpoint shares. */

import { errorOf, messageOf, messagesTokens, type MessagesSpeaker, type Refusal } from "@provider/llm/upstreams/common.js";

/**
 * What OpenRouter's refusal means beyond its status.
 * @param status - The status.
 * @param body - The parsed body.
 * @returns The refusal, or undefined.
 */
export function openRouterRefusal(status: number, body: unknown): Refusal | undefined {
  // The missing model measured 2026-10-26; 402 and the 403 of a spent key, workspace or guardrail budget, which names
  // its `metadata.limit_source`, from OpenRouter's error docs.
  if (status === 400 && messageOf(body).endsWith(" is not a valid model ID")) return "model_not_found";
  if (status === 403) return typeof limitSourceOf(body) === "string" ? "insufficient_balance" : undefined;
  return status === 402 ? "insufficient_balance" : undefined;
}

/**
 * The `error.metadata.limit_source` of a parsed OpenRouter error body.
 * @param body - The parsed body.
 * @returns The limit source, when the body names one.
 */
function limitSourceOf(body: unknown): unknown {
  const metadata = errorOf(body).metadata;
  return typeof metadata === "object" && metadata !== null ? (metadata as { limit_source?: unknown }).limit_source : undefined;
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
