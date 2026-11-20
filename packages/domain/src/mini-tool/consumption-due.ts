// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { miniToolConsumptionRecordSchema, type MiniToolConsumptionRecord } from "@domain/mini-tool/consumption.types.js";
import type { UpstreamStep } from "@domain/task/upstreamStep.repo.js";

/**
 * When an unrecorded consumption is next due (inner#1306 execution design §11.4 lookup row): a model step's pending
 * consumption at its next lookup; a known one, and every container one, at once. Nothing is due before `now`, so a
 * retry scheduled after an overdue lookup failed waits its delay instead of coming back at once.
 * @param consumption - The consumption.
 * @param now - The clock, in epoch milliseconds: the present, or the retry time of a deferred cycle.
 * @returns Epoch milliseconds.
 */
export function consumptionDueAt(consumption: MiniToolConsumptionRecord, now: number): number {
  return consumption.identity.kind === "provider" && consumption.state === "pending" ? Math.max(consumption.nextLookupAt ?? now, now) : now;
}

/**
 * The task's unrecorded consumptions, the earliest due time among them and their keys.
 * @param steps - The task's steps.
 * @param now - The clock, in epoch milliseconds.
 * @returns The earliest due time (null when every consumption is recorded) and the unrecorded keys in step order.
 * @throws {z.ZodError} When a stored consumption is malformed.
 */
export function nextSettlementDue(steps: readonly UpstreamStep[], now: number): { at: number | null; pendingKeys: string[] } {
  let at: number | null = null;
  const pendingKeys: string[] = [];
  for (const step of steps) {
    if (step.output.miniToolConsumption === undefined) continue;
    const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    if (consumption.state === "recorded") continue;
    pendingKeys.push(consumption.consumptionKey);
    const due = consumptionDueAt(consumption, now);
    at = at === null ? due : Math.min(at, due);
  }
  return { at, pendingKeys };
}

/**
 * Whether a model step is unresolved (§11.2 unresolved row): it holds a ticket or a send mark and has not ended. Its
 * bill cannot close while it is; a run's end abandons it.
 * @param step - The step.
 * @returns True while unresolved.
 */
export function isUnresolvedModelStep(step: UpstreamStep): boolean {
  if (step.kind !== "generate" || modelStepEnded(step)) return false;
  return step.output.providerTicket !== undefined || step.output.providerSendingAt !== undefined;
}

/**
 * Whether a model step has ended: done or failed, or returned (its upstream answered and its end is recorded).
 * @param step - The step.
 * @returns True once ended.
 */
export function modelStepEnded(step: UpstreamStep): boolean {
  return step.status === "done" || step.status === "failed" || step.output.providerReturn !== undefined || step.output.miniToolConsumption !== undefined;
}
