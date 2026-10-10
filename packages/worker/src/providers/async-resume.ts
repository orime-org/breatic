// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Async submit/resume core (#1628, #1625 ⑦ resilience).
 *
 * Long-running vendor generation (video / async image / async audio / 3D) is a
 * "submit → get task id → ask about it" flow, and the job is picked up many
 * times: once per question, and again on a retry. Re-submitting on any of
 * those pickups creates a SECOND (duplicate, billed) vendor task. This helper
 * makes the submit at-most-once: persist the vendor task id right after
 * submit, and on every later pickup ask about the stored id instead.
 */

import { logger } from "@breatic/core";

/** Injected steps of one async generation, so the flow is unit-testable. */
export interface SubmitOrResumeOptions<T> {
  /** The vendor task id already persisted for this task, or null on first run. */
  storedTaskId: string | null;
  /** Whether this pickup starts a retry: a submit now may be the upstream's second. */
  retryStarting: boolean;
  /** What the submit is, for the log line. */
  label: string;
  /** Submit the generation to the vendor; resolves to the vendor's task id. */
  submit: () => Promise<string>;
  /** Persist the vendor task id BEFORE the first question, so a later pickup asks about it. */
  persistId: (id: string) => Promise<void>;
  /** Ask about the vendor task by id. */
  poll: (id: string) => Promise<T>;
}

/**
 * Run an async generation with at-most-once submit.
 *
 * First pickup (`storedTaskId` null): submit, persist the returned id, then ask.
 * Later pickup (`storedTaskId` present): skip submit + persist, ask about the
 * stored id — the core ⑦ invariant that prevents duplicate vendor generation.
 * @param opts - The injected submit / persist / poll steps + the stored id.
 * @returns What `poll` answered.
 * @throws {Error} Propagates from `submit` (→ BullMQ retries), `persistId`, or `poll`
 *   (a still-going answer sends the job back to the queue).
 */
export async function submitOrResume<T>(
  opts: SubmitOrResumeOptions<T>,
): Promise<T> {
  let taskId = opts.storedTaskId;
  if (taskId === null) {
    // #1628 monitoring: the attempt before this one may have reached the
    // upstream and never stored the id, so this submit is a POTENTIAL
    // duplicate external cost. Feeds the duplicate-cost alarm trend.
    if (opts.retryStarting) logger.warn({ submit: opts.label }, "provider_reinvoked_on_retry_potential_duplicate_cost");
    taskId = await opts.submit();
    await opts.persistId(taskId);
  }
  return opts.poll(taskId);
}
