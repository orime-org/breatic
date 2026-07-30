// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one HTTP transport with retries, shared by the backend services and
 * the browser.
 *
 * Before this existed the same concern was implemented three times with
 * three different verdicts: the worker retried only 429 (so a dropped
 * connection was fatal), the browser upload retried 5xx/429/network, and
 * the agent's tools retried nothing at all. Judgement now lives in exactly
 * one place — {@link decideRetry} — and every caller states the one fact
 * only it can know: whether replaying its request is free of side effects.
 *
 * Written directly against `fetch` rather than on a retry client. That was
 * measured, not assumed: hosting this design on ky 2.0.2 required working
 * around five of its defaults (disabling its HTTP-error throwing also
 * disabled retrying; its method whitelist gated the retry predicate rather
 * than deferring to it; `Retry-After` was dropped once the predicate took
 * over; the predicate was not consulted on the final attempt so exhaustion
 * could not be reported; and it consumed a failing response's body, which
 * erased the vendor error text the worker puts in its logs). The probes
 * are kept at `engineering/demo/2026-07-30-ky-retry-behaviour-probe*.mjs`.
 * The loop below is what those five workarounds were emulating.
 */

import {
  decideRetry,
  type RetryRefusal,
  type RetryTrigger,
  type TransportErrorKind,
} from "@shared/http/decide-retry.js";

/** What happened on one attempt, for the application layer to log. */
export type HttpRetryEvent =
  | {
      type: "retry";
      label: string;
      url: string;
      attempt: number;
      delayMs: number;
      reason: RetryTrigger;
      status?: number;
    }
  | {
      type: "exhausted";
      label: string;
      url: string;
      attempts: number;
      reason: RetryRefusal;
      status?: number;
    };

/** Per-call inputs. Retry COUNT is fixed in constants and absent here. */
export interface HttpRequestOptions {
  /**
   * Whether delivering this exact request a second time produces no
   * additional side effects. The CALLER owns this fact — the transport
   * cannot infer it.
   *
   * This is a statement of fact about the endpoint, NOT a retry
   * preference: answer it about what a second delivery would do, not about
   * how badly the call should succeed. An AIGC submit without a vendor
   * idempotency key is `false` (a replay bills a second generation); the
   * same submit carrying one is `true`; any poll or read is `true`.
   */
  replaySafe: boolean;
  /**
   * Per-attempt timeout in milliseconds. Stays a parameter because it
   * genuinely varies — vendor latencies differ by an order of magnitude
   * and an upload's stall guard scales with file size.
   */
  timeoutMs: number;
  /**
   * Sink for retry telemetry. This layer never logs (library packages must
   * not), so the application layer routes these to its logger.
   */
  onEvent?: (event: HttpRetryEvent) => void;
  /**
   * Replacement fetch. The agent's tools pass an SSRF-guarding
   * implementation; retrying above it means every replay is re-checked,
   * which retrying inside a connection pool would not do.
   */
  fetchImpl?: typeof fetch;
  /**
   * Caller cancellation (a user pressed stop). Never retried. Passed here
   * rather than on `init`, because each attempt needs its own composed
   * signal and anything on `init.signal` would be overwritten.
   */
  signal?: AbortSignal;
  /**
   * Identify a deterministic failure from `fetchImpl` — one a replay could
   * never fix — so the budget is not spent hitting the same wall.
   *
   * Only the caller can classify this, because only it knows what its own
   * fetch implementation throws. The agent's SSRF guard is the motivating
   * case: a blocked address is blocked on every attempt.
   */
  isFatal?: (error: unknown) => boolean;
  /** Provider or tool name, for telemetry. */
  label?: string;
}

/** One attempt's deadline, plus the teardown that must always run. */
interface AttemptDeadline {
  signal: AbortSignal;
  /** True once this attempt's own timeout fired (not a caller abort). */
  timedOut: () => boolean;
  /** Clears the timer and detaches the caller listener. */
  dispose: () => void;
}

/**
 * Build a fresh deadline for one attempt, aborting on either the caller's
 * cancellation or this attempt's own timeout.
 *
 * A new signal per attempt is the whole point. The implementation this
 * replaces let callers pass one `AbortSignal.timeout(...)` into a retry
 * loop; an `AbortSignal` is single-shot, so the first timeout aborted every
 * subsequent attempt before it left the ground. That bug was latent only
 * because timeouts were never retried at all.
 *
 * Composed by hand rather than with `AbortSignal.any` so that "this attempt
 * timed out" is tracked by an explicit flag: the abort reason a `fetch`
 * rejection carries is not a dependable way to tell an attempt timeout
 * apart from a caller cancellation, and the two must not be confused —
 * one is retryable, the other is final.
 * @param callerSignal - The caller's cancellation signal, if any.
 * @param timeoutMs - This attempt's deadline in milliseconds.
 * @returns The composed signal, a timeout probe, and its teardown.
 */
function startAttemptDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AttemptDeadline {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Attempt timed out", "TimeoutError"));
  }, timeoutMs);

  /**
   * Forward the caller's cancellation to this attempt, preserving its reason
   * so the failure surfaces as the caller's own error rather than a generic
   * abort.
   */
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: (): boolean => timedOut,
    dispose: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Classify a thrown fetch failure into {@link decideRetry}'s vocabulary.
 *
 * Keyed on observable state rather than on the error's name or message:
 * the caller's own signal tells us a cancellation, and this attempt's
 * timeout flag tells us a deadline. Everything else is a transport-level
 * failure unless the caller recognises it as deterministic. Error names
 * would be a weaker discriminator — an abort surfaces whatever reason the
 * caller passed to `abort()`, which may be any value.
 * @param error - The error the fetch attempt rejected with.
 * @param callerSignal - The caller's cancellation signal, if any.
 * @param deadline - The deadline object for the attempt that just failed.
 * @param isFatal - The caller's deterministic-failure predicate, if any.
 * @returns The transport-error kind for the predicate.
 */
function classifyThrown(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  deadline: AttemptDeadline,
  isFatal: ((error: unknown) => boolean) | undefined,
): TransportErrorKind {
  if (callerSignal?.aborted === true) return "caller_aborted";
  if (deadline.timedOut()) return "timeout";
  if (isFatal?.(error) === true) return "fatal";
  return "network";
}

/**
 * Sleep between attempts.
 * @param ms - Milliseconds to wait.
 * @returns A promise resolving once the delay elapses.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform an HTTP request, replaying it when — and only when — the
 * caller's declared replay-safety and the failure kind together allow it.
 *
 * Returns the LAST response even when it is not ok: whether an HTTP error
 * counts as a failure is the caller's business decision, not the
 * transport's. The agent's fetch tool needs the status of a 404; the
 * worker's provider transports want an exception. Only a failure that
 * produced no response at all rejects here.
 * @param url - Absolute request URL.
 * @param init - Standard fetch init (method, headers, body). Any `signal`
 *   on it is replaced by this call's per-attempt signal.
 * @param options - Replay-safety fact, per-attempt timeout, and hooks.
 * @returns The final response, ok or not.
 * @throws {Error} When no response was ever obtained — a network failure,
 *   an attempt timeout, or a caller abort — after replays are spent.
 */
export async function httpRequest(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
): Promise<Response> {
  const label = options.label ?? "http";
  const doFetch = options.fetchImpl ?? fetch;

  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  // Unbounded by design: `decideRetry` owns the budget and refuses past
  // MAX_RETRIES, so the exit is the predicate rather than a second counter
  // that could disagree with it.
  for (let index = 0; ; index++) {
    const deadline = startAttemptDeadline(options.signal, options.timeoutMs);
    let status: number | undefined;
    let retryAfter: string | null | undefined;
    let transportError: TransportErrorKind | undefined;

    try {
      const response = await doFetch(url, { ...init, signal: deadline.signal });
      if (response.ok) return response;
      lastResponse = response;
      status = response.status;
      retryAfter = response.headers.get("retry-after");
    } catch (error) {
      lastError = error;
      transportError = classifyThrown(
        error,
        options.signal,
        deadline,
        options.isFatal,
      );
    } finally {
      deadline.dispose();
    }

    const decision = decideRetry({
      status,
      retryAfter,
      transportError,
      replaySafe: options.replaySafe,
      // `index` counts attempts made; the predicate counts the replay
      // being considered, which is one ahead.
      attempt: index + 1,
    });

    options.onEvent?.(
      decision.retry
        ? {
            type: "retry",
            label,
            url,
            attempt: index + 1,
            delayMs: decision.delayMs,
            reason: decision.reason,
            status,
          }
        : {
            type: "exhausted",
            label,
            url,
            attempts: index + 1,
            reason: decision.reason,
            status,
          },
    );

    if (!decision.retry) {
      if (lastResponse !== null) return lastResponse;
      throw lastError instanceof Error
        ? lastError
        : new Error(`${label} request to ${url} failed: ${String(lastError)}`);
    }

    await sleep(decision.delayMs);
  }
}

/**
 * {@link httpRequest} plus JSON parsing, rejecting on a non-ok final
 * status. This is the shape the worker's provider transports expect.
 *
 * The response body is still readable here — nothing consumed it on the
 * way out — so the vendor's error text reaches the message and therefore
 * the logs. That mattered enough to rule out a retry client that read it
 * first: a bare "HTTP 502:" tells an on-call engineer nothing.
 * @param url - Absolute request URL.
 * @param init - Standard fetch init (method, headers, body).
 * @param options - Replay-safety fact, per-attempt timeout, and hooks.
 * @returns The parsed JSON object.
 * @throws {Error} On a non-ok final status (message carries the label,
 *   status and response body), on an unparseable body, or on any failure
 *   that produced no response.
 */
export async function httpRequestJson(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
): Promise<Record<string, unknown>> {
  const label = options.label ?? "http";
  const response = await httpRequest(url, init, options);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} HTTP ${response.status}: ${body}`);
  }

  return (await response.json()) as Record<string, unknown>;
}
