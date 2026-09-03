// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which provider a model call reaches, and how that provider is spoken to.
 *
 * One table answers all of it. Three questions used to be answered in three
 * places -- where the call goes, who the charge is recorded against, and how
 * reasoning is asked for -- and adding a provider meant remembering all
 * three.
 *
 * What that produced: OpenRouter was reached through `createOpenAI` pointed
 * at its address, and `@ai-sdk/openai` decides from the model id whether a
 * model reasons at all. The default `deepseek/deepseek-v4-pro` is not an id
 * it knows, so the reasoning option was dropped with a warning and never
 * reached the request. The switch read as working and asked for nothing.
 * The same borrowed adapter is why the cost OpenRouter reports was
 * unreachable: it moves the fields it knows, and `cost` is not one of them.
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
import type { CoreConfig } from "@breatic/core";

/**
 * What a model call carries to ask for reasoning, if it asks at all.
 *
 * Taken off the call's own parameter rather than restated: the SDK does not
 * export this type by name, and a hand-written copy of it would be a second
 * answer that goes stale.
 */
type ReasoningOptions = Pick<Parameters<typeof streamText>[0], "providerOptions">;

/** What one provider's slot in that object holds. */
type ProviderOptionsFor = NonNullable<ReasoningOptions["providerOptions"]>[string];

/**
 * The name of an env var this deployment can hold a provider key in.
 *
 * Narrowed to the schema's own key names so a name it does not carry is a
 * compile error naming the correct spelling. A plain `string` here would let
 * a typo through to runtime, where it reads as undefined: the route silently
 * never opens, every call for that vendor goes to OpenRouter instead, and
 * the charge is recorded against OpenRouter too. This repo has made exactly
 * that typo before -- see the `KLING_ACCESS_KEY` note in `skill-availability`.
 */
type ProviderKeyName = Extract<keyof CoreConfig, `${string}_API_KEY`>;

/** One provider: how to reach it, and how it is spoken to. */
interface Route {
  /** The env var holding its key. */
  keyName: ProviderKeyName;
  /**
   * The provider, named twice over.
   *
   * A credit ledger entry records it, and the SDK looks up this call's
   * `providerOptions` under it -- so a name the vendor's package does not
   * answer to is not a mislabelled row, it is reasoning silently not asked
   * for. The wire-level cases in the tests are what hold this down.
   */
  name: string;
  /** The provider, built on first use and kept. */
  provider: () => (modelId: string) => LanguageModel;
  /** How this provider is told to reason, and how it is told not to. */
  reasoning: { on: ProviderOptionsFor; off: ProviderOptionsFor };
}

/** A route a model id reaches by carrying its prefix. */
interface DirectRoute extends Route {
  /** The model-id prefix that names this provider. */
  prefix: string;
}

/**
 * Builds the value on first call and hands back the same one after.
 *
 * Providers are built lazily rather than at module import because each reads
 * an API key from the injected config (`env.*`), which is only there after
 * the application entry runs `initCore`. This mirrors the lazy db / Redis
 * singletons -- importing this module has no env dependency, so the
 * `@breatic/core` barrel stays importable before initialization.
 * @param make - Builds the value.
 * @returns A getter that builds once.
 */
function memo<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
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
export const DIRECT_ROUTES: readonly DirectRoute[] = [
  {
    prefix: "anthropic/",
    keyName: "ANTHROPIC_API_KEY",
    name: "anthropic",
    provider: memo(() => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY || undefined })),
    reasoning: {
      on: { thinking: { type: "adaptive", display: "summarized" } },
      off: { thinking: { type: "disabled" } },
    },
  },
  {
    prefix: "google/",
    keyName: "GOOGLE_API_KEY",
    name: "google",
    provider: memo(() => createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY || undefined })),
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
    provider: memo(() => createOpenAI({ apiKey: env.OPENAI_API_KEY || undefined })),
    reasoning: { on: { reasoningEffort: "high" }, off: { reasoningEffort: "none" } },
  },
  {
    prefix: "deepseek/",
    keyName: "DEEPSEEK_API_KEY",
    name: "deepseek",
    provider: memo(() => createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY || undefined })),
    reasoning: {
      on: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      off: { thinking: { type: "disabled" } },
    },
  },
] as const;

/** Where everything else goes, and what it is called when it gets there. */
export const FALLBACK_ROUTE: Route = {
  keyName: "OPENROUTER_API_KEY",
  name: "openrouter",
  provider: memo(() => createOpenRouter({ apiKey: env.OPENROUTER_API_KEY || undefined })),
  reasoning: {
    // `max_tokens` or `effort` is required alongside; `enabled` alone does
    // not compile. `none` is the documented way to turn it off.
    on: { reasoning: { effort: "high" } },
    off: { reasoning: { effort: "none" } },
  },
};

/**
 * The direct route a model id lands on, if any.
 *
 * A direct route needs both its prefix and its key: a deployment that names
 * a model it holds no key for still reaches it through the fallback, which
 * is what makes a single OpenRouter key enough to run everything.
 * @param modelString - Model identifier, `provider/model` or plain. An
 *   absent one belongs to no vendor in particular and takes the fallback.
 * @returns The matching direct route, or undefined for the fallback.
 */
function directRouteFor(modelString: string | undefined): DirectRoute | undefined {
  if (modelString === undefined) return undefined;
  return DIRECT_ROUTES.find(
    (route) => modelString.startsWith(route.prefix) && Boolean(env[route.keyName]),
  );
}

/**
 * Get an AI SDK model instance by model string.
 *
 * The return type is `LanguageModel`, the type the SDK itself declares for
 * the `model` option of `generateText` / `streamText` — which is where every
 * caller sends it. It used to say `ReturnType<OpenAIProvider>`, borrowing one
 * branch's type to describe a function that returns a model from several.
 * @param modelString - Model identifier. Required: a call that names no model
 *   used to land on a literal that happened to match, which is the bug
 *   `agent-config.ts` records.
 * @returns AI SDK LanguageModel instance
 */
export function getModel(modelString: string): LanguageModel {
  const direct = directRouteFor(modelString);
  return direct
    ? direct.provider()(modelString.slice(direct.prefix.length))
    : FALLBACK_ROUTE.provider()(modelString);
}

/**
 * Resolve the actual provider name for a model string.
 *
 * Returns the provider that `getModel()` would route to. Used for recording
 * the actual provider in credit transactions.
 * @param modelString - Model identifier, or undefined where the caller has
 *   no record of one — that call reaches the fallback like any other id no
 *   direct route claims.
 * @returns The resolved provider name.
 */
export function resolveProvider(modelString: string | undefined): string {
  return (directRouteFor(modelString) ?? FALLBACK_ROUTE).name;
}

/**
 * What to send so this model's provider does, or does not, show its working.
 *
 * The caller says whether it wants reasoning; which vendor is being called
 * and how that vendor takes the request are settled here. Both directions
 * are stated outright, because leaving the field off means something
 * different to every provider and those defaults are theirs to change.
 * @param modelString - Model identifier, or undefined for the fallback.
 * @param thinking - Whether this call wants the model's working.
 * @returns Provider options to spread into the model call.
 */
export function reasoningFor(
  modelString: string | undefined,
  thinking: boolean,
): ReasoningOptions {
  const route = directRouteFor(modelString) ?? FALLBACK_ROUTE;
  return { providerOptions: { [route.name]: thinking ? route.reasoning.on : route.reasoning.off } };
}
