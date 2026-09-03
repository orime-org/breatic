// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reaching the timer that judges a task dead (#186, design §4.6.5).
 *
 * The timer is a Durable Object in the ingest Worker, which has no address
 * of its own outside that Worker, so this is one authenticated HTTP call to
 * a route there.
 *
 * Nothing throws. The caller's question is only ever "is the alarm set?",
 * because opening a task whose deadline nobody holds leaves it with no one
 * to judge it — so every way of not being sure answers the same: no.
 */

import { env } from "@breatic/core";
import { httpRequest } from "@breatic/shared";

/** How long one delivery may take. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * How long the whole call may take, retries included.
 *
 * The transport retries a delivery that failed, and the per-delivery deadline
 * bounds each one rather than the loop. What is waiting at the other end is a
 * browser holding a file it cannot start sending, so the loop gets a ceiling
 * of its own.
 */
const OVERALL_TIMEOUT_MS = 12_000;

/**
 * Ask the ingest Worker to hold a deadline for one task.
 * @param opts - The three things a timer holds, and how long to wait.
 * @param opts.taskId - The task this deadline belongs to.
 * @param opts.deadlineAt - Epoch milliseconds.
 * @param opts.callbackUrl - Where the timer knocks when it passes.
 * @param opts.timeoutMs - How long one delivery may take.
 * @param opts.overallTimeoutMs - How long the whole call may take.
 * @returns True when the Worker took it.
 */
export async function armTaskTimer(opts: {
  taskId: string;
  deadlineAt: number;
  callbackUrl: string;
  timeoutMs?: number;
  overallTimeoutMs?: number;
}): Promise<boolean> {
  if (!env.INGEST_BASE_URL || !env.INGEST_SHARED_SECRET) return false;

  try {
    const response = await httpRequest(
      `${env.INGEST_BASE_URL}/task-timers/arm`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ingest-secret": env.INGEST_SHARED_SECRET,
        },
        body: JSON.stringify({
          taskId: opts.taskId,
          deadlineAt: opts.deadlineAt,
          callbackUrl: opts.callbackUrl,
        }),
      },
      {
        // Arming the same task twice sets the same alarm on the same
        // instance, which is the state it was already in.
        replaySafe: true,
        // The browser is waiting on the ticket this call gates, so a Worker
        // that holds the connection open would hold the upload open with it.
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: AbortSignal.timeout(
          opts.overallTimeoutMs ?? OVERALL_TIMEOUT_MS,
        ),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
