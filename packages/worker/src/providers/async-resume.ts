// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Async submit/resume core (#1628, #1625 ⑦ resilience).
 *
 * Long-running vendor generation (video / async image / async audio / 3D) is a
 * "submit → get task id → poll" flow. On a BullMQ whole-job retry, blindly
 * re-submitting creates a SECOND (duplicate, billed) vendor task. This helper
 * makes the submit at-most-once: persist the vendor task id right after submit,
 * and on retry resume by polling the stored id instead of re-submitting.
 */

/** Injected steps of one async generation, so the flow is unit-testable. */
export interface SubmitOrResumeOptions<T> {
  /** The vendor task id already persisted for this task, or null on first run. */
  storedTaskId: string | null;
  /** Submit the generation to the vendor; resolves to the vendor's task id. */
  submit: () => Promise<string>;
  /** Persist the vendor task id BEFORE polling, so a retry can resume by it. */
  persistId: (id: string) => Promise<void>;
  /** Poll the vendor task to completion by id. */
  poll: (id: string) => Promise<T>;
}

/**
 * Run an async generation with at-most-once submit.
 *
 * First run (`storedTaskId` null): submit, persist the returned id, then poll.
 * Retry (`storedTaskId` present): skip submit + persist, poll the stored id —
 * the core ⑦ invariant that prevents duplicate vendor generation.
 * @param opts - The injected submit / persist / poll steps + the stored id.
 * @returns The poll result once the vendor task reaches a terminal state.
 * @throws Propagates from `submit` (→ BullMQ retries), `persistId`, or `poll`.
 */
export async function submitOrResume<T>(
  opts: SubmitOrResumeOptions<T>,
): Promise<T> {
  let taskId = opts.storedTaskId;
  if (taskId === null) {
    taskId = await opts.submit();
    await opts.persistId(taskId);
  }
  return opts.poll(taskId);
}
