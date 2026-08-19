// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Asking a model for its working, in the way that model takes it.
 *
 * There is no shared spelling for this. Anthropic wants a thinking object;
 * an OpenAI-compatible endpoint wants a reasoning effort. A request that
 * names one of them while calling the other is not ignored politely -- it is
 * addressed to somebody else, so nothing is asked for while the switch that
 * turns it on still reads as though it worked.
 *
 * Which key to use follows from the provider instance being called, not from
 * the company serving the model: our OpenRouter provider is `createOpenAI`
 * with no name of its own, and `createOpenAI` without a name is called
 * `openai`. `resolveProvider` answers a different question -- who to record a
 * charge against -- and says "openrouter" for the same model.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 11.
 */

import type { streamText } from "ai";

/**
 * What a model call carries to ask for reasoning, if it asks at all.
 *
 * Taken off the call's own parameter rather than restated: the SDK does not
 * export this type by name, and a hand-written copy of it would be a second
 * answer that goes stale.
 */
type ReasoningOptions = Pick<Parameters<typeof streamText>[0], "providerOptions">;

/**
 * The provider options that ask this model to show its working.
 * @param modelId - The model the turn runs on, as `provider/model`.
 * @param enabled - Whether the config asks for reasoning at all.
 * @returns Options to spread into the model call; empty when it is off.
 */
export function reasoningOptionsFor(modelId: string, enabled: boolean): ReasoningOptions {
  if (!enabled) return {};

  if (modelId.startsWith("anthropic/")) {
    // Both fields carry weight. Anthropic leaves extended thinking off unless
    // asked, so without `type` there is no reasoning to forward at all; and on
    // the adaptive tier the blocks arrive with empty text unless the summary
    // is asked for by name, so without `display` the turn would forward
    // nothing while looking like it works. `adaptive` leaves it to the model
    // whether a given question needs thinking through, which is why this is
    // not a cost paid on every turn.
    return {
      providerOptions: {
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
      },
    };
  }

  // Everything else reaches its provider through the OpenAI-compatible
  // endpoint, whose options live under `openai` whatever the model id says.
  // `high` of the levels DeepSeek offers -- the top one is there for a
  // setting that asks for it by name, and a boolean switch has one level to
  // map onto.
  return { providerOptions: { openai: { reasoningEffort: "high" } } };
}
