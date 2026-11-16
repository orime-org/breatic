// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Anthropic's Messages endpoint, and its refusal forms, which its SDK path shares. */

import { errorOf, messageOf, priceTableMessagesCost, type MessagesSpeaker, type Refusal } from "@provider/llm/upstreams/common.js";

/**
 * What Anthropic's refusal means beyond its status.
 * @param status - The status.
 * @param body - The parsed body.
 * @returns The refusal, or undefined.
 */
export function anthropicRefusal(status: number, body: unknown): Refusal | undefined {
  // Measured 2026-10-27 for the balance; the missing model from Anthropic's error docs.
  if (status === 404 && errorOf(body).type === "not_found_error") return "model_not_found";
  return status === 400 && messageOf(body).includes("credit balance is too low") ? "insufficient_balance" : undefined;
}

export const anthropicMessages: MessagesSpeaker = {
  url: (baseUrl) => `${baseUrl}/messages`,
  auth: (key) => ({ "x-api-key": key }),
  refusal: anthropicRefusal,
  cost: priceTableMessagesCost,
};
