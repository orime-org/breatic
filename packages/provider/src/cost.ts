// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import type { ProviderConfig } from "@provider/config/schema.js";
import { fetchJson, SIDE_REQUEST_MS } from "@provider/http/request.js";
import { billed } from "@provider/media/wavespeed/adapter.js";
import type { ProviderOptions } from "@provider/provider.js";

/** A number leaf of an upstream answer: a value that is not a finite number reads as absent. */
export const numberLeaf = z.number().optional().catch(undefined);

/** OpenRouter's generation answer, as far as it is read. */
const generationSchema = z.looseObject({
  data: z.looseObject({
    total_cost: numberLeaf,
    native_tokens_prompt: numberLeaf,
    native_tokens_cached: numberLeaf,
    native_tokens_completion: numberLeaf,
    native_tokens_reasoning: numberLeaf,
  }),
});

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
 * A token count off an answer.
 * @param value - The field as the upstream sent it.
 * @returns The count, or 0 when it is absent or not finite.
 */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A reported amount in USD.
 * @param value - The field as the upstream sent it.
 * @returns The amount when it is a finite number, else undefined.
 */
export function usdOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    const parsed = generationSchema.safeParse(body);
    if (!parsed.success) return unanswered("the generation answer is not shaped as a generation");
    const data = parsed.data.data;
    const tokens: TokenBuckets = {
      input: count(data.native_tokens_prompt),
      cachedInput: count(data.native_tokens_cached),
      output: count(data.native_tokens_completion),
      reasoning: count(data.native_tokens_reasoning),
    };
    const cost = usdOf(data.total_cost);
    if (cost === undefined) {
      const reason = "the generation carries no cost yet";
      return lastAttempt ? { state: "missing", reason, tokens } : { state: "pending", lookup };
    }
    return { state: "known", usd: cost, tokens, source: "billing" };
  } catch (error) {
    return unanswered(error instanceof Error ? error.message : String(error));
  }
}
