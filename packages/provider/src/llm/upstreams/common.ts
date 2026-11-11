// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What an LLM upstream adapter is (`Vendor`) and the small readers its kinds share. Each kind's adapter is a file
 * beside this one; `vendors.ts` registers them.
 */

import type { JSONValue, LanguageModel } from "ai";
import type { LlmPrice, ProviderConfig, UpstreamDecl } from "@provider/config/schema.js";
import type { Cost, CostLookup } from "@provider/cost.js";

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
  reasoning: { on: (modelId: string) => VendorOptions; off: VendorOptions };
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
