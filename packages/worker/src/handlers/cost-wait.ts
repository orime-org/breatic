// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A finished generation whose upstream has not billed it yet (inner#1743). The result is delivered and the task
 * waits for the bill: the credits stay held, the task's own job comes back to look the cost up after the first
 * delay, then after twice the last one, the configured number of times, and the task is billed on what was found.
 * The wait is written on the task's result as `costWait` (what is known, how many lookups ran, who served the run,
 * when the window ends) beside `pendingCosts` (each lookup and what it found).
 *
 * A cost an account's own key paid (inner#1953) is never charged: only what our keys paid is billed, and a pending one
 * is looked up with the keys of whoever paid it. A lookup whose account key row was replaced or deleted cannot be
 * asked any more and is recorded as missing.
 */

import { env, getNodeTaskConfig, logger } from "@breatic/core";
import { creditsForUsd, keysById, provider } from "@breatic/domain";
import { accountKeyFailureIn, ACCOUNT_LLM_UPSTREAM, costSchema, type Cost, type CostLookup, type KeySet, type Payer } from "@breatic/provider";

/** A cost not known when the run finished. */
type PendingCost = Extract<Cost, { state: "pending" }>;

/** The wait, as the task's result carries it. */
export interface CostWait {
  /** The credits of what was known when the run finished, unrounded: the bill rounds the sum once (inner#1666). */
  credits: number;
  /** How many lookups have run. */
  attempts: number;
  /** The upstream that served the run, which the charge names. */
  servedBy: string;
  /** When the last lookup is due, in epoch milliseconds. */
  windowEndsAt: number;
  /** Whether the result reached its nodes, its 3D row and the feed. */
  delivered?: boolean;
}

/** How a call is recorded once its cost is looked up: the task's feature and the model it called. */
export interface RecordAs {
  feature: "canvas_understand" | "canvas_transcribe" | "canvas_generation" | "mini_tool";
  model: string;
  /** The account key row the task's account-paid media calls are recorded under (inner#1953); absent on our keys. */
  keyId?: string;
  /** The account key row its account-paid language-model calls (on `ACCOUNT_LLM_UPSTREAM`) are recorded under. */
  llmKeyId?: string;
}

/** One cost being waited on, and what its last lookup found. */
export interface WaitingCost {
  lookup: CostLookup;
  cost?: Cost;
  /** The usage row the call gets once its cost is known (inner#1743). */
  recordAs?: RecordAs;
}

/** The account key sets a task's lookups are asked with: its media keys and its language-model keys. */
export interface LookupKeys {
  media?: KeySet;
  llm?: KeySet;
}

/** What a lookup records once the account key row that paid the call is gone. */
export const KEY_GONE: Cost = { state: "missing", reason: "the account key that paid it was replaced or deleted", payer: "account" };

/**
 * The account keys a lookup of a call they paid is asked with, read by the key row's id; a row replaced or deleted
 * since gives none, so the cost is recorded as missing instead of asked with ours.
 * @param keyId - The row.
 * @returns The keys, or undefined once the row is gone.
 * @throws {ProviderKeySealBroken} When the sealed key cannot be opened; the job is delivered again.
 */
export async function liveKeys(keyId: string): Promise<KeySet | undefined> {
  try {
    return (await keysById(keyId))?.keys;
  } catch (err) {
    if (accountKeyFailureIn(err)?.kind === "account_key_missing") return undefined;
    throw err;
  }
}

/**
 * The account key row a call is recorded under: an account-paid call on `ACCOUNT_LLM_UPSTREAM` under the task's LLM
 * row, any other account-paid call under its media row, the same split its lookup is asked by; a call our keys paid
 * under none.
 * @param recordAs - The task's rows.
 * @param payer - Whose keys paid the call.
 * @param upstream - The upstream that billed it.
 * @returns The row, or undefined.
 */
export function keyRowOf(recordAs: RecordAs, payer: Payer | undefined, upstream: string): string | undefined {
  if (payer !== "account") return undefined;
  return upstream === ACCOUNT_LLM_UPSTREAM ? recordAs.llmKeyId : recordAs.keyId;
}

/**
 * Whose keys paid a cost: what the cost says, else what its lookup recorded; undefined for ours.
 * @param cost - The cost, when one is held.
 * @param lookup - Its lookup.
 * @returns The payer.
 */
export function payerOf(cost: Cost | undefined, lookup: CostLookup): Payer | undefined {
  return cost?.payer ?? (lookup["payer"] === "account" ? "account" : undefined);
}

/**
 * Whether our keys paid a cost, so it is charged.
 * @param cost - The cost.
 * @returns True unless an account's key paid it.
 */
function ours(cost: Cost): boolean {
  return cost.payer !== "account";
}

/**
 * Credits for a run's dollars, by the conversion every other charge uses.
 * @param usd - What the upstreams charged.
 * @returns The credits.
 */
function creditsFor(usd: number): number {
  return creditsForUsd(usd, env.CREDIT_MULTIPLIER);
}

/**
 * Price a finished run: what our keys paid of what is known, in credits, and what is pending kept for the wait. A cost
 * no upstream can name, or an account's key paid, counts as nothing.
 * @param taskId - The task, for the log.
 * @param costs - What each billed answer of the run cost.
 * @returns The credits of what is known, and the costs still pending.
 */
export function pricedCosts(taskId: string, costs: readonly Cost[]): { credits: number; pending: PendingCost[] } {
  let usd = 0;
  const pending: PendingCost[] = [];
  for (const cost of costs) {
    if (cost.state === "known") usd += ours(cost) ? cost.usd : 0;
    else if (cost.state === "pending") pending.push(cost);
    else logger.warn({ taskId, reason: cost.reason }, "cost_unavailable");
  }
  return { credits: creditsFor(usd), pending };
}

/**
 * The configured delay and number of lookups.
 * @returns Them.
 */
function pace(): { delay: number; attempts: number } {
  const cfg = getNodeTaskConfig();
  return { delay: cfg.cost_wait_delay_ms, attempts: cfg.cost_wait_attempts };
}

/**
 * Open the wait of a run that just finished.
 * @param credits - The credits of what is known.
 * @param servedBy - The upstream that served the run.
 * @param now - The clock now.
 * @returns The wait.
 */
export function openWait(credits: number, servedBy: string, now: number): CostWait {
  const { delay, attempts } = pace();
  return { credits, attempts: 0, servedBy, windowEndsAt: now + delay * (2 ** attempts - 1) };
}

/**
 * When the next lookup is due: each waits twice as long as the one before.
 * @param wait - The wait.
 * @param now - The clock now.
 * @returns Epoch milliseconds.
 */
export function nextLookupAt(wait: CostWait, now: number): number {
  return now + pace().delay * 2 ** wait.attempts;
}

/**
 * How long the run's credits stay held: past the window, or past now once it is over, by the longest interval, so
 * the last pickup has time to look up and bill.
 * @param wait - The wait.
 * @param now - The clock now.
 * @returns When the hold may expire.
 */
export function holdUntil(wait: CostWait, now: number): Date {
  const { delay, attempts } = pace();
  return new Date(Math.max(now, wait.windowEndsAt) + delay * 2 ** (attempts - 1));
}

/**
 * Whether this lookup is the last one the wait allows.
 * @param wait - The wait.
 * @param now - The clock now.
 * @returns True on the last.
 */
export function lastLookup(wait: CostWait, now: number): boolean {
  return wait.attempts + 1 >= pace().attempts || now >= wait.windowEndsAt;
}

/**
 * The wait a task's result carries, or null when the task is not waiting on its cost.
 * @param result - The task's stored result.
 * @returns The wait and its costs.
 * @throws {Error} When the result's wait is not one the completion wrote.
 */
export function costWaitOf(result: unknown): { wait: CostWait; pending: WaitingCost[] } | null {
  if (typeof result !== "object" || result === null || !("costWait" in result)) return null;
  const { costWait, pendingCosts } = result as { costWait: Partial<CostWait> | null; pendingCosts?: unknown };
  const { credits, attempts, servedBy, windowEndsAt, delivered } = costWait ?? {};
  if (typeof credits !== "number" || typeof attempts !== "number" || typeof servedBy !== "string" || typeof windowEndsAt !== "number") {
    throw new Error("A task's costWait is not one the completion wrote");
  }
  const pending: WaitingCost[] = [];
  for (const entry of Array.isArray(pendingCosts) ? (pendingCosts as Partial<WaitingCost>[]) : []) {
    if (typeof entry.lookup?.upstream !== "string") throw new Error("A task's pending cost names no upstream");
    pending.push({
      lookup: entry.lookup,
      ...(entry.cost === undefined ? {} : { cost: costSchema.parse(entry.cost) }),
      ...(entry.recordAs === undefined ? {} : { recordAs: entry.recordAs }),
    });
  }
  return { wait: { credits, attempts, servedBy, windowEndsAt, ...(delivered === true && { delivered }) }, pending };
}

/**
 * Look one cost up with the keys of whoever paid it: an account's language-model key for an OpenRouter call, its media
 * key for any other, ours for a cost our keys paid. A cost whose account key row is gone is missing, never asked with
 * ours.
 * @param entry - The cost.
 * @param lastAttempt - Whether no later lookup follows.
 * @param keys - The task's account key sets; a set its row no longer has is absent.
 * @returns What the lookup found.
 * @throws {Error} When provider cannot ask the upstream; the pickup is delivered again.
 */
async function lookUpOne(entry: WaitingCost, lastAttempt: boolean, keys: LookupKeys): Promise<Cost> {
  if (payerOf(entry.cost, entry.lookup) !== "account") return provider().cost.lookup(entry.lookup, { lastAttempt });
  const set = entry.lookup.upstream === ACCOUNT_LLM_UPSTREAM ? keys.llm : keys.media;
  if (set === undefined) return KEY_GONE;
  try {
    return await provider().cost.lookup(entry.lookup, { lastAttempt, keys: set });
  } catch (err) {
    if (accountKeyFailureIn(err)?.kind === "account_key_missing") return KEY_GONE;
    throw err;
  }
}

/**
 * Look up every cost not yet answered.
 * @param pending - The costs waited on.
 * @param lastAttempt - Whether no later lookup follows; a cost still unanswered then is missing.
 * @param keys - The task's account key sets, for the costs an account's keys paid.
 * @returns The costs with what this lookup found.
 * @throws {Error} When provider cannot ask an upstream; the pickup is delivered again.
 */
export async function lookUp(pending: readonly WaitingCost[], lastAttempt: boolean, keys: LookupKeys = {}): Promise<WaitingCost[]> {
  const found: WaitingCost[] = [];
  for (const entry of pending) {
    if (entry.cost !== undefined && entry.cost.state !== "pending") found.push(entry);
    else found.push({ ...entry, cost: await lookUpOne(entry, lastAttempt, keys) });
  }
  return found;
}

/**
 * Whether a cost still waits on its upstream.
 * @param entry - The cost.
 * @returns True while unanswered.
 */
export function unanswered(entry: WaitingCost): boolean {
  return entry.cost === undefined || entry.cost.state === "pending";
}

/**
 * What the task is billed: what was known when it finished and what the lookups found our keys paid. A cost never
 * answered counts as nothing.
 * @param taskId - The task, for the log.
 * @param wait - The wait.
 * @param pending - The costs and what their lookups found.
 * @returns The credits.
 */
export function billedCredits(taskId: string, wait: CostWait, pending: readonly WaitingCost[]): number {
  let usd = 0;
  for (const { lookup, cost } of pending) {
    if (cost?.state === "known") usd += ours(cost) ? cost.usd : 0;
    else logger.warn({ taskId, upstream: lookup.upstream, reason: cost?.state === "missing" ? cost.reason : "never answered" }, "cost_unavailable");
  }
  return wait.credits + creditsFor(usd);
}
