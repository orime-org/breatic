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
  const query =
    options.params === undefined
      ? ""
      : `?${new URLSearchParams(options.params).toString()}`;
  const pollUrl = `${url}${query}`;

  // Measured on the clock, not by summing intervals. Adding up only the
  // sleeps let a slow vendor extend the deadline for free — with 10-second
  // responses and a 3-second interval, a nominal 5-minute budget ran past
  // 20 minutes, so the number in the config meant nothing.
  const deadline = Date.now() + options.maxWaitMs;

  while (Date.now() < deadline) {
    // The caller may have cancelled while the previous interval elapsed.
    // Checking here rather than only inside the request matters because a
    // vendor poll can be a billed call: waking up from the sleep and firing
    // one more request for a task nobody is waiting for costs real money,
    // and the transport would only notice the abort after sending it.
    if (options.signal?.aborted === true) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error(`${label} poll cancelled by caller`);
    }

    const response = await httpRequestJson(
      pollUrl,
      { method: "GET", headers: options.headers },
      {
        // A status query carries no side effects, so a flaky poll is always
        // safe for the transport to replay.
        replaySafe: true,
        timeoutMs: options.timeoutMs,
        onEvent: options.onEvent,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        sleepImpl: options.sleepImpl,
        label,
      },
    );

    const status = String(extractNested(response, options.statusPath, "unknown"));

    if (options.successStatuses.has(status)) {
      return response;
    }

    if (options.failureStatuses.has(status)) {
      const error =
        options.errorPath === undefined
          ? "unknown"
          : String(extractNested(response, options.errorPath, "unknown"));
      options.onEvent?.({ type: "poll_failed", label, url: redactUrl(pollUrl), status, error });
      throw new Error(`${label} task failed: ${error}`);
    }

    await doSleep(options.intervalMs, options.signal);
  }

  options.onEvent?.({
    type: "poll_timeout",
    label,
    url: redactUrl(pollUrl),
    maxWaitMs: options.maxWaitMs,
  });
  throw new Error(
    `${label} task did not complete within ${options.maxWaitMs / 1000}s`,
  );
}
