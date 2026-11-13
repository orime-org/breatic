// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";

/** A number leaf of an upstream answer: a value that is not a finite number reads as absent. */
export const numberLeaf = z.number().optional().catch(undefined);

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

/** What one paid call cost. */
export type Cost =
  | { state: "known"; usd: number; tokens?: TokenBuckets; source: "reported" | "billing" | "price_table" }
  | { state: "pending"; lookup: CostLookup }
  | { state: "missing"; reason: string; tokens?: TokenBuckets };

/**
 * A cost a call could not hand over in a finish: a lookup, which names its upstream, or a missing cost with the
 * upstream that billed it, since nothing else tells the caller who served a call that never ended.
 */
export type PendingCost = Extract<Cost, { state: "pending" }> | (Extract<Cost, { state: "missing" }> & { upstream: string });


const tokenCount = z.number().int().nonnegative();

/** The token buckets of a Cost, as JSON carries them. */
const tokenBucketsSchema = z.strictObject({ input: tokenCount, cachedInput: tokenCount, output: tokenCount, reasoning: tokenCount });

/**
 * A Cost as JSON carries it across processes (the web-animation job's report, a queued lookup): the caller reads one
 * back with this rather than trusting its shape.
 */
export const costSchema: z.ZodType<Cost> = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("known"), usd: z.number().finite().nonnegative(), tokens: tokenBucketsSchema.optional(), source: z.enum(["reported", "billing", "price_table"]) }),
  z.strictObject({ state: z.literal("pending"), lookup: z.looseObject({ upstream: z.string().min(1) }) }),
  z.strictObject({ state: z.literal("missing"), reason: z.string(), tokens: tokenBucketsSchema.optional() }),
]);
