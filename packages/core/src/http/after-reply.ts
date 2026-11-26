// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Work a shutdown must wait for before it closes the pools (#286): mostly work
 * a route starts after deciding its reply and does not wait for, and an Agent
 * chat run, whose opening stage the route does wait for (inner#1717).
 *
 * Forgot-password must answer the same thing at the same speed whether or not
 * the address is registered, so the lookup, the token and the send all run
 * here, after the reply; so do the refund mails and reports. Shutdown waits
 * for what is still running (`settleAfterReply`) before closing the pools this
 * work needs, and logs whatever the deadline cut off (`pendingAfterReply`).
 */

/** What a service hands {@link createAfterReply}. */
export interface AfterReplyDeps {
  /** Log one piece of work that failed, with the context it was started with. */
  onFailed: (err: unknown, ctx: Record<string, unknown>) => void;
}

/** The after-reply work of one service. */
export interface AfterReply {
  runAfterReply: (ctx: Record<string, unknown>, work: () => Promise<void>) => void;
  settleAfterReply: () => Promise<void>;
  pendingAfterReply: () => ReadonlyArray<Record<string, unknown>>;
}

/**
 * Build a service's after-reply work list; a service builds one, so shutdown
 * waits for everything it started.
 * @param deps - The failure log.
 * @returns `runAfterReply`, `settleAfterReply` and `pendingAfterReply`.
 */
export function createAfterReply(deps: AfterReplyDeps): AfterReply {
  /** Log context of each piece of work still running. */
  const running = new Map<Promise<void>, Record<string, unknown>>();

  /**
   * Start work the caller does not wait for. A failure is reported with `ctx`;
   * it never becomes an unhandled rejection.
   * @param ctx - Log context naming the work (e.g. `{ task, email }`).
   * @param work - The work to run.
   */
  function runAfterReply(
    ctx: Record<string, unknown>,
    work: () => Promise<void>,
  ): void {
    const done: Promise<void> = Promise.resolve()
      .then(work)
      .catch((err: unknown) => {
        deps.onFailed(err, ctx);
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
  async function settleAfterReply(): Promise<void> {
    while (running.size > 0) {
      await Promise.all(running.keys());
    }
  }

  /**
   * List the work still running, by its log context.
   * @returns One context per running piece of work.
   */
  function pendingAfterReply(): ReadonlyArray<Record<string, unknown>> {
    return [...running.values()];
  }

  return { runAfterReply, settleAfterReply, pendingAfterReply };
}
