// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { miniToolConsumptionRecordSchema } from "@domain/mini-tool/consumption.types.js";
import type { UpstreamStep } from "@domain/task/upstreamStep.repo.js";

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
    at = at === null ? now : Math.min(at, now);
  }
  return { at, pendingKeys };
}
