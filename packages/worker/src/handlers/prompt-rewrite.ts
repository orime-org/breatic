// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nano Banana 2's prompt, rewritten by an LLM into the structured JSON shape its camera controls travel in
 * (inner#1743). The rewrite is an enhancement: when it fails or answers something that is not JSON, the shape the
 * catalog writes itself (`paramsToSend`) is sent. It runs once, when the run is opened, and is not charged to the
 * user. On the paying account's own OpenRouter key (inner#1953) a failure of that key ends the task instead, so the
 * user learns the key needs their attention.
 */

import { stepCountIs } from "ai";
import { logger } from "@breatic/core";
import { generateTextRetry, provider, type ModelCallEnd } from "@breatic/domain";
import { cameraPrompt, untilDeadline } from "@breatic/shared";
import { accountKeyFailureIn, type KeySet, type PendingCost } from "@breatic/provider";

/** The models whose prompt is rewritten: domain's one list, which the server also reads to record the step's key row. */
export { PROMPT_REWRITTEN_MODELS as REWRITTEN_MODELS } from "@breatic/domain";

/** The language model a prompt is rewritten on. */
export const REWRITE_MODEL = "deepseek/deepseek-chat";

/** What the model is asked to write. */
const ASK = "Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition.";

/** What a rewrite on the paying account's key was billed: the call that finished, and the ones it could not finish. */
export interface RewriteBilled {
  /** The finished call, when the model answered. */
  ended?: ModelCallEnd;
  /** The prepared call's billed answers that never reached a finish (a retried or cut-off answer). */
  pending: () => readonly PendingCost[];
}

/** A rewrite on the paying account's key (inner#1953): the keys it runs on, and where what it was billed goes. */
export interface AccountRewrite {
  keys: KeySet;
  /** Records the rewrite's usage; called once the call is over, before a key failure ends the task. */
  record: (billed: RewriteBilled) => Promise<void>;
}

/**
 * The LLM's rewrite of a description, or the catalog's own shape when it gives none.
 * @param prompt - The user's description.
 * @param params - The run's params, for the camera the user turned on.
 * @param fallback - The prompt the catalog writes itself.
 * @param deadlineAt - When the task runs out; the call is cut there.
 * @param account - The paying account's key and its recorder, when the task's language-model step runs on it; ours
 *   when absent, where a rewrite is never recorded or charged.
 * @returns The prompt to send.
 * @throws {AccountKeyFailure} When the account's key failed or its row is gone; never answered with the catalog's shape.
 */
export async function rewrittenPrompt(
  prompt: string,
  params: Readonly<Record<string, unknown>>,
  fallback: string,
  deadlineAt: number,
  account?: AccountRewrite,
): Promise<{ prompt: string }> {
  const camera = cameraPrompt(params);
  let pending: RewriteBilled["pending"] | undefined;
  let ended: ModelCallEnd | undefined;
  try {
    const prepared = provider().llm.prepare(REWRITE_MODEL, { thinking: false, cache: false, temperature: 0.3 }, undefined, account?.keys);
    pending = prepared.pendingCosts;
    const result = await generateTextRetry({
      model: prepared.model,
      messages: [{ role: "user", content: camera === "" ? `${ASK} Description: "${prompt}"` : `${ASK} Camera info: ${camera}. Description: "${prompt}"` }],
      stopWhen: stepCountIs(1),
      ...prepared.options,
      abortSignal: untilDeadline(deadlineAt).signal,
    });
    ended = { usage: result.usage, providerMetadata: result.providerMetadata };
    const json = result.text.trim().match(/\{[\s\S]*\}/)?.[0];
    if (json !== undefined) {
      try {
        JSON.parse(json);
        return { prompt: json };
      } catch (err) {
        logger.warn({ err }, "nano_banana_prompt_rewrite_failed");
      }
    }
    return { prompt: fallback };
  } catch (err) {
    if (accountKeyFailureIn(err) !== undefined) throw err;
    logger.warn({ err }, "nano_banana_prompt_rewrite_failed");
    return { prompt: fallback };
  } finally {
    if (pending !== undefined) await account?.record({ ...(ended !== undefined && { ended }), pending });
  }
}
