// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking a model for its working, in the way that model takes it.
 *
 * There is no shared spelling for this. Anthropic wants a thinking object;
 * an OpenAI-compatible endpoint wants a reasoning effort. A request that
 * names one of them while calling the other is not ignored politely -- it is
 * addressed to somebody else, so nothing is asked for while the switch that
 * turns it on still reads as though it worked.
 *
 * Which key to use follows from the provider instance being called, and
 * `resolveProvider` is what decides that instance -- it answers with the four
 * names `getModel` branches on, because both read the same thing: a model id
 * plus whether this deployment has that provider's own key. Reading the model
 * id here instead would disagree with it in any deployment missing a key,
 * which is the case this exists to get right.
 *
 * Its answers do not all map to a key of the same name. `openrouter` is
 * `createOpenAI` pointed elsewhere, and `createOpenAI` with no name of its
 * own is called `openai` -- so that one's options live under `openai`
 * whatever the model id says (`@ai-sdk/openai` `index.js:10037` for the
 * default name, `:1642` for how the key is derived).
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
 * @param provider - Who is actually going to be called, as `resolveProvider`
 *   works it out. Not the model id: a model named `anthropic/...` is called
 *   through OpenRouter in any deployment without an Anthropic key, and asking
 *   that one the way Anthropic wants to be asked addresses a provider that is
 *   not there.
 * @param enabled - Whether the config asks for reasoning at all.
 * @returns Options to spread into the model call; empty when it is off.
 */
export function reasoningOptionsFor(provider: string, enabled: boolean): ReasoningOptions {
  if (!enabled) return {};

  if (provider === "anthropic") {
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

  if (provider === "google") {
    // Google takes a budget rather than a level, and asking for the thoughts
    // is separate from allowing them: without `includeThoughts` the model may
    // think and say nothing about it, which is the same empty fold as not
    // asking at all. `-1` is its own word for "decide per question", which is
    // what a boolean switch means here (`@ai-sdk/google@4.0.41`
    // `index.d.ts:19-21`).
    return {
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
      },
    };
  }

  // Which leaves `openai` and `openrouter`, and both take the same key: the
  // OpenRouter provider is `createOpenAI` and answers to `openai`. `high` of
  // the levels DeepSeek offers -- the top one is there for a setting that
  // asks for it by name, and a boolean switch has one level to map onto.
  return { providerOptions: { openai: { reasoningEffort: "high" } } };
}
