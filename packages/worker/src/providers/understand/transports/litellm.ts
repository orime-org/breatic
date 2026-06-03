// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * LLM transport for multimodal understanding (vi/vv/va).
 *
 * Uses Vercel AI SDK `generateText()` to call an LLM with multimodal
 * messages built by the model family. Returns `{ text, cost }`.
 */

import { generateText, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import type { ResolvedModel } from "@worker/providers/shared.js";
import type { AnyUnderstandFamily } from "@worker/providers/understand/models/types.js";
import { isLlmFamily } from "@worker/providers/understand/models/types.js";
import { getModel } from "@breatic/domain";

/**
 * Run multimodal analysis via LLM using AI SDK.
 * @param resolved - Resolved model with litellmModel string and API key
 * @param family - Model family module with `buildMessages()`
 * @param prompt - Analysis instruction text
 * @param params - Additional parameters (images, video_url, audio_url, max_tokens)
 * @returns Object with `text` and `cost`
 */
export async function generate(
  resolved: ResolvedModel,
  family: AnyUnderstandFamily,
  prompt: string,
  params: Record<string, unknown>,
): Promise<{ text: string; cost: number }> {
  if (!isLlmFamily(family)) {
    throw new Error(
      `LLM transport requires a model family with buildMessages(), ` +
      `but got a family without it for model '${resolved.modelName}'`,
    );
  }

  const [messages, maxTokens] = await family.buildMessages(
    prompt,
    resolved.modelName,
    params,
  );

  // Use the litellmModel string if available (e.g. "google/gemini-2.0-flash")
  // otherwise fall back to the model name
  const modelString = resolved.litellmModel ?? resolved.modelName;
  const model = getModel(modelString);

  const result = await generateText({
    model,
    messages: messages as ModelMessage[],
    maxOutputTokens: maxTokens,
    temperature: 0.3,
    stopWhen: stepCountIs(1),
  });

  // Extract cost from usage metadata
  const usage = result.usage;
  const totalTokens = (usage?.totalTokens ?? 0);
  const cost = resolved.tokenPrice
    ? totalTokens * resolved.tokenPrice
    : resolved.costPerCall;

  return {
    text: result.text || "",
    cost,
  };
}
