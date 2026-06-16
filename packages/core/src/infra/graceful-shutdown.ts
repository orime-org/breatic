// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Dependencies for {@link runGracefulShutdown}. */
export interface GracefulShutdownDeps {
  /**
   * Close the main listen socket immediately so a restart / rolling deploy can
   * rebind the port without waiting behind the drains below. No-op for a
   * service with no main listen socket (e.g. a queue worker).
   */
  releaseListenSocket: () => void;
  /** Remaining teardowns, drained concurrently after the socket is released. */
  drains: ReadonlyArray<() => Promise<unknown>>;
  /** Overall deadline (ms); resolves once drained OR the deadline hits. */
  deadlineMs: number;
}

/**
 * One graceful-shutdown shape shared by every long-running service (server /
 * worker / collab): release the main listen socket FIRST, then drain the rest
 * concurrently under an overall deadline.
 *
 * Why this shape (2026-06-16, ADR `2026-06-16-service-listen-error-graceful-shutdown`
 * + memory `feedback_dev_collab_long_running_drift`): the services used to
 * hand-roll inconsistent shutdowns — server didn't await its main close (so it
 * never drained in-flight HTTP), worker drained, and collab awaited 6 teardowns
 * sequentially with the WS server closed LAST. On a dev `tsx watch` restart the
 * latter held collab's port (:1234) past the 5s grace window → the new process
 * hit `EADDRINUSE` and crashed. Releasing the listen socket up front frees the
 * port immediately; the deadline guarantees a stuck teardown (e.g. a hung Redis
 * quit) can't hold the process past the window; concurrent best-effort drains
 * mean one throwing / hanging teardown never aborts the others or the shutdown.
 * @param deps - Listen-socket release, the concurrent drains, and the deadline.
 * @returns Resolves once every drain settles or the deadline elapses.
 */
export async function runGracefulShutdown(
  deps: GracefulShutdownDeps,
): Promise<void> {
  try {
    deps.releaseListenSocket();
  } catch {
    // Best-effort: a release error (e.g. socket already closing) must not
    // block the drains below.
  }
  const drain = Promise.allSettled(
    deps.drains.map((d) => Promise.resolve().then(d)),
  );
  await Promise.race([
    drain,
    new Promise<void>((resolve) => {
      setTimeout(resolve, deps.deadlineMs).unref();
    }),
  ]);
}
