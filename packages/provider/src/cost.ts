// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProviderConfig } from "@provider/config/schema.js";
import { fetchJson, SIDE_REQUEST_MS } from "@provider/http/request.js";
import { billed } from "@provider/media/wavespeed/adapter.js";
import type { ProviderOptions } from "@provider/provider.js";

/** The largest generation answer read. */
const MAX_LOOKUP_BYTES = 1024 * 1024;

/** A serializable handle to look a cost up later; its content belongs to the upstream that issued it. */
export interface CostLookup {
  upstream: string;
  [key: string]: unknown;
}

/** The token buckets one model call used; reasoning is part of output. */
export interface TokenBuckets {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** What one paid call cost (design 3.6). */
export type Cost =
  | { state: "known"; usd: number; tokens?: TokenBuckets; source: "reported" | "billing" | "price_table" }
  | { state: "pending"; lookup: CostLookup }
  | { state: "missing"; reason: string; tokens?: TokenBuckets };

/**
 * A token count off a generation answer.
 * @param value - The field as OpenRouter sent it.
 * @returns The count, or 0 when it is absent or not finite.
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Ask the upstream again for a cost that was pending (design 3.6): OpenRouter
 * by generation id, WaveSpeed by its billing search. Until the last attempt an
 * unanswered lookup stays pending; on it, it is missing.
 * @param config - The validated configuration.
 * @param options - The caller's options.
 * @param lookup - The handle.
 * @param lastAttempt - Whether no later lookup follows.
 * @returns The cost.
 */
export async function lookupCost(config: ProviderConfig, options: ProviderOptions, lookup: CostLookup, lastAttempt: boolean): Promise<Cost> {
  /**
   * The answer when the upstream did not say: pending, or missing on the last attempt.
   * @param reason - Why.
   * @returns The cost.
   */
  const unanswered = (reason: string): Cost => (lastAttempt ? { state: "missing", reason } : { state: "pending", lookup });
  const decl = config.upstreams[lookup.upstream];
  if (decl === undefined) return { state: "missing", reason: `unknown upstream ${lookup.upstream}` };
  const key = options.keyOf(decl.key_env) ?? "";
  if (decl.kind === "wavespeed" && typeof lookup.predictionId === "string") {
    return (await billed({ name: lookup.upstream, decl, key }, lookup.predictionId, {}, lastAttempt)).cost;
  }
  if (decl.kind !== "openrouter" || typeof lookup.generationId !== "string") return { state: "missing", reason: "the lookup names nothing to ask" };
  try {
    const body = await fetchJson(
      { url: `${decl.base_url}/generation?id=${encodeURIComponent(lookup.generationId)}`, method: "GET", headers: { authorization: `Bearer ${key}` } },
      { replaySafe: true, maxBodyBytes: MAX_LOOKUP_BYTES, idleMs: SIDE_REQUEST_MS },
    );
    const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
    const cost = data.total_cost;
    if (typeof cost !== "number" || !Number.isFinite(cost)) return unanswered("the generation carries no cost yet");
    const tokens: TokenBuckets = {
      input: count(data.native_tokens_prompt),
      cachedInput: count(data.native_tokens_cached),
      output: count(data.native_tokens_completion),
      reasoning: count(data.native_tokens_reasoning),
    };
    return { state: "known", usd: cost, tokens, source: "billing" };
  } catch (error) {
    return unanswered(error instanceof Error ? error.message : String(error));
  }
}
