// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The knock a timer sends when a task's time is up (#186 design §4.6).
 *
 * One field, and it lives here for the same reason the upload ticket does:
 * the two runtimes on either side of it share no code and no test. The timer
 * is a Durable Object tested inside workerd against a stubbed server; the
 * route is a hono handler tested in Node against a hand-written body. Each
 * suite can be green on a name the other one never uses, and the failure that
 * produces has no symptom either side can see — the route answers 4xx, the
 * alarm reads that as the server being unwell, re-arms, and no task is ever
 * judged dead.
 *
 * So the field name is written once, and both sides go through the two
 * functions below rather than spelling it.
 */

/** What the timer POSTs. Snake case, like every other body our server takes. */
export interface TaskExpiryKnock {
  task_id: string;
}

/**
 * Build the knock for one task.
 * @param taskId - The task whose deadline passed.
 * @returns The body to send.
 */
export function taskExpiryKnock(taskId: string): TaskExpiryKnock {
  return { task_id: taskId };
}

/**
 * Read a knock's task id back.
 * @param body - A parsed request body of unknown shape.
 * @returns The task id, or null when this is not a knock.
 */
export function readTaskExpiryKnock(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>).task_id;
  return typeof value === "string" ? value : null;
}
