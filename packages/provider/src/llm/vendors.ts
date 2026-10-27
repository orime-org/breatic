// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How each LLM upstream kind is reached and spoken to, ported from domain's
 * `agent/llm.ts`. Each vendor takes reasoning, caching and a sticky session
 * its own way, under the key its AI SDK provider reads `providerOptions` by.
 * Reasoning is stated in both directions because leaving it out means
 * something different to each vendor; Claude, on either route, gets nothing
 * when it is off, the one spelling every Claude version accepts.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { JSONValue, LanguageModel } from "ai";
import type { UpstreamDecl } from "@provider/config/schema.js";
import type { CallWants } from "@provider/llm/api.js";

/** A language model of the specification the AI SDK providers implement. */
export type ModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;

/** What one vendor's slot in `providerOptions` holds. */
export type VendorOptions = Record<string, JSONValue>;

/** What an upstream's refusal says beyond its status (design 5.3). */
export type Refusal = "model_not_found" | "insufficient_balance";

/** The `error` object of a vendor's error body. */
interface ErrorBody {
  message?: unknown;
  status?: unknown;
  code?: unknown;
  type?: unknown;
}

/**
 * The `error` object of a parsed error body, or an empty one.
 * @param body - The parsed body.
 * @returns Its `error` object.
 */
function errorOf(body: unknown): ErrorBody {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  return typeof error === "object" && error !== null ? error : {};
}

/**
 * The `error.message` of a parsed error body.
 * @param body - The parsed body.
 * @returns The message, or "".
 */
function messageOf(body: unknown): string {
  const message = errorOf(body).message;
  return typeof message === "string" ? message : "";
}

/** How one upstream kind is spoken to. */
export interface Vendor {
  /** The key its AI SDK provider reads `providerOptions` and message options by. */
  sdkName: string;
  /** Builds its model factory; `fetch` is provider's own unless the caller wraps it. */
  build: (decl: UpstreamDecl, apiKey: string, fetch: typeof globalThis.fetch) => (modelId: string) => ModelV4;
  /** The id it serves a model under, from what follows the route prefix (or the whole id for a gateway). */
  vendorId: (modelId: string) => string;
  /** Whether it takes our whole model id rather than what follows the route prefix. */
  gateway: boolean;
  reasoning: { on: (modelId: string) => VendorOptions; off: VendorOptions };
  /** The cache mark for a lifetime, or nothing when it caches a repeated prefix on its own. */
  cache: (modelId: string, ttl: "5m" | "1h") => VendorOptions;
  /**
   * What this vendor's own refusal means, read from its status and parsed body
   * (design 5.3: each vendor's forms, never another's).
   */
  refusal: (status: number, body: unknown) => Refusal | undefined;
  /** The status this vendor's own plain error part stands for, when its SDK hands one over as it came. */
  inBandStatus?: (error: unknown) => number | undefined;
}

/** Anthropic's error types and the statuses its error docs give them (https://platform.claude.com/docs/en/api/errors). */
const ANTHROPIC_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/**
 * The status an error part before content stands for, read the answering vendor's way:
 * a value carrying a numeric statusCode (the stream errors the DeepSeek and
 * OpenAI-compatible SDKs build, plain objects or Errors), else the vendor's own plain form.
 * @param vendor - The vendor that answered.
 * @param error - What the error part carried.
 * @returns The status, or undefined when the part says none.
 */
export function inBandStatusOf(vendor: Vendor | undefined, error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  return error instanceof Error ? undefined : vendor?.inBandStatus?.(error);
}

/**
 * The body a vendor's refusal is read from for an error part.
 * @param error - What the error part carried.
 * @returns The SDK's own chunk when its stream error kept one, else `{ error }`.
 */
export function inBandBodyOf(error: unknown): unknown {
  return (error as { data?: unknown } | null | undefined)?.data ?? { error };
}

/**
 * Whether a model id names a Claude model.
 * @param modelId - Our model id.
 * @returns True for an `anthropic/` id.
 */
export function isClaude(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}

/**
 * The cache-control value Anthropic takes; five minutes is its default and goes without a ttl.
 * @param ttl - The lifetime.
 * @returns The value.
 */
function cacheControl(ttl: "5m" | "1h"): VendorOptions {
  return { cacheControl: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } };
}

/**
 * The id as written.
 * @param modelId - The id.
 * @returns The same id.
 */
const asWritten = (modelId: string): string => modelId;

/**
 * No cache mark.
 * @returns Nothing.
 */
const cachesOnItsOwn = (): VendorOptions => ({});

const VENDORS: Readonly<Record<string, Vendor>> = {
  anthropic: {
    sdkName: "anthropic",
    inBandStatus: (error) => {
      const type = (error as { type?: unknown } | null)?.type;
      return typeof type === "string" ? ANTHROPIC_STATUS[type] : undefined;
    },
    build: (decl, apiKey, fetch) => createAnthropic({ baseURL: decl.base_url, apiKey, fetch }),
    // Ids are written the way OpenRouter names Claude (`claude-opus-5.5`); Anthropic serves `claude-opus-5-5`.
    vendorId: (modelId) => modelId.replace(/(\d)\.(\d)/g, "$1-$2"),
    gateway: false,
    reasoning: { on: () => ({ thinking: { type: "adaptive", display: "summarized" }, effort: "high" }), off: {} },
    cache: (_modelId, ttl) => cacheControl(ttl),
    // Measured 2026-10-27 for the balance; the missing model from Anthropic's error docs.
    refusal: (status, body) => {
      if (status === 404 && errorOf(body).type === "not_found_error") return "model_not_found";
      return status === 400 && messageOf(body).includes("credit balance is too low") ? "insufficient_balance" : undefined;
    },
  },
  google: {
    sdkName: "google",
    build: (decl, apiKey, fetch) => createGoogleGenerativeAI({ baseURL: decl.base_url, apiKey, fetch }),
    vendorId: asWritten,
    gateway: false,
    reasoning: { on: () => ({ thinkingConfig: { thinkingBudget: -1, includeThoughts: true } }), off: { thinkingConfig: { thinkingBudget: 0 } } },
    cache: cachesOnItsOwn,
    // Measured 2026-10-27; the free tier never answered with a balance refusal.
    refusal: (status, body) => (status === 404 && errorOf(body).status === "NOT_FOUND" ? "model_not_found" : undefined),
  },
  openai: {
    sdkName: "openai",
    build: (decl, apiKey, fetch) => createOpenAI({ baseURL: decl.base_url, apiKey, fetch }),
    vendorId: asWritten,
    gateway: false,
    reasoning: { on: () => ({ reasoningEffort: "high" }), off: { reasoningEffort: "none" } },
    cache: cachesOnItsOwn,
    // Measured 2026-10-27.
    refusal: (status, body) => {
      if (status === 404 && errorOf(body).code === "model_not_found") return "model_not_found";
      return status === 429 && errorOf(body).type === "insufficient_quota" ? "insufficient_balance" : undefined;
    },
  },
  deepseek: {
    sdkName: "deepseek",
    build: (decl, apiKey, fetch) => createDeepSeek({ baseURL: decl.base_url, apiKey, fetch }),
    vendorId: asWritten,
    gateway: false,
    // DeepSeek's deepest level; inner#1650 measured Flash 1017 at it.
    reasoning: { on: () => ({ thinking: { type: "enabled" }, reasoningEffort: "max" }), off: { thinking: { type: "disabled" } } },
    cache: cachesOnItsOwn,
    // The missing model measured 2026-10-27; 402 from DeepSeek's error code page.
    refusal: (status, body) => {
      if (status === 400 && messageOf(body).startsWith("The supported API model names are")) return "model_not_found";
      return status === 402 ? "insufficient_balance" : undefined;
    },
  },
  openrouter: {
    sdkName: "openrouter",
    inBandStatus: (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      return typeof code === "number" && Number.isInteger(code) ? code : undefined;
    },
    build: (decl, apiKey, fetch) => createOpenRouter({ baseURL: decl.base_url, apiKey, fetch }),
    vendorId: asWritten,
    gateway: true,
    // OpenRouter lists max for DeepSeek and turns `xhigh` into `high`; `none` turns reasoning off.
    reasoning: { on: (modelId) => ({ reasoning: { effort: modelId.startsWith("deepseek/") ? "max" : "high" } }), off: { reasoning: { effort: "none" } } },
    // It turns a request-level mark into Anthropic's automatic caching; other models cache a prefix on their own.
    cache: (modelId, ttl) => (isClaude(modelId) ? cacheControl(ttl) : {}),
    // The missing model measured 2026-10-26; 402 from OpenRouter's error docs.
    refusal: (status, body) => {
      if (status === 400 && messageOf(body).endsWith(" is not a valid model ID")) return "model_not_found";
      return status === 402 ? "insufficient_balance" : undefined;
    },
  },
};

/**
 * The vendor of an upstream kind.
 * @param kind - The upstream's kind.
 * @returns How it is spoken to.
 * @throws {Error} When provider has no LLM adapter of that kind.
 */
export function vendorOf(kind: string): Vendor {
  const vendor = VENDORS[kind];
  if (vendor === undefined) throw new Error(`No LLM adapter speaks to upstreams of kind "${kind}"`);
  return vendor;
}

/**
 * The cache mark this vendor puts on a call, or nothing.
 * @param vendor - The vendor.
 * @param modelId - Our model id.
 * @param cache - The lifetime asked for, or false.
 * @returns The mark.
 */
export function cacheMark(vendor: Vendor, modelId: string, cache: CallWants["cache"]): VendorOptions {
  return cache === false ? {} : vendor.cache(modelId, cache);
}

/**
 * What one vendor is sent so the call reasons, or does not, caches, or does not,
 * and stays on one backend for a conversation.
 * @param vendor - The vendor.
 * @param modelId - Our model id.
 * @param wants - What the call asks for.
 * @returns The vendor's options.
 */
export function optionsFor(vendor: Vendor, modelId: string, wants: CallWants): VendorOptions {
  const reasoning = wants.thinking ? vendor.reasoning.on(modelId) : isClaude(modelId) ? {} : vendor.reasoning.off;
  const session: VendorOptions = wants.session !== undefined && vendor.gateway ? { session_id: wants.session } : {};
  return { ...reasoning, ...cacheMark(vendor, modelId, wants.cache), ...session };
}
