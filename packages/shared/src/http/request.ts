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
  parseRetryAfter,
  type RetryRefusal,
  type RetryTrigger,
  type TransportErrorKind,
} from "@shared/http/decide-retry.js";
import { guardResponseBody, type GuardedResponse } from "@shared/http/body-guard.js";
import { shieldCaller } from "@shared/http/caller-callback.js";
import {
  BODY_IDLE_TIMEOUT_MS,
  HTTP_ERROR_BODY_EXCERPT_CHARS,
  MAX_TIMER_MS,
} from "@shared/http/constants.js";
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
      /**
       * The wait the server asked for, when it asked for one longer than this
       * caller's ceiling. Present only on a `retry_after_too_long` refusal.
       */
      retryAfterMs?: number;
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
  // Our own contract breach outranks the caller's predicate: the caller
  // classifies what ITS fetch implementation throws, and this is what the
  // transport itself refused to accept from that implementation.
  if (error instanceof TransportContractError) return "fatal";
  // Shielded for the same reason as the telemetry sink: the predicate
  // describes the failure, it does not get to replace it. One that throws has
  // not answered "deterministic", so the transport does what it would have
  // done without a predicate at all.
  if (shieldCaller(() => isFatal?.(error) === true, false)) return "fatal";
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
 * body with no deadline at all, and eight of them did. The handle exposes
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
  // Redacted once, up front, because everything that names this request uses
  // it: the retry events, and every error the body guard reports. Some vendors
  // put their API key in the query string, so the raw URL must not reach a
  // message anyone might write down.
  const safeUrl = redactUrl(url);
  refuseUnusableOptions(options, label, safeUrl);

  /**
   * Report one attempt's outcome without letting the sink change it.
   *
   * Telemetry is the application's business and its failures are the
   * application's bug; what it must never do is decide the fate of the request
   * it is describing.
   * @param event - What happened on this attempt.
   */
  const emit = (event: HttpRetryEvent): void => {
    shieldCaller(() => options.onEvent?.(event), undefined);
  };

  /**
   * Wrap a response so its body is read under the idle deadline.
   * @param response - The response to hand out.
   * @param abortRequest - Teardown for the attempt that produced it.
   * @param serverWaitMs - The wait this response asked for, already parsed by
   *   the attempt that received it. Passed in rather than re-read here: the
   *   header's date form is relative to a clock, so parsing it a second time
   *   a few hundred milliseconds later returns null once the named instant
   *   has passed — the decision would have seen a wait and the caller would
   *   have been told there was none.
   * @returns The guarded handle.
   */
  const guard = (
    response: Response,
    abortRequest: () => void,
    serverWaitMs: number | null,
  ): GuardedResponse =>
    guardResponseBody({
      response,
      retryAfterMs: serverWaitMs,
      idleTimeoutMs: options.bodyIdleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS,
      callerSignal: options.signal,
      ...(options.maxBodyBytes !== undefined && { maxBytes: options.maxBodyBytes }),
      abortRequest,
      label,
      url: safeUrl,
    });

  // Unbounded by design: `decideRetry` owns the budget and refuses past
  // MAX_RETRIES, so the exit is the predicate rather than a second counter
  // that could disagree with it.
  for (let index = 0; ; index++) {
    const deadline = startAttemptDeadline(options.signal, options.timeoutMs);
    let status: number | undefined;
    let serverWaitMs: number | null = null;
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
      // Checked before anything is recorded about the attempt. A fetch
      // implementation that hands back something else is OUR bug, not the
      // network's, and the fields below were being assigned before the first
      // line that touches the object — so a duck-typed stand-in was replayed
      // three times and then returned to the caller dressed as a response.
      if (!(attempted instanceof Response)) {
        throw new TransportContractError(
          `${label} fetch implementation for ${safeUrl} did not return a Response`,
        );
      }
      // Parsed once, here, and used by both consumers: the retry decision
      // below and the handle handed to the caller.
      serverWaitMs = parseRetryAfter(attempted.headers.get("retry-after"), Date.now());
      if (attempted.ok) return guard(attempted, deadline.abort, serverWaitMs);
      response = attempted;
      abortRequest = deadline.abort;
      status = attempted.status;
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
      retryAfterMs: serverWaitMs,
      transportError,
      replaySafe: options.replaySafe,
      bodyReplayable: bodyCanBeResent(init.body),
      ...(options.interactive !== undefined && { interactive: options.interactive }),
      // `index` counts attempts made; the predicate counts the replay
      // being considered, which is one ahead.
      attempt: index + 1,
    });

    if (!decision.retry) {
      emit({
        type: "exhausted",
        label,
        url: safeUrl,
        attempts: index + 1,
        reason: decision.reason,
        status,
        // Whenever the server named a wait, it travels back — not only on the
        // refusal that is ABOUT the wait. A run that spent its attempts on
        // 503s and met a 429 with `Retry-After` on the last one ends as
        // `attempts_exhausted`, and reporting that without the figure left
        // the layer above with nothing to say about when to come back, on the
        // one occasion the server had said so explicitly.
        ...(serverWaitMs !== null && { retryAfterMs: serverWaitMs }),
      });
      if (response !== null && abortRequest !== null) {
        return guard(response, abortRequest, serverWaitMs);
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

    // Reported AFTER the teardown above, not before. The sink belongs to the
    // application, and when one threw, the exception escaped in place of the
    // real outcome and took the teardown with it — leaking the very response
    // we had just decided to abandon.
    emit({
      type: "retry",
      label,
      url: safeUrl,
      attempt: index + 1,
      delayMs: decision.delayMs,
      reason: decision.reason,
      status,
    });

    // Cancellable: a user who presses stop 20 ms into an eight-second
    // `Retry-After` backoff should not wait it out, and must not have one
    // more attempt dispatched on their behalf afterwards. Rejecting here
    // also means the abort — not the earlier response — is what surfaces.
    try {
      await doSleep(decision.delayMs, options.signal);
    } catch (interrupted) {
      // Without this the log's last word was "attempt 1 is being replayed in
      // 113ms" and then silence, which reads exactly like a process that died
      // mid-backoff. Every request this layer starts now ends with a terminal
      // event.
      //
      // Which terminal event depends on what actually happened. Reporting
      // `caller_aborted` unconditionally meant any failure of the wait — an
      // injected sleep that rejects, a timer subsystem that is unwell — was
      // logged as a person pressing stop, while the error that reached the
      // caller said something else entirely. On-call then goes looking for a
      // user action that never happened.
      emit({
        type: "exhausted",
        label,
        url: safeUrl,
        attempts: index + 1,
        reason: options.signal?.aborted === true ? "caller_aborted" : "wait_failed",
        status,
      });
      throw interrupted;
    }
  }
}

/**
 * A fetch implementation that broke the contract this transport drives it by.
 *
 * Its own type, because the failure is deterministic — the same stand-in
 * returns the same non-Response on every attempt — and the retry predicate
 * only skips replays for failures it can recognise as such.
 */
class TransportContractError extends Error {
  /**
   * Build the refusal.
   * @param message - What the implementation did instead.
   */
  constructor(message: string) {
    super(message);
    this.name = "TransportContractError";
  }
}

/**
 * Whether a duration is one a timer can actually hold.
 * @param ms - The candidate duration.
 * @returns True when it can be honoured as given.
 */
function usableDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS;
}

/**
 * Refuse options the transport cannot honour as given.
 *
 * Checked at the boundary and refused rather than repaired, because every
 * repair available here is a silent lie: clamping a 30-day timeout to 24.8
 * days is a number nobody asked for, and the platform's own repair — folding
 * it to one millisecond — inverts the instruction entirely. The same goes for
 * a NaN byte ceiling, where every comparison is false and a caller that
 * believes it set a cap has none at all.
 * @param options - The caller's options.
 * @param label - Provider or tool name, for the message.
 * @param safeUrl - The redacted request URL, for the message.
 * @throws {TransportContractError} When an option cannot be honoured.
 */
function refuseUnusableOptions(
  options: HttpRequestOptions,
  label: string,
  safeUrl: string,
): void {
  if (!usableDuration(options.timeoutMs)) {
    throw new TransportContractError(
      `${label} request to ${safeUrl} asked for a timeout of ${options.timeoutMs}ms, which no timer can hold (expected 1..${MAX_TIMER_MS})`,
    );
  }
  if (options.bodyIdleTimeoutMs !== undefined && !usableDuration(options.bodyIdleTimeoutMs)) {
    throw new TransportContractError(
      `${label} request to ${safeUrl} asked for a body idle timeout of ${options.bodyIdleTimeoutMs}ms, which no timer can hold (expected 1..${MAX_TIMER_MS})`,
    );
  }
  if (
    options.maxBodyBytes !== undefined &&
    (!Number.isFinite(options.maxBodyBytes) || options.maxBodyBytes < 0)
  ) {
    throw new TransportContractError(
      `${label} request to ${safeUrl} asked for a byte ceiling of ${options.maxBodyBytes}, which cannot bound anything (expected a non-negative finite number)`,
    );
  }
}

/**
 * Whether this body can be handed to `fetch` a second time.
 *
 * Answered by allow-list rather than by looking for streams, and deliberately
 * so: an unrecognised body is treated as one-shot, which costs a replay that
 * might have worked. The other way round costs a replay that CANNOT work,
 * plus the real answer — the first attempt's response is discarded and the
 * caller is handed a TypeError about a disturbed body instead. Between a
 * missed retry and a destroyed answer, miss the retry.
 *
 * Every listed type can be read more than once: strings and byte buffers are
 * values, a `Blob` opens a fresh read per use, and `FormData` /
 * `URLSearchParams` are re-serialised on each send. A `ReadableStream` — what
 * a streamed upload passes — cannot, and neither can an async iterable.
 * @param body - The body from the caller's fetch init.
 * @returns True when a replay would send the same bytes again.
 */
function bodyCanBeResent(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body === "string") return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof FormData) return true;
  if (body instanceof Blob) return true;
  if (body instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(body);
}

/** Everything known about a non-ok answer from a JSON endpoint. */
interface HttpStatusErrorInit {
  /** Provider or tool name. */
  label: string;
  /** Which endpoint answered, already redacted. */
  url: string;
  /** The status it answered with. */
  status: number;
  /** The wait it asked for, already parsed, or null when it named none. */
  retryAfterMs: number | null;
  /** A bounded quote from the body, empty when it could not be read. */
  bodyExcerpt: string;
  /** Why the body could not be read, or null when it was read fine. */
  unreadable: unknown;
}

/**
 * A non-ok answer from a JSON endpoint, carrying what the transport learned.
 *
 * It exists because the previous shape — `new Error(\`${label} HTTP ${status}:
 * ${body}\`)`, carried over verbatim from the code this transport replaces —
 * threw away four things the layer above needs, on the single most frequently
 * hit failure path in the whole transport: the wait the server named, which
 * endpoint of twenty answered, why the body could not be read when it could
 * not, and any bound at all on how much of that body ended up in a log line.
 *
 * Fields rather than a formatted string, because a caller deciding when to try
 * again cannot parse a sentence.
 */
export class HttpStatusError extends Error {
  /** The status the endpoint answered with. */
  readonly status: number;
  /** Which endpoint answered, already redacted. */
  readonly url: string;
  /** The wait the server asked for, or null when it named none. */
  readonly retryAfterMs: number | null;
  /** A bounded quote from the body; empty when it could not be read. */
  readonly bodyExcerpt: string;

  /**
   * Build the failure.
   * @param init - What the transport learned about this answer.
   */
  constructor(init: HttpStatusErrorInit) {
    const where = `${init.label} HTTP ${init.status} from ${init.url}`;
    super(
      init.unreadable === null
        ? `${where}: ${init.bodyExcerpt}`
        : `${where} (body unreadable: ${describeCause(init.unreadable)})`,
      init.unreadable === null ? undefined : { cause: init.unreadable },
    );
    this.name = "HttpStatusError";
    this.status = init.status;
    this.url = init.url;
    this.retryAfterMs = init.retryAfterMs;
    this.bodyExcerpt = init.bodyExcerpt;
  }
}

/**
 * Describe why a body could not be read, in one line.
 * @param cause - Whatever the read rejected with.
 * @returns A short description.
 */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Cut a peer-controlled body down to what an error message may carry.
 *
 * The ellipsis counts against the budget, so the result never exceeds
 * {@link HTTP_ERROR_BODY_EXCERPT_CHARS} — a ceiling a caller can rely on is
 * worth more than one extra character of vendor text.
 * @param body - The body as read.
 * @returns The body, or a truncated excerpt of it marked with an ellipsis.
 */
function truncate(body: string): string {
  return body.length <= HTTP_ERROR_BODY_EXCERPT_CHARS
    ? body
    : `${body.slice(0, HTTP_ERROR_BODY_EXCERPT_CHARS - 1)}…`;
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
  const safeUrl = redactUrl(url);
  const response = await httpRequest(url, init, options);

  if (!response.ok) {
    // Read under the guard, and keep WHY a read failed. `.catch(() => "")`
    // used to erase three distinct outcomes — an idle deadline, a byte-cap
    // refusal and a caller abort — into the same empty string a genuinely
    // empty body produces, on the path a vendor failure travels.
    let excerpt = "";
    let unreadable: unknown = null;
    try {
      excerpt = truncate(await response.text());
    } catch (error) {
      unreadable = error;
    }
    throw new HttpStatusError({
      label,
      url: safeUrl,
      status: response.status,
      retryAfterMs: response.retryAfterMs,
      bodyExcerpt: excerpt,
      unreadable,
    });
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
