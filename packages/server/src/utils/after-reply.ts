// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Work a route starts after deciding its reply and does not wait for (#286).
 *
 * Forgot-password is the one user: it must answer the same thing at the same
 * speed whether or not the address is registered, so the lookup, the token and
 * the send all run here, after the reply. Shutdown waits for what is still
 * running (`settleAfterReply`) before closing the pools this work needs, and
 * logs whatever the deadline cut off (`pendingAfterReply`).
 */

import { logger } from "@breatic/core";

/** Log context of each piece of work still running. */
const running = new Map<Promise<void>, Record<string, unknown>>();

/**
 * Start work the caller does not wait for. A failure is logged with `ctx`;
 * it never becomes an unhandled rejection.
 * @param ctx - Log context naming the work (e.g. `{ task, email }`).
 * @param work - The work to run.
 */
export function runAfterReply(
  ctx: Record<string, unknown>,
  work: () => Promise<void>,
): void {
  const done: Promise<void> = Promise.resolve()
    .then(work)
    .catch((err: unknown) => {
      logger.error({ err, ...ctx }, "after_reply_failed");
    })
    .finally(() => {
      running.delete(done);
    });
  running.set(done, ctx);
}

/**
 * Wait until no work started by {@link runAfterReply} is still running,
 * including work started while waiting.
 * @returns Resolves once nothing is running.
 */
export async function settleAfterReply(): Promise<void> {
  while (running.size > 0) {
    await Promise.all(running.keys());
  }
}

/**
 * List the work still running, by its log context.
 * @returns One context per running piece of work.
 */
export function pendingAfterReply(): ReadonlyArray<Record<string, unknown>> {
  return [...running.values()];
}
