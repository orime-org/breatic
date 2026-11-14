// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether this server is shutting down, and the runs to stop when it is
 * (inner#1717).
 *
 * A run no longer ends with the request that started it, so a deploy that
 * stops the process stops its runs on purpose: each is recorded as failed
 * with reason `shutdown`, and no run starts once the flag is up. The work that
 * was waiting stays queued for the next instance's sync.
 */

/** The reason a run's signal carries when the server stopped it. */
export class ShutdownAbort extends Error {
  /** Make the reason. */
  constructor() {
    super("The server is shutting down.");
    this.name = "ShutdownAbort";
  }
}

let shuttingDown = false;
const runs = new Set<AbortController>();

/**
 * Put the flag up and stop every run in progress.
 */
export function markShuttingDown(): void {
  shuttingDown = true;
  for (const run of runs) run.abort(new ShutdownAbort());
}

/**
 * Whether the server is shutting down.
 * @returns True once the flag is up.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Hold a run's stop, so a shutdown can stop it.
 * @param controller - The run's own stop.
 * @returns Lets the run go again.
 */
export function trackRun(controller: AbortController): () => void {
  runs.add(controller);
  if (shuttingDown) controller.abort(new ShutdownAbort());
  return () => {
    runs.delete(controller);
  };
}

/**
 * Whether a signal was raised by a shutdown.
 * @param signal - A run's signal.
 * @returns True when the server stopped it.
 */
export function stoppedByShutdown(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof ShutdownAbort;
}

/**
 * Take the flag down again; tests only.
 */
export function resetShutdownFlagForTests(): void {
  shuttingDown = false;
  runs.clear();
}
