// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The loop that drains a transactional outbox (inner#1993 §5.2), shared by
 * the project-lifecycle outbox and both billing outboxes. The outbox's own
 * repository does the row work in `forwardNext`: claim the next due row in a
 * transaction of its own (`FOR UPDATE SKIP LOCKED`, so instances never send
 * the same row), send it, then mark it sent, record the failure, or move it to
 * dead letters. This loop only decides when to call it.
 *
 * Self-scheduling: the next pass is queued only after this one settles, so a
 * slow pass never overlaps itself. A pass ends when the outbox has nothing
 * due or the batch is used up. A failed forward ends it too, unless the
 * outbox sets `continueAfterRetry`: its failed rows are pushed into backoff,
 * so the claim skips them and the pass goes on to other aggregates' rows; an
 * outbox without backoff would take the same row again and ends the pass.
 * Core does not log; every failure is reported to the caller.
 *
 * Wake and poll: a process that has just committed a row calls `wake()`, which
 * starts a pass at once (or, when one is running, one more right after it);
 * the interval is the fallback that picks up retries that came due and rows
 * other processes wrote. Both run the same claim, so no row is sent twice.
 */

/** What one `forwardNext` call did. */
export interface RelayForward {
  /** The row it took. */
  id: string;
  /** Why sending failed; absent when the row was sent. */
  error?: unknown;
  /** True when the failure moved the row to dead letters, so the pass goes on. */
  deadLettered?: boolean;
}

/** What the loop tells its service to log. */
export type RelayLoopEvent =
  | { kind: "forward_failed"; id: string; err: unknown }
  | { kind: "dead_lettered"; id: string; err: unknown }
  | { kind: "pass_failed"; err: unknown };

/** What a service hands {@link startRelayLoop}. */
export interface RelayLoopDeps {
  /** Take and send the next due row, or answer null when none is due. */
  forwardNext: () => Promise<RelayForward | null>;
  /** The wait between one pass settling and the next starting. */
  intervalMs: number;
  /** The most rows one pass forwards. */
  batchSize: number;
  /** Log one event. */
  report: (event: RelayLoopEvent) => void;
  /**
   * Go on to the next due row after a failed forward instead of ending the
   * pass. Set it only when `forwardNext` puts a failed row into backoff, so
   * the next claim cannot take it again; absent or false ends the pass.
   */
  continueAfterRetry?: boolean;
}

/** Handle to stop the loop on shutdown. */
export interface RelayLoop {
  /** Schedule no further pass; a pass in flight finishes its current row. */
  stop(): void;
  /** Run a pass now, or right after the running one; nothing after `stop()`. */
  wake(): void;
}

/**
 * Start draining an outbox; the first pass runs at once.
 * @param deps - The row work, the timing and the log sink.
 * @returns A handle whose `stop()` ends the loop and whose `wake()` runs a pass now.
 */
export function startRelayLoop(deps: RelayLoopDeps): RelayLoop {
  let stopped = false;
  let running = false;
  let wokenDuringPass = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** One pass, then the next one: at once when woken meanwhile, else after the interval. */
  async function pass(): Promise<void> {
    if (stopped) return;
    running = true;
    wokenDuringPass = false;
    try {
      for (let i = 0; i < deps.batchSize && !stopped; i++) {
        const forwarded = await deps.forwardNext();
        if (forwarded === null) break;
        if (forwarded.error === undefined) continue;
        if (forwarded.deadLettered === true) {
          deps.report({ kind: "dead_lettered", id: forwarded.id, err: forwarded.error });
          continue;
        }
        deps.report({ kind: "forward_failed", id: forwarded.id, err: forwarded.error });
        if (deps.continueAfterRetry !== true) break;
      }
    } catch (err) {
      deps.report({ kind: "pass_failed", err });
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void pass(), wokenDuringPass ? 0 : deps.intervalMs);
    }
  }

  void pass();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    wake(): void {
      if (stopped) return;
      if (running) {
        wokenDuringPass = true;
        return;
      }
      if (timer) clearTimeout(timer);
      void pass();
    },
  };
}
