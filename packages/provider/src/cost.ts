// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

/** Whose keys paid a call: the deployment's (ours) or an account's (the user's). */
export type Payer = "deployment" | "account";

/**
 * What one paid call cost. `payer` says whose keys paid it: every cost an account's keys paid carries `account`, and a
 * cost the deployment's keys paid carries `deployment` when it sits beside an account's (a media run whose description
 * ran on other keys than its media steps); without it the deployment paid. An account's pending lookup also carries
 * `payer: "account"`, and is looked up only with that account's keys. An account-paid cost of a media run's description
 * step names the `upstream` that billed it (a pending one names it in its lookup), so the caller can tell it from the
 * media steps' costs when each part ran on another of the account's keys.
 */
export type Cost =
  | { state: "known"; usd: number; tokens?: TokenBuckets; source: "reported" | "billing" | "price_table"; payer?: Payer; upstream?: string }
  | { state: "pending"; lookup: CostLookup; payer?: Payer }
  | { state: "missing"; reason: string; tokens?: TokenBuckets; payer?: Payer; upstream?: string };

/**
 * A cost a call could not hand over in a finish: a lookup, which names its upstream, or a missing cost with the
 * upstream that billed it, since nothing else tells the caller who served a call that never ended.
 */
export type PendingCost = Extract<Cost, { state: "pending" }> | (Extract<Cost, { state: "missing" }> & { upstream: string });


const tokenCount = z.number().int().nonnegative();
const payer = z.enum(["deployment", "account"]).optional();
const upstream = z.string().min(1).optional();

/** The token buckets of a Cost, as JSON carries them. */
const tokenBucketsSchema = z.strictObject({ input: tokenCount, cachedInput: tokenCount, output: tokenCount, reasoning: tokenCount });

/**
 * A Cost as JSON carries it across processes (the web-animation job's report, a queued lookup): the caller reads one
 * back with this rather than trusting its shape.
 */
export const costSchema: z.ZodType<Cost> = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("known"), usd: z.number().finite().nonnegative(), tokens: tokenBucketsSchema.optional(), source: z.enum(["reported", "billing", "price_table"]), payer, upstream }),
  z.strictObject({ state: z.literal("pending"), lookup: z.looseObject({ upstream: z.string().min(1) }), payer }),
  z.strictObject({ state: z.literal("missing"), reason: z.string(), tokens: tokenBucketsSchema.optional(), payer, upstream }),
]);

/**
 * A cost marked with whose keys paid it: an account's pending lookup also records the owner it is looked up with.
 * @param payer - Who paid, or undefined to leave the cost as it is (the deployment, with nothing else beside it).
 * @returns The marking.
 */
export function paidBy(payer: Payer | undefined): (cost: Cost) => Cost {
  if (payer === undefined) return (cost) => cost;
  return (cost) => (cost.state === "pending" && payer === "account" ? { ...cost, lookup: { ...cost.lookup, payer }, payer } : { ...cost, payer });
}
