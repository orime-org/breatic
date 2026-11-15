// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * DeepSeek's Anthropic-compatible endpoint (https://api-docs.deepseek.com/guides/anthropic_api: base
 * `https://api.deepseek.com/anthropic`, under which an Anthropic client sends `/v1/messages`), and its refusal forms,
 * which its chat endpoint shares.
 */

import { messageOf, priceTableMessagesCost, type MessagesSpeaker, type Refusal } from "@provider/llm/upstreams/common.js";

/**
 * What DeepSeek's refusal means beyond its status.
 * @param status - The status.
 * @param body - The parsed body.
 * @returns The refusal, or undefined.
 */
export function deepSeekRefusal(status: number, body: unknown): Refusal | undefined {
  // The missing model measured 2026-10-27; 402 from DeepSeek's error code page.
  if (status === 400 && messageOf(body).startsWith("The supported API model names are")) return "model_not_found";
  return status === 402 ? "insufficient_balance" : undefined;
}

export const deepSeekMessages: MessagesSpeaker = {
  url: (baseUrl) => `${baseUrl}/anthropic/v1/messages`,
  auth: (key) => ({ "x-api-key": key }),
  refusal: deepSeekRefusal,
  cost: priceTableMessagesCost,
};
