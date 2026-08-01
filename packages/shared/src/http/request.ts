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
 * were run against that library directly, one workaround at a time.
 * The loop below is what those five workarounds were emulating.
 */

import {
  decideRetry,
  type RetryRefusal,
  type RetryTrigger,
  type TransportErrorKind,
} from "@shared/http/decide-retry.js";
import { guardResponseBody, type GuardedResponse } from "@shared/http/body-guard.js";
import { BODY_IDLE_TIMEOUT_MS } from "@shared/http/constants.js";
import { redactUrl } from "@shared/http/redact-url.js";
import { sleep } from "@shared/sleep.js";

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
   * Caller-owned fact: a person is waiting on this request right now.
   *
   * The browser sets it; a worker or a job does not. Like `replaySafe` it
   * describes the caller's situation rather than a preference — and like
   * `replaySafe`, the transport cannot work it out for itself.
   *
   * It decides one thing: how long a server-directed `Retry-After` may be
   * before serving it is worse than failing. Ten seconds with someone
   * watching, sixty without (`constants.ts` carries the reasoning for both
   * figures). Past the limit the request fails and the figure the server
   * asked for comes back with it, so the caller can say what happened
   * instead of leaving a person in front of a spinner.
   */
  interactive?: boolean;
  /**
   * How long one attempt may wait FOR RESPONSE HEADERS, in milliseconds.
   * Stays a parameter because it genuinely varies — vendor latencies differ
   * by an order of magnitude and an upload's stall guard scales with file
   * size.
   *
   * This deadline ends when the headers arrive. Reading the body is a
   * separate wait with its own deadline; see `bodyIdleTimeoutMs`.
   */
  timeoutMs: number;
  /**
   * Maximum silence between body chunks, in milliseconds. Defaults to
   * {@link BODY_IDLE_TIMEOUT_MS}.
   *
   * Idle rather than total, so a slow-but-alive transfer finishes while a
   * connection that flushed headers and went quiet is cut. A total budget
   * cannot serve both: the same number would have to tolerate a 500 MB
   * asset download and catch a stalled 2 KB JSON reply.
   *
   * Separate from `timeoutMs` because the two waits differ by orders of
   * magnitude in the same call — a vendor may take 60s to start answering
   * and then stream steadily, or answer instantly and stall mid-body.
   *
   * Optional, and callers are expected to leave it alone: unlike
   * first-response latency, "how long may a live connection send nothing"
   * does not vary by vendor. It exists as a parameter so tests can drive it
   * without waiting 30 seconds.
   */
  bodyIdleTimeoutMs?: number;
  /**
   * Largest response body this caller will accept, in bytes. Unbounded when
   * absent, which is what every caller that chooses its own URL wants: a
   * vendor reply and a generated video differ by orders of magnitude, and the
   * asset downloads must take whatever the file weighs.
   *
   * Set it where the URL is chosen by someone else. The agent's fetch tool is
   * the case: the model names the host, so the size of the answer is decided
   * by whoever owns it, and truncating afterwards only trims a string that is
   * already in memory.
   */
  maxBodyBytes?: number;
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
  /**
   * Replacement for the between-attempt wait. FOR TESTS ONLY — production
   * callers must leave this unset so every caller backs off identically.
   *
   * The seam belongs here rather than in each caller. Before the retry logic
   * was centralised, the browser upload owned its own wait and injected a
   * fake one in tests; removing that wait without providing this left its
   * suite sleeping through ~10s of real backoff on every run, right next to
   * timing-sensitive assertions. A caller cannot stub a wait it no longer
   * performs, so the layer that performs it has to offer the seam.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** One attempt's deadline, plus the teardown that must always run. */
interface AttemptDeadline {
  signal: AbortSignal;
  /** True once this attempt's own timeout fired (not a caller abort). */
  timedOut: () => boolean;
  /** Clears the timer and detaches the caller listener. */
  dispose: () => void;
  /**
   * Tear down the request itself.
   *
   * Handed to the body guard, which outlives the headers deadline: when a
   * body goes idle, dropping the reader is not enough to release the
   * connection — aborting the request is. Measured: an abort raised after
   * the headers arrived does interrupt an in-flight body read
   * against a real socket.
   */
  abort: () => void;
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
    // Survives dispose() on purpose: dispose only retires the HEADERS
    // deadline, while the request stays live for as long as its body is
    // being read.
    abort: (): void => controller.abort(),
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
 * Perform an HTTP request, replaying it when — and only when — the
 * caller's declared replay-safety and the failure kind together allow it.
 *
 * Returns the LAST response even when it is not ok: whether an HTTP error
 * counts as a failure is the caller's business decision, not the
 * transport's. The agent's fetch tool needs the status of a 404; the
 * worker's provider transports want an exception. Only a failure that
 * produced no response at all rejects here.
 *
 * What comes back is a guarded handle, not the raw response. Handing out a
 * raw one is what let the body deadline be bypassed: its holder can read a
 * body with no deadline at all, and every call site did. The handle exposes
 * the metadata callers use and reads that cannot escape the deadline.
 * @param url - Absolute request URL.
 * @param init - Standard fetch init (method, headers, body). Any `signal`
 *   on it is replaced by this call's per-attempt signal.
 * @param options - Replay-safety fact, both deadlines, and hooks.
 * @returns The final response, ok or not, as a body-guarded handle.
 * @throws {Error} When no response was ever obtained — a network failure,
 *   an attempt timeout, or a caller abort — after replays are spent. Also
 *   when the caller cancels during a backoff wait.
 */
export async function httpRequest(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
): Promise<GuardedResponse> {
  const label = options.label ?? "http";
  const doFetch = options.fetchImpl ?? fetch;
  const doSleep = options.sleepImpl ?? sleep;

  /**
   * Wrap a response so its body is read under the idle deadline.
   * @param response - The response to hand out.
   * @param abortRequest - Teardown for the attempt that produced it.
   * @returns The guarded handle.
   */
  const guard = (response: Response, abortRequest: () => void): GuardedResponse =>
    guardResponseBody({
      response,
      idleTimeoutMs: options.bodyIdleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS,
      callerSignal: options.signal,
      ...(options.maxBodyBytes !== undefined && { maxBytes: options.maxBodyBytes }),
      abortRequest,
      label,
    });

  // Unbounded by design: `decideRetry` owns the budget and refuses past
  // MAX_RETRIES, so the exit is the predicate rather than a second counter
  // that could disagree with it.
  for (let index = 0; ; index++) {
    const deadline = startAttemptDeadline(options.signal, options.timeoutMs);
    let status: number | undefined;
    let retryAfter: string | null | undefined;
    let transportError: TransportErrorKind | undefined;
    // Declared per attempt on purpose. These describe THIS attempt's outcome,
    // and scoping them here is what makes it impossible to report one
    // attempt's result as another's. Hoisted out of the loop, an early non-ok
    // response outlived the attempt that produced it and was handed back as
    // the outcome of a later, response-less failure — a dropped connection
    // surfaced as the vendor's earlier 503, and an SSRF refusal surfaced as an
    // HTTP error. Clearing them by hand would work too, but only for as long
    // as everyone remembers to.
    let response: Response | null = null;
    let abortRequest: (() => void) | null = null;
    let failure: unknown = null;

    try {
      const attempted = await doFetch(url, { ...init, signal: deadline.signal });
      if (attempted.ok) return guard(attempted, deadline.abort);
      response = attempted;
      abortRequest = deadline.abort;
      status = attempted.status;
      retryAfter = attempted.headers.get("retry-after");
    } catch (error) {
      failure = error;
      transportError = classifyThrown(
        error,
        options.signal,
        deadline,
        options.isFatal,
      );
    } finally {
      // Retires the HEADERS deadline only. The request stays live while its
      // body is read, which is why `deadline.abort` outlives this call.
      deadline.dispose();
    }

    const decision = decideRetry({
      status,
      retryAfter,
      transportError,
      replaySafe: options.replaySafe,
      ...(options.interactive !== undefined && { interactive: options.interactive }),
      // `index` counts attempts made; the predicate counts the replay
      // being considered, which is one ahead.
      attempt: index + 1,
    });

    // Redacted at construction, not at the logging end: some vendors put
    // their API key in the query string, and an event that carries one is a
    // credential waiting for any future consumer to write it somewhere.
    const safeUrl = redactUrl(url);
    options.onEvent?.(
      decision.retry
        ? {
            type: "retry",
            label,
            url: safeUrl,
            attempt: index + 1,
            delayMs: decision.delayMs,
            reason: decision.reason,
            status,
          }
        : {
            type: "exhausted",
            label,
            url: safeUrl,
            attempts: index + 1,
            reason: decision.reason,
            status,
          },
    );

    if (!decision.retry) {
      if (response !== null && abortRequest !== null) {
        return guard(response, abortRequest);
      }
      throw failure instanceof Error
        ? failure
        : new Error(`${label} request to ${safeUrl} failed: ${String(failure)}`);
    }

    // The response we are about to walk away from has no owner. Ownership was
    // only ever defined for two of the three outcomes: an ok response and the
    // final non-ok one both go to a guard that holds `abortRequest`. The one
    // we retry past was left with nobody — `dispose()` above keeps the request
    // alive on purpose, because a returned handle still needs it, so this is
    // the one path that has to say "not this one". A body left unread and
    // un-aborted holds its connection until the peer gives up.
    if (abortRequest !== null) abortRequest();

    // Cancellable: a user who presses stop 20 ms into an eight-second
    // `Retry-After` backoff should not wait it out, and must not have one
    // more attempt dispatched on their behalf afterwards. Rejecting here
    // also means the abort — not the earlier response — is what surfaces.
    await doSleep(decision.delayMs, options.signal);
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

  const parsed: unknown = await response.json();
  // Checked, not asserted. `json()` hands back `unknown` because that is what
  // it is, and casting it to a record does not make it one: a vendor that
  // answers `null`, an array or a bare string still type-checks here and then
  // fails as `Cannot read properties of null` somewhere in a provider
  // transport, with nothing left to say which call produced it. The boundary
  // is where the shape stops being a guess, so it is where the check belongs.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${label} expected a JSON object from ${redactUrl(url)}, got ${describeJson(parsed)}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Name a JSON value's shape for an error message, without quoting it.
 *
 * The value itself is deliberately left out: a body that is the wrong shape
 * can still be megabytes long, or carry a token the vendor echoed back.
 * @param value - The parsed body.
 * @returns A short description of what arrived.
 */
function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
