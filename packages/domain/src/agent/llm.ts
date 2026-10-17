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
 * which would be a fifth copy of this table. Callers say what they want --
 * the model's working, a cache lifetime, a temperature, the conversation --
 * and nothing about how any vendor spells it.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, SystemModelMessage, streamText } from "ai";
import { env } from "@breatic/core";
import type { CoreConfig, PromptCacheTtl } from "@breatic/core";
import { instructionsText } from "@domain/agent/instructions.js";
import type { Instructions } from "@domain/agent/instructions.js";

/**
 * What a model call carries to ask its provider for reasoning, caching and a
 * sticky session, and the temperature where the model takes one.
 *
 * Taken off the call's own parameter rather than restated: the SDK does not
 * export this type by name, and a hand-written copy of it would be a second
 * answer that goes stale.
 */
type CallOptions = Pick<Parameters<typeof streamText>[0], "providerOptions" | "temperature">;

/** What one provider's slot in that object holds. */
type ProviderOptionsFor = NonNullable<CallOptions["providerOptions"]>[string];

/**
 * The name of an env var this deployment can hold a provider key in.
 *
 * Narrowed to the schema's own key names so a name it does not carry is a
 * compile error naming the correct spelling. A plain `string` here would let
 * a typo through to runtime, where it reads as undefined: the route silently
 * never opens, every call for that vendor goes to OpenRouter instead, and
 * the charge is recorded against OpenRouter too. This repo has made exactly
 * that typo before: a providers.yaml once named `KLING_ACCESS_KEY` where the
 * schema said `KLINGAI_ACCESS_KEY`.
 */
type ProviderKeyName = Extract<keyof CoreConfig, `${string}_API_KEY`>;

/** What a call asks of its provider beyond the prompt. */
export interface CallWants {
  /** Whether this call wants the model's working. */
  thinking: boolean;
  /** Whether, and for how long, to cache the prompt prefix. */
  cache: PromptCacheTtl | false;
  /** A fixed sampling temperature, sent only where the model accepts one. */
  temperature?: number;
  /**
   * The conversation the call belongs to. Through OpenRouter it keeps the
   * conversation's calls on one provider from the first request while they
   * come less than 10 minutes apart, so a prefix cached on that provider is
   * read on the next call (OpenRouter prompt caching, "Using session_id for
   * sticky sessions": sticky sessions expire after 10 minutes of inactivity).
   */
  session?: string;
}

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
  /**
   * How this provider is told to cache the prompt prefix for a model, or
   * nothing when it caches a repeated prefix on its own.
   */
  cache: (modelString: string, ttl: PromptCacheTtl) => ProviderOptionsFor;
}

/** A route a model id reaches by carrying its prefix. */
interface DirectRoute extends Route {
  /** The model-id prefix that names this provider. */
  prefix: string;
  /** The id this vendor serves the model under, from what follows the prefix. */
  vendorId: (modelId: string) => string;
}

/**
 * The id as written, for vendors that serve the model under it.
 * @param modelId - What follows the prefix.
 * @returns The same id.
 */
const asWritten = (modelId: string): string => modelId;

/**
 * Whether a model id names a Claude model.
 *
 * Claude is reached directly or through OpenRouter, and both routes treat it
 * apart from the others: it caches only when asked to, and some versions
 * reject the request that turns thinking off.
 * @param modelString - Model identifier.
 * @returns True for an `anthropic/` id.
 */
function isClaude(modelString: string | undefined): boolean {
  return modelString?.startsWith("anthropic/") ?? false;
}

/**
 * The cache-control value Anthropic takes, for a lifetime.
 *
 * Five minutes is the default and is written without a `ttl`.
 * @param ttl - How long the prefix should live.
 * @returns The value to send.
 */
function cacheControl(ttl: PromptCacheTtl): { type: "ephemeral"; ttl?: "1h" } {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * Routes whose provider caches a repeated prefix without being asked.
 * @returns No options.
 */
const cachesOnItsOwn = (): ProviderOptionsFor => ({});

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
    // Configured ids are written the way OpenRouter names Claude
    // (`claude-opus-5.5`); Anthropic serves the same model as `claude-opus-5-5`.
    vendorId: (modelId) => modelId.replace(/(\d)\.(\d)/g, "$1-$2"),
    reasoning: {
      // The same depth as the fallback asks for: Opus 5.5 left without an
      // effort thinks at its own default, medium.
      on: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      // Not read: `callOptionsFor` sends Claude nothing when thinking is off.
      off: {},
    },
    cache: (_modelString, ttl) => ({ cacheControl: cacheControl(ttl) }),
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
    vendorId: asWritten,
    cache: cachesOnItsOwn,
  },
  {
    prefix: "openai/",
    keyName: "OPENAI_API_KEY",
    name: "openai",
    provider: memo(() => createOpenAI({ apiKey: env.OPENAI_API_KEY || undefined })),
    reasoning: { on: { reasoningEffort: "high" }, off: { reasoningEffort: "none" } },
    vendorId: asWritten,
    cache: cachesOnItsOwn,
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
    vendorId: asWritten,
    cache: cachesOnItsOwn,
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
  // OpenRouter turns a request-level `cache_control` into Anthropic's
  // automatic caching; the other models it reaches cache a repeated prefix on
  // their own.
  cache: (modelString, ttl) => (isClaude(modelString) ? { cacheControl: cacheControl(ttl) } : {}),
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
    ? direct.provider()(direct.vendorId(modelString.slice(direct.prefix.length)))
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
 * The route a model call takes and the cache mark it carries there.
 *
 * The request-level mark and the marks on the system prompt's parts come from
 * this one place, so the two always agree on whether this call caches.
 * @param modelString - Model identifier, or undefined for the fallback.
 * @param cache - How long to cache, or false when the call does not cache.
 * @returns The route, and the mark (empty when nothing is marked).
 */
function cacheMarkFor(
  modelString: string | undefined,
  cache: PromptCacheTtl | false,
): { route: Route; mark: ProviderOptionsFor } {
  const route = directRouteFor(modelString) ?? FALLBACK_ROUTE;
  return { route, mark: cache === false || modelString === undefined ? {} : route.cache(modelString, cache) };
}

/**
 * What to send so this model's provider reasons, or does not, caches the
 * prompt prefix, or does not, and keeps a conversation on one provider.
 *
 * The caller says what it wants; which vendor is being called and how that
 * vendor takes each request are settled here. Reasoning is stated in both
 * directions, because leaving the field off means something different to
 * every provider and those defaults are theirs to change -- except for
 * Claude, where leaving it off is the one spelling every version accepts.
 * @param modelString - Model identifier, or undefined for the fallback.
 * @param wants - Whether the call wants reasoning, how long to cache, the
 *   temperature it would like where the model takes one, and the
 *   conversation it belongs to (sent to OpenRouter as its session id).
 * @returns Provider options to spread into the model call.
 * @throws {never} Never.
 */
export function callOptionsFor(modelString: string | undefined, wants: CallWants): CallOptions {
  const { route, mark: cache } = cacheMarkFor(modelString, wants.cache);
  // Claude, on either route, gets no thinking field when it is off: the 4.x
  // models then do not think, and Opus 5.5, which rejects
  // `{ type: "disabled" }` with a 400, falls to the adaptive thinking it
  // cannot leave (Anthropic thinking docs, "Configuring thinking").
  const reasoning = wants.thinking
    ? route.reasoning.on
    : isClaude(modelString)
      ? {}
      : route.reasoning.off;
  // Current Claude models return a 400 for any non-default temperature, and
  // older ones for any temperature while thinking is on (Anthropic thinking
  // docs, "Sampling parameters").
  const temperature = wants.temperature === undefined || isClaude(modelString) ? {} : { temperature: wants.temperature };
  const session = wants.session !== undefined && route === FALLBACK_ROUTE ? { session_id: wants.session } : {};
  return { providerOptions: { [route.name]: { ...reasoning, ...cache, ...session } }, ...temperature };
}

/**
 * The system prompt as the messages a model call sends.
 *
 * Where this route marks cache breakpoints for this model, each part another
 * conversation also sends goes as its own message ending in a mark: request-
 * level caching writes one entry, for the prefix ending at the last block, so
 * a new conversation, whose first message is new, would find nothing to read
 * even though everything before that message is the same as in other
 * conversations (Anthropic prompt caching, "The system does not write entries
 * for any earlier position"). The mark after the base prompt writes an entry
 * every conversation reads, the one after the project's memory an entry every
 * conversation of that project reads. Where nothing is marked, the prompt
 * goes whole, as one message.
 * @param modelString - Model identifier, or undefined for the fallback.
 * @param parts - The base prompt, the project's memory and this
 *   conversation's memory, the last two when there are any.
 * @param cache - How long to cache, or false when the call does not cache.
 * @returns The system messages, in order.
 * @throws {never} Never.
 */
export function systemFor(
  modelString: string | undefined,
  parts: Instructions,
  cache: PromptCacheTtl | false,
): SystemModelMessage[] {
  const { route, mark } = cacheMarkFor(modelString, cache);
  if (Object.keys(mark).length === 0) return [{ role: "system", content: instructionsText(parts) }];
  const providerOptions = { [route.name]: mark };
  return [
    { role: "system", content: parts.base, providerOptions },
    ...(parts.project === undefined ? [] : [{ role: "system" as const, content: parts.project, providerOptions }]),
    ...(parts.conversation === undefined ? [] : [{ role: "system" as const, content: parts.conversation }]),
  ];
}
