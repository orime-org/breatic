// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Nano Banana 2's prompt, rewritten by an LLM into the structured JSON shape its camera controls travel in
 * (inner#1743). The rewrite is an enhancement: when it fails or answers something that is not JSON, the shape the
 * catalog writes itself (`paramsToSend`) is sent. It runs once, when the run is opened, and is not charged to the
 * user.
 */

import { stepCountIs } from "ai";
import { logger } from "@breatic/core";
import { generateTextRetry, provider } from "@breatic/domain";
import { cameraPrompt, untilDeadline } from "@breatic/shared";

/** The models whose prompt is rewritten. */
export const REWRITTEN_MODELS: ReadonlySet<string> = new Set(["nano-banana-2"]);

/** What the model is asked to write. */
const ASK = "Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition.";

/**
 * The LLM's rewrite of a description, or the catalog's own shape when it gives none.
 * @param prompt - The user's description.
 * @param params - The run's params, for the camera the user turned on.
 * @param fallback - The prompt the catalog writes itself.
 * @param deadlineAt - When the task runs out; the call is cut there.
 * @returns The prompt to send.
 */
export async function rewrittenPrompt(
  prompt: string,
  params: Readonly<Record<string, unknown>>,
  fallback: string,
  deadlineAt: number,
): Promise<string> {
  const camera = cameraPrompt(params);
  try {
    const prepared = provider().llm.prepare("deepseek/deepseek-chat", { thinking: false, cache: false, temperature: 0.3 });
    const result = await generateTextRetry({
      model: prepared.model,
      messages: [{ role: "user", content: camera === "" ? `${ASK} Description: "${prompt}"` : `${ASK} Camera info: ${camera}. Description: "${prompt}"` }],
      stopWhen: stepCountIs(1),
      ...prepared.options,
      abortSignal: untilDeadline(deadlineAt).signal,
    });
    const json = result.text.trim().match(/\{[\s\S]*\}/)?.[0];
    if (json === undefined) return fallback;
    JSON.parse(json);
    return json;
  } catch (err) {
    logger.warn({ err }, "nano_banana_prompt_rewrite_failed");
    return fallback;
  }
}
