// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What an LLM upstream adapter is (`Vendor`) and the small readers its kinds share. Each kind's adapter is a file
 * beside this one; `vendors.ts` registers them.
 */

import type { JSONValue, LanguageModel } from "ai";
import type { LlmPrice, ProviderConfig, UpstreamDecl } from "@provider/config/schema.js";
import type { Cost, CostLookup, TokenBuckets } from "@provider/cost.js";
import { priceAt, tokenUsd, type PriceEntries } from "@provider/llm/prices.js";

/** A language model of the specification the AI SDK providers implement. */
export type ModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;

/** What one vendor's slot in `providerOptions` holds. */
export type VendorOptions = Record<string, JSONValue>;

/** What an upstream's refusal says beyond its status. */
export type Refusal = "model_not_found" | "insufficient_balance";

/** The LLM part of the configuration. */
export type LlmConfig = ProviderConfig["llm"];

/**
 * How an upstream that reports each answer's cost, and keeps a generation to look it up by later, is read.
 * The generation is what a cost is looked up by while the answer carried none.
 */
export interface ReportedCosts {
  /** The cost, in USD, a finish's provider metadata reports. */
  reported: (metadata: unknown) => number | undefined;
  /** The generation id and reported cost an answer body, or a raw stream chunk, names. */
  ofBody: (body: unknown) => { id?: unknown; cost?: number };
  /** Whether an id is one this upstream's costs are looked up by. */
  isGeneration: (id: unknown) => id is string;
  /** Asks the upstream what one generation cost; until the last attempt an unanswered lookup stays pending. */
  lookup: (decl: UpstreamDecl, key: string, generationId: string, lookup: CostLookup, lastAttempt: boolean) => Promise<Cost>;
}

/** What a relayed Messages call left for its cost to be read from. */
export interface MessagesCall {
  upstream: string;
  /** The id of message_start, once it came. */
  messageId: string | undefined;
  /** The usage of message_delta, once the call completed. */
  usage: Record<string, unknown> | undefined;
  /** When the request that served the call was sent, in epoch ms. */
  sentAt: number;
  /** The model's direct prices, for an upstream priced from `llm.yaml`. */
  prices: PriceEntries | undefined;
}

/**
 * How one upstream kind takes an Anthropic Messages request: what the web-animation relay needs of it, all of which
 * runs in a Cloudflare Worker.
 */
export interface MessagesSpeaker {
  /** Its Messages endpoint under the upstream's base address. */
  url: (baseUrl: string) => string;
  /** The headers that carry the key. */
  auth: (key: string) => Record<string, string>;
  /** Its own change to the request body, made in place. */
  rewrite?: (body: Record<string, unknown>) => void;
  /** What its refusal means beyond its status (its own forms). */
  refusal: (status: number, body: unknown) => Refusal | undefined;
  /** What a call it served cost. */
  cost: (call: MessagesCall) => Cost;
}

/** How one upstream kind is spoken to. */
export interface Vendor {
  /** The key its AI SDK provider reads `providerOptions` and message options by. */
  sdkName: string;
  /** Builds its model factory, its SDK sending through provider's own fetch. */
  build: (decl: UpstreamDecl, apiKey: string) => (modelId: string) => ModelV4;
  /** The id it serves a model under, from what follows the route prefix (or the whole id for a gateway). */
  vendorId: (modelId: string) => string;
  /** Whether it takes our whole model id rather than what follows the route prefix. */
  gateway: boolean;
  reasoning: {
    on: (modelId: string) => VendorOptions;
    off: VendorOptions;
    /** How it is told a named depth, on an upstream that takes one. */
    at?: (level: "low" | "medium" | "high") => VendorOptions;
  };
  /** The cache mark for a lifetime, or nothing when it caches a repeated prefix on its own. */
  cache: (modelId: string, ttl: "5m" | "1h") => VendorOptions;
  /**
   * What this vendor's own refusal means, read from its status and parsed body
   * (each vendor's forms, never another's).
   */
  refusal: (status: number, body: unknown) => Refusal | undefined;
  /** The status this vendor's own plain error part stands for, when its SDK hands one over as it came. */
  inBandStatus?: (error: unknown) => number | undefined;
  /** Its answers report what they cost; without it a call is priced from `llm.yaml`'s direct prices. */
  costs?: ReportedCosts;
  /** The price a cheapest call ranks it by; without it the direct price in effect. */
  listedPrice?: (llm: LlmConfig, modelId: string, at: number) => LlmPrice | undefined;
  /** What it is told about where to send a call (its own routing options), or nothing. */
  routing?: (llm: LlmConfig, modelId: string, cheapest: boolean, pinned: boolean) => VendorOptions | undefined;
  /**
   * Its model list, read for which models take pictures, and each model's own endpoint list, read for the context
   * window a turn can count on.
   */
  catalog?: {
    url: (decl: UpstreamDecl) => string;
    read: (body: unknown) => ReadonlyMap<string, boolean> | undefined;
    contextWindow: { url: (decl: UpstreamDecl, modelId: string) => string; read: (body: unknown) => number | undefined };
  };
  /** The decisions endpoint (JEV) it serves. */
  decisions?: { model: string; url: (decl: UpstreamDecl) => string };
}

/** The `error` object of a vendor's error body. */
export interface ErrorBody {
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
export function errorOf(body: unknown): ErrorBody {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  return typeof error === "object" && error !== null ? error : {};
}

/**
 * The `error.message` of a parsed error body.
 * @param body - The parsed body.
 * @returns The message, or "".
 */
export function messageOf(body: unknown): string {
  const message = errorOf(body).message;
  return typeof message === "string" ? message : "";
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
export function cacheControl(ttl: "5m" | "1h"): VendorOptions {
  return { cacheControl: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } };
}

/**
 * The id as written.
 * @param modelId - The id.
 * @returns The same id.
 */
export const asWritten = (modelId: string): string => modelId;

/**
 * No cache mark.
 * @returns Nothing.
 */
export const cachesOnItsOwn = (): VendorOptions => ({});

/**
 * A non-negative integer counter of a usage object, or zero.
 * @param value - The counter.
 * @returns It, or zero when missing or not a counter.
 */
export function counter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The tokens a Messages usage object counts: its input counts only the uncached input, the cached and the
 * cache-written input are counted beside it, and thinking is part of the output.
 * @param usage - The usage of message_delta.
 * @returns The token buckets, and the cache-written input.
 */
export function messagesTokens(usage: Record<string, unknown>): TokenBuckets & { written: number } {
  const cachedInput = counter(usage["cache_read_input_tokens"]);
  const written = counter(usage["cache_creation_input_tokens"]);
  const details = usage["output_tokens_details"];
  const reasoning = counter(typeof details === "object" && details !== null ? (details as Record<string, unknown>)["thinking_tokens"] : undefined);
  return { input: counter(usage["input_tokens"]) + cachedInput + written, cachedInput, output: counter(usage["output_tokens"]), reasoning, written };
}

/**
 * What a direct upstream's Messages call cost: its tokens at the direct price in effect when it was sent. A call that
 * did not complete, or a model with no direct price, is missing, never free.
 * @param call - The call.
 * @returns The cost.
 */
export function priceTableMessagesCost(call: MessagesCall): Cost {
  if (call.usage === undefined) return { state: "missing", reason: `the call on ${call.upstream} ended before its usage` };
  const { written, ...tokens } = messagesTokens(call.usage);
  const price = priceAt(call.prices, call.sentAt);
  if (price === undefined) return { state: "missing", reason: `no direct price for the call on ${call.upstream}`, tokens };
  return { state: "known", usd: tokenUsd(price, { input: tokens.input, cachedInput: tokens.cachedInput, written, output: tokens.output }), tokens, source: "price_table" };
}
