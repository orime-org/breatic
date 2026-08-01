// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Poll an asynchronous task endpoint until it reports a terminal status.
 *
 * Every asynchronous AIGC generation goes through here: submit returns a
 * vendor task id, then this loop asks "done yet?" on an interval. The loop
 * itself carries no vendor knowledge — which field holds the status and
 * which values are terminal are declared by the caller, which is what lets
 * one implementation serve a dozen vendors.
 *
 * Each poll is a plain GET, so it is inherently replay-safe and the
 * transport beneath may retry a flaky one without the caller thinking
 * about it.
 */

import { sleep } from "@shared/sleep.js";
import { shieldCaller } from "@shared/http/caller-callback.js";
import { abortReason, withDeadline } from "@shared/http/cancellation.js";
import { POLL_TRANSIENT_FAILURES_TOLERATED } from "@shared/http/constants.js";
import { extractNested } from "@shared/http/json-path.js";
import { redactUrl } from "@shared/http/redact-url.js";
import { httpRequestJson, type HttpRetryEvent } from "@shared/http/request.js";

/** Terminal outcomes worth reporting to the application layer's logger. */
export type PollEvent =
  | {
      type: "poll_failed";
      label: string;
      url: string;
      /** The terminal status the vendor reported. */
      status: string;
      /** The vendor's error text, or "unknown" when none was declared. */
      error: string;
    }
  | {
      type: "poll_timeout";
      label: string;
      url: string;
      maxWaitMs: number;
    };

/** How to poll one vendor's task endpoint. */
export interface PollOptions {
  /** Headers sent on every poll (typically bearer auth). */
  headers?: Record<string, string>;
  /** Query parameters appended to the poll URL. */
  params?: Record<string, string>;
  /**
   * Caller-owned fact: delivering one poll again produces no additional side
   * effects.
   *
   * Required, and deliberately not defaulted. The loop used to hardcode
   * `true` on the grounds that "each poll is a plain GET" — the exact
   * inference the transport forbids, and one this file contradicted thirteen
   * lines from where it made it: a vendor poll can be a billed call. Whether
   * a given vendor bills per status query is knowledge only its caller has.
   */
  replaySafe: boolean;
  /** Key path to the status field, e.g. `["data", "status"]`. */
  statusPath: string[];
  /** Status values meaning the task finished successfully. */
  successStatuses: ReadonlySet<string>;
  /** Status values meaning the task failed terminally. */
  failureStatuses: ReadonlySet<string>;
  /** Key path to the vendor's error message, when it provides one. */
  errorPath?: string[];
  /** Wait between polls. */
  intervalMs: number;
  /** Total budget across all polls, measured on the clock. */
  maxWaitMs: number;
  /** Per-poll request timeout, so one silent vendor cannot stall the loop. */
  timeoutMs: number;
  /** Sink for poll and transport telemetry; this layer never logs. */
  onEvent?: (event: PollEvent | HttpRetryEvent) => void;
  /** Replacement fetch, forwarded to the transport. */
  fetchImpl?: typeof fetch;
  /** Caller cancellation, forwarded to the transport. */
  signal?: AbortSignal;
  /** Vendor name, for telemetry and error messages. */
  label?: string;
  /**
   * Replacement for both waits — between polls here, and between retries
   * inside the transport. FOR TESTS ONLY; production leaves it unset.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Poll until the task reaches a terminal status, or the budget is spent.
 * @param url - The task-status endpoint.
 * @param options - Status vocabulary, timing budget, and hooks.
 * @returns The full response body of the successful poll.
 * @throws {Error} When the vendor reports a failure status, when the
 *   budget elapses, or when the caller cancels.
 */
export async function pollUntilDone(
  url: string,
  options: PollOptions,
): Promise<Record<string, unknown>> {
  const label = options.label ?? "provider";
  const doSleep = options.sleepImpl ?? sleep;

  /**
   * Report what the loop saw without letting the sink change it.
   *
   * Both emissions below are followed immediately by a `throw`, so an
   * unshielded sink that failed replaced the vendor's own terminal error — or
   * the budget-exhausted one — with its own. The caller was then told its
   * logger is broken, on a path whose entire purpose is to tell it why the
   * generation failed.
   * @param event - What the loop just observed.
   */
  const emit = (event: PollEvent): void => {
    shieldCaller(() => options.onEvent?.(event), undefined);
  };
  // Merged, not concatenated. `${url}?${params}` produced "...?a=1?b=2" for a
  // status URL that already carried a query — and these URLs come back from
  // the vendor, so whether one does is not ours to decide.
  const pollUrl = ((): string => {
    if (options.params === undefined) return url;
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(options.params)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.href;
  })();

  // Measured on the clock, not by summing intervals. Adding up only the
  // sleeps let a slow vendor extend the deadline for free — with 10-second
  // responses and a 3-second interval, a nominal 5-minute budget ran past
  // 20 minutes, so the number in the config meant nothing.
  const deadline = Date.now() + options.maxWaitMs;
  /**
   * What to say when the budget is what ended this.
   *
   * One wording for both exits — the deadline that fires inside a poll, and
   * the loop finding no time left before starting another — because to the
   * caller they are the same outcome.
   * @returns The message.
   */
  const budgetSpent = (): string =>
    `${label} task did not complete within ${options.maxWaitMs / 1000}s`;
  let consecutiveFailures = 0;

  for (;;) {
    // Remaining budget, recomputed each turn. One iteration is NOT one
    // request: the transport delivers up to three attempts with backoff
    // between them, so a check only at the top of the loop let a vendor that
    // went quiet drag the call a whole transport cycle past the figure the
    // caller was promised. Measured before the fix: 2730ms against a 20ms
    // budget.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // The caller may have cancelled while the previous interval elapsed.
    // Checking here rather than only inside the request matters because a
    // vendor poll can be a billed call: waking up from the sleep and firing
    // one more request for a task nobody is waiting for costs real money,
    // and the transport would only notice the abort after sending it.
    if (options.signal?.aborted === true) {
      throw abortReason(options.signal, `${label} poll cancelled by caller`);
    }

    // The budget covers this whole poll — every attempt the transport makes
    // and every backoff between them — not just the one request underneath.
    const budget = withDeadline(options.signal, remaining, budgetSpent());
    let response: Record<string, unknown>;
    try {
      response = await httpRequestJson(
        pollUrl,
        { method: "GET", headers: options.headers },
        {
          replaySafe: options.replaySafe,
          timeoutMs: Math.min(options.timeoutMs, remaining),
          onEvent: options.onEvent,
          fetchImpl: options.fetchImpl,
          signal: budget.signal,
          sleepImpl: options.sleepImpl,
          label,
        },
      );
    } catch (error) {
      if (budget.expired()) break;
      // A vendor's status endpoint has a read-after-write window: the task id
      // submit just returned is briefly invisible there. The transport is
      // right to refuse to replay that 404 — it is a real client error for
      // that one request — but abandoning an already-paid generation over it
      // is not. Tolerance is bounded and consecutive, so a vendor that is
      // genuinely gone still fails, with what it actually said.
      //
      // Tolerating a failure means sending the request again, so the caller's
      // replay declaration governs this too: a vendor that bills per status
      // query gets no second chances here either. Without that, `replaySafe:
      // false` would stop the transport replaying while this loop quietly
      // replayed anyway — the declaration honoured at one layer and ignored
      // at the one above it.
      consecutiveFailures += 1;
      const tolerated = options.replaySafe ? POLL_TRANSIENT_FAILURES_TOLERATED : 0;
      if (consecutiveFailures > tolerated) throw error;
      await doSleep(options.intervalMs, options.signal);
      continue;
    } finally {
      budget.dispose();
    }
    consecutiveFailures = 0;

    const status = String(extractNested(response, options.statusPath, "unknown"));

    if (options.successStatuses.has(status)) {
      return response;
    }

    if (options.failureStatuses.has(status)) {
      const error =
        options.errorPath === undefined
          ? "unknown"
          : String(extractNested(response, options.errorPath, "unknown"));
      emit({ type: "poll_failed", label, url: redactUrl(pollUrl), status, error });
      throw new Error(`${label} task failed: ${error}`);
    }

    await doSleep(options.intervalMs, options.signal);
  }

  emit({
    type: "poll_timeout",
    label,
    url: redactUrl(pollUrl),
    maxWaitMs: options.maxWaitMs,
  });
  throw new Error(
    `${label} task did not complete within ${options.maxWaitMs / 1000}s`,
  );
}
