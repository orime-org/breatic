// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Relaying a region's outbox to the global region (inner#1955): unsent events
 * in id order, each confirmed before it is marked sent. A transient failure
 * stops the relay without skipping anything; an event the global region can
 * never apply is set aside so the ones after it still flow.
 */

import { getRegionsConfig, regionOutboxRepo } from "@breatic/core";

/** An event as it travels to the global region. */
export interface OutboxEvent {
  /** The outbox id, as text: ids are a bigint sequence. */
  id: string;
  aggregateKey: string;
  type: string;
  payload: unknown;
}

/**
 * Sends one event to the global region. Throwing means a transient failure.
 * @returns `applied`, `duplicate` (applied before), or `permanent_failure`.
 */
export type Deliver = (event: OutboxEvent) => Promise<"applied" | "duplicate" | "permanent_failure">;

/** How one relay pass ended. */
export interface RelayResult {
  delivered: number;
  deadLettered: number;
  /** The transient failure that stopped the pass, if one did. */
  stoppedBy?: unknown;
}

/**
 * Send the unsent events, oldest first, until none are left or one fails.
 * @param options - How to deliver.
 * @param options.deliver - Sends one event to the global region.
 * @returns What was delivered, what was set aside, and what stopped the pass.
 */
export async function relayOutbox(options: { deliver: Deliver }): Promise<RelayResult> {
  const result: RelayResult = { delivered: 0, deadLettered: 0 };
  for (const row of await regionOutboxRepo.listUnsent(getRegionsConfig().outbox_relay_batch)) {
    let answer: Awaited<ReturnType<Deliver>>;
    try {
      answer = await options.deliver({ id: String(row.id), aggregateKey: row.aggregateKey, type: row.eventType, payload: row.payload });
    } catch (err) {
      result.stoppedBy = err;
      return result;
    }
    if (answer === "permanent_failure") {
      await regionOutboxRepo.deadLetter(row.id, "the global region cannot apply this event");
      result.deadLettered++;
    } else {
      await regionOutboxRepo.markSent(row.id);
      result.delivered++;
    }
  }
  return result;
}
