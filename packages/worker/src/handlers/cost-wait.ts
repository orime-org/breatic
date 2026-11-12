// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A finished generation whose upstream has not billed it yet (inner#1743). The result is delivered and the task
 * waits for the bill: the credits stay held, the task's own job comes back to look the cost up after the first
 * delay, then after twice the last one, the configured number of times, and the task is billed on what was found.
 * The wait is written on the task's result as `costWait` (what is known, how many lookups ran, who served the run,
 * when the window ends) beside `pendingCosts` (each lookup and what it found).
 */

import { env, getNodeTaskConfig, logger } from "@breatic/core";
import { creditsForUsd, provider } from "@breatic/domain";
import { costSchema, type Cost, type CostLookup } from "@breatic/provider";

/** A cost not known when the run finished. */
type PendingCost = Extract<Cost, { state: "pending" }>;

/** The wait, as the task's result carries it. */
export interface CostWait {
  /** The credits of what was known when the run finished. */
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

/** How a reading's call is recorded once its cost is looked up: the task's feature and the model it called. */
export interface RecordAs {
  feature: "canvas_understand" | "canvas_transcribe";
  model: string;
}

/** One cost being waited on, and what its last lookup found. */
export interface WaitingCost {
  lookup: CostLookup;
  cost?: Cost;
  /** For a reading's call: the usage row it gets once its cost is known (inner#1743). */
  recordAs?: RecordAs;
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
 * Price a finished run: what is known in credits, what is pending kept for the wait. A cost no upstream can name
 * counts as nothing.
 * @param taskId - The task, for the log.
 * @param costs - What each billed answer of the run cost.
 * @returns The credits of what is known, and the costs still pending.
 */
export function pricedCosts(taskId: string, costs: readonly Cost[]): { credits: number; pending: PendingCost[] } {
  let usd = 0;
  const pending: PendingCost[] = [];
  for (const cost of costs) {
    if (cost.state === "known") usd += cost.usd;
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
 * Look up every cost not yet answered.
 * @param pending - The costs waited on.
 * @param lastAttempt - Whether no later lookup follows; a cost still unanswered then is missing.
 * @returns The costs with what this lookup found.
 */
export async function lookUp(pending: readonly WaitingCost[], lastAttempt: boolean): Promise<WaitingCost[]> {
  const found: WaitingCost[] = [];
  for (const entry of pending) {
    if (entry.cost !== undefined && entry.cost.state !== "pending") found.push(entry);
    else found.push({ ...entry, cost: await provider().cost.lookup(entry.lookup, { lastAttempt }) });
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
 * What the task is billed: what was known when it finished and what the lookups found. A cost never answered
 * counts as nothing.
 * @param taskId - The task, for the log.
 * @param wait - The wait.
 * @param pending - The costs and what their lookups found.
 * @returns The credits.
 */
export function billedCredits(taskId: string, wait: CostWait, pending: readonly WaitingCost[]): number {
  let usd = 0;
  for (const { lookup, cost } of pending) {
    if (cost?.state === "known") usd += cost.usd;
    else logger.warn({ taskId, upstream: lookup.upstream, reason: cost?.state === "missing" ? cost.reason : "never answered" }, "cost_unavailable");
  }
  return wait.credits + creditsFor(usd);
}
