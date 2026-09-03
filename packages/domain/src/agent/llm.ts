// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which provider a model call reaches, and how that provider is spoken to.
 *
 * One table answers all of it. Three questions used to be answered in three
 * places -- where the call goes, who the charge is recorded against, and how
 * reasoning is asked for -- and adding a provider meant remembering all
 * three. What that produced: the default model `deepseek/deepseek-v4-pro`
 * matched no direct prefix and fell through to OpenRouter, while the
 * reasoning switch addressed a provider name the OpenRouter instance never
 * answered to, so the switch read as working and asked for nothing.
 *
 * Reasoning is settled here rather than by the caller. Each vendor takes the
 * request its own way -- one wants `thinking: { type }`, another an effort
 * level, a third a token budget -- and a caller that had to know which is
 * which would be a fifth copy of this table. Callers say whether they want
 * the model's working and nothing else.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, streamText } from "ai";
import { env } from "@breatic/core";

/**
 * What a model call carries to ask for reasoning, if it asks at all.
 *
 * Taken off the call's own parameter rather than restated: the SDK does not
 * export this type by name, and a hand-written copy of it would be a second
 * answer that goes stale.
 */
export type ReasoningOptions = Pick<Parameters<typeof streamText>[0], "providerOptions">;

/** What one provider's slot in that object holds. */
type ProviderOptionsFor = NonNullable<ReasoningOptions["providerOptions"]>[string];

/** One provider: how to recognise it, how to reach it, how it is spoken to. */
interface Route {
  /** The model-id prefix that names this provider, absent on the fallback. */
  prefix?: string;
  /** The env var holding its key. */
  keyName: string;
  /** What a credit ledger entry records as the provider. */
  name: string;
  /** Builds the provider, lazily and once. */
  provider: () => (modelId: string) => LanguageModel;
  /** How this provider is told to reason, and how it is told not to. */
  reasoning: { on: ProviderOptionsFor; off: ProviderOptionsFor };
}

// Providers are built LAZILY (on first use), not at module import: each
// reads an API key from the injected config (`env.*`), which is only
// available after the application entry runs `initCore`. This mirrors the
// lazy db / Redis singletons — importing this module has no env dependency,
// so the `@breatic/core` barrel stays importable before initialization.

let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _anthropic: ReturnType<typeof createAnthropic> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;
let _deepseek: ReturnType<typeof createDeepSeek> | null = null;

/**
 * OpenRouter provider — the fallback every unprefixed model reaches.
 * @returns The lazily-built, cached OpenRouter provider instance.
 */
function getOpenrouter(): ReturnType<typeof createOpenRouter> {
  if (_openrouter === null) {
    _openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY || undefined });
  }
  return _openrouter;
}

/**
 * Direct Anthropic provider (for Claude models).
 * @returns The lazily-built, cached Anthropic provider instance.
 */
function getAnthropic(): ReturnType<typeof createAnthropic> {
  if (_anthropic === null) {
    _anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY || undefined });
  }
  return _anthropic;
}

/**
 * Direct Google provider (for Gemini models).
 * @returns The lazily-built, cached Google provider instance.
 */
function getGoogle(): ReturnType<typeof createGoogleGenerativeAI> {
  if (_google === null) {
    _google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY || undefined });
  }
  return _google;
}

/**
 * Direct OpenAI provider.
 * @returns The lazily-built, cached OpenAI provider instance.
 */
function getOpenai(): ReturnType<typeof createOpenAI> {
  if (_openai === null) {
    _openai = createOpenAI({ apiKey: env.OPENAI_API_KEY || undefined });
  }
  return _openai;
}

/**
 * Direct DeepSeek provider.
 * @returns The lazily-built, cached DeepSeek provider instance.
 */
function getDeepseek(): ReturnType<typeof createDeepSeek> {
  if (_deepseek === null) {
    _deepseek = createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY || undefined });
  }
  return _deepseek;
}

/**
 * The direct routes, in the order they are tried.
 *
 * Each `reasoning` pair is written the way that vendor's provider takes it,
 * measured against the published packages rather than inferred: DeepSeek
 * turns thinking on for `deepseek-v4*` and `deepseek-reasoner` by model id
 * unless told otherwise, OpenAI defaults to `medium`, and Anthropic writes
 * no `thinking` field at all when neither side asks. Saying nothing means a
 * different thing to each of them, which is why both directions are stated.
 */
const DIRECT_ROUTES: readonly Route[] = [
  {
    prefix: "anthropic/",
    keyName: "ANTHROPIC_API_KEY",
    name: "anthropic",
    provider: getAnthropic,
    reasoning: {
      on: { thinking: { type: "adaptive", display: "summarized" } },
      off: { thinking: { type: "disabled" } },
    },
  },
  {
    prefix: "google/",
    keyName: "GOOGLE_API_KEY",
    name: "google",
    provider: getGoogle,
    reasoning: {
      // Gemini 3 Pro takes only LOW or HIGH and has no off position, so on
      // that model this is the instruction going out rather than a promise
      // about what comes back. Gemini 2.5 Flash and its like accept 0.
      on: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
      off: { thinkingConfig: { thinkingBudget: 0 } },
    },
  },
  {
    prefix: "openai/",
    keyName: "OPENAI_API_KEY",
    name: "openai",
    provider: getOpenai,
    reasoning: { on: { reasoningEffort: "high" }, off: { reasoningEffort: "none" } },
  },
  {
    prefix: "deepseek/",
    keyName: "DEEPSEEK_API_KEY",
    name: "deepseek",
    provider: getDeepseek,
    reasoning: {
      on: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      off: { thinking: { type: "disabled" } },
    },
  },
] as const;

/** Where everything else goes, and what it is called when it gets there. */
const FALLBACK_ROUTE: Route = {
  keyName: "OPENROUTER_API_KEY",
  name: "openrouter",
  provider: getOpenrouter,
  reasoning: {
    // `max_tokens` or `effort` is required alongside; `enabled` alone does
    // not compile. `none` is the documented way to turn it off.
    on: { reasoning: { effort: "high" } },
    off: { reasoning: { effort: "none" } },
  },
};

/** Every route a model id can land on, fallback last. */
export const ROUTES: readonly Route[] = [...DIRECT_ROUTES, FALLBACK_ROUTE];

/**
 * The route a model id lands on.
 *
 * A direct route needs both its prefix and its key: a deployment that names
 * a model it holds no key for still reaches it through the fallback, which
 * is what makes a single OpenRouter key enough to run everything.
 * @param modelString - Model identifier, `provider/model` or plain.
 * @returns The matching direct route, or the fallback.
 */
function routeFor(modelString: string): Route {
  return (
    DIRECT_ROUTES.find(
      (route) =>
        route.prefix !== undefined &&
        modelString.startsWith(route.prefix) &&
        Boolean((env as unknown as Record<string, string>)[route.keyName]),
    ) ?? FALLBACK_ROUTE
  );
}

/**
 * The model this build calls when a caller names none.
 *
 * Every caller passes one; this is what the signature promises if one ever
 * does not. The default that decides what a turn actually runs on lives in
 * `config/agent.yaml`, and this string is kept in step with it so the two
 * never name different models.
 */
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

/**
 * Get an AI SDK model instance by model string.
 *
 * The return type is `LanguageModel`, the type the SDK itself declares for
 * the `model` option of `generateText` / `streamText` — which is where every
 * caller sends it. It used to say `ReturnType<OpenAIProvider>`, borrowing one
 * branch's type to describe a function that returns a model from several.
 * @param modelString - Model identifier. Defaults to the build's own model.
 * @returns AI SDK LanguageModel instance
 */
export function getModel(modelString?: string): LanguageModel {
  const model = modelString ?? DEFAULT_MODEL;
  const route = routeFor(model);
  const id = route.prefix === undefined ? model : model.slice(route.prefix.length);
  return route.provider()(id);
}

/**
 * Resolve the actual provider name for a model string.
 *
 * Returns the provider that `getModel()` would route to. Used for recording
 * the actual provider in credit transactions.
 * @param modelString - Model identifier. Defaults to the build's own model.
 * @returns The resolved provider name.
 */
export function resolveProvider(modelString?: string): string {
  return routeFor(modelString ?? DEFAULT_MODEL).name;
}

/**
 * What to send so this model's provider does, or does not, show its working.
 *
 * The caller says whether it wants reasoning; which vendor is being called
 * and how that vendor takes the request are settled here. Both directions
 * are stated outright, because leaving the field off means something
 * different to every provider and those defaults are theirs to change.
 * @param modelString - Model identifier. Defaults to the build's own model.
 * @param thinking - Whether this call wants the model's working.
 * @returns Provider options to spread into the model call.
 */
export function reasoningFor(modelString: string | undefined, thinking: boolean): ReasoningOptions {
  const route = routeFor(modelString ?? DEFAULT_MODEL);
  return { providerOptions: { [route.name]: thinking ? route.reasoning.on : route.reasoning.off } };
}
