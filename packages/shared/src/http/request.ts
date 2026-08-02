// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one HTTP transport with retries, shared by the backend services and
 * the browser.
 *
 * Before this existed the same concern was implemented three times with three
 * different verdicts: the worker retried only 429 (so a dropped connection was
 * fatal), the browser upload retried 5xx/429/network, and the agent's tools
 * retried nothing at all. That judgement now lives in exactly one place —
 * {@link decideRetry} — and every caller states the one fact only it can know:
 * whether replaying its request is free of side effects.
 *
 * WHAT THIS LAYER IS NOT (decided 2026-08-02, and the reason a much larger
 * earlier version was thrown away):
 *
 *   - It does not read bodies. It hands back the platform's own `Response`
 *     and forgets about it. Reading is the caller's, including how long a
 *     read may stall — the HTTP client underneath already times that, and a
 *     second timer on top of it is a duplicate with worse information.
 *   - It holds nothing after it returns. No listener on the caller's signal,
 *     no reference to the response, no callback. An object nobody holds is
 *     collected on its own, so there is no release protocol to get wrong.
 *     Measured: 200 unread responses leave one listener on the caller's
 *     signal, the same as bare `fetch`; the version this replaces left 200.
 *   - It carries no application concepts. An earlier cut had the vendor
 *     polling loop in it — which field holds the status, which values are
 *     terminal, how long a generation may take — none of which is HTTP.
 *
 * Written directly against `fetch` rather than on a retry client. That was
 * measured, not assumed: hosting this design on ky 2.0.2 required working
 * around five of its defaults (disabling its HTTP-error throwing also
 * disabled retrying; its method whitelist gated the retry predicate rather
 * than deferring to it; `Retry-After` was dropped once the predicate took
 * over; the predicate was not consulted on the final attempt so exhaustion
 * could not be reported; and it consumed a failing response's body, which
 * erased the vendor error text the worker puts in its logs). The loop below
 * is what those five workarounds were emulating.
 */

import {
  decideRetry,
  parseRetryAfter,
  type RetryRefusal,
  type TransportErrorKind,
} from "@shared/http/decide-retry.js";
import { withDeadline } from "@shared/http/cancellation.js";
import { MAX_TIMER_MS } from "@shared/http/constants.js";
import { redactUrl } from "@shared/http/redact-url.js";
import { sleep } from "@shared/sleep.js";

/**
 * What the transport did, alongside what it got.
 *
 * Returned rather than reported through a callback. A callback would have to
 * be held for the duration of the call and shielded against throwing — and
 * telemetry that can change the fate of the request it describes is a bug
 * waiting to happen. Data comes back; the caller logs it if it wants to.
 */
export interface HttpOutcome {
  /**
   * The platform's own response, whatever its status.
   *
   * A non-ok status is not an error here: whether a 404 is a failure is the
   * caller's business. Only a failure that produced no response at all throws.
   *
   * It is the real thing, not a wrapper. Read it, or do not — the transport
   * has already let go of it either way.
   *
   * ONE CONSEQUENCE WORTH KNOWING. The transport composes the caller's signal
   * with its own per-attempt deadline, and detaches from the caller's signal
   * the moment an attempt ends — that detachment is what keeps an unread
   * response from being held. So a `signal` that aborts AFTER this returns
   * will not interrupt a read in progress. To stop a read, cancel the body:
   * `response.body?.cancel()`. That is the same call the caller would make on
   * a bare `fetch` response, and it is the caller's to make, because by then
   * this layer is no longer in the picture.
   */
  response: Response;
  /** How many times the request was delivered. 1 means no replay happened. */
  attempts: number;
  /** Why the transport stopped, whether or not the result is a failure. */
  stopped: RetryRefusal;
  /**
   * The wait this response asked for via `Retry-After`, in milliseconds, or
   * null when it named none or named one that cannot be used.
   *
   * Parsed once, here, because the transport had to read it anyway to make
   * its own decision. Two parsers of one header are two chances to disagree.
   */
  retryAfterMs: number | null;
}

/** Per-call inputs. Retry COUNT is fixed in constants and absent here. */
export interface HttpRequestOptions {
  /**
   * Whether delivering this exact request a second time produces no
   * additional side effects. The CALLER owns this fact — the transport
   * cannot infer it.
   *
   * This is a statement of fact about the endpoint, NOT a retry preference:
   * answer it about what a second delivery would do, not about how badly the
   * call should succeed. An AIGC submit without a vendor idempotency key is
   * `false` (a replay bills a second generation); the same submit carrying
   * one is `true`; any poll or read is `true`.
   */
  replaySafe: boolean;
  /**
   * Caller-owned fact: a person is waiting on this request right now.
   *
   * The browser sets it; a worker or a job does not. Like `replaySafe` it
   * describes the caller's situation rather than a preference, and like
   * `replaySafe` the transport cannot work it out for itself.
   *
   * It decides one thing: how long a server-directed `Retry-After` may be
   * before serving it is worse than failing. Ten seconds with someone
   * watching, sixty without (`constants.ts` carries the reasoning for both).
   * Past the limit the request fails and the figure the server asked for
   * comes back with it, so the caller can say what happened instead of
   * leaving a person in front of a spinner.
   */
  interactive?: boolean;
  /**
   * How long one attempt may wait FOR RESPONSE HEADERS, in milliseconds.
   *
   * This deadline ends when the headers arrive. What happens while the body
   * is read is not this layer's business — see the module note.
   */
  timeoutMs: number;
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
   *
   * A predicate that throws has not answered "deterministic"; the transport
   * does what it would have done without one. It describes the failure, it
   * does not get to replace it.
   */
  isFatal?: (error: unknown) => boolean;
  /** Provider or tool name, for error messages. */
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

/**
 * A fetch implementation that broke the contract this transport drives it by.
 *
 * Its own type because the failure is deterministic: the same stand-in will
 * do the same thing on every attempt, so replaying is pure waste. It is OUR
 * bug rather than the network's, and it outranks the caller's own predicate.
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
 * it to one millisecond — inverts the instruction entirely.
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

/**
 * Classify a thrown fetch failure into {@link decideRetry}'s vocabulary.
 *
 * Keyed on observable state rather than on the error's name or message: the
 * caller's own signal tells us a cancellation, and this attempt's timeout
 * flag tells us a deadline. Everything else is a transport-level failure
 * unless the caller recognises it as deterministic. Error names would be a
 * weaker discriminator — an abort surfaces whatever reason the caller passed
 * to `abort()`, which may be any value.
 * @param error - The error the fetch attempt rejected with.
 * @param callerSignal - The caller's cancellation signal, if any.
 * @param expired - Whether this attempt's own deadline is what fired.
 * @param isFatal - The caller's deterministic-failure predicate, if any.
 * @returns The transport-error kind for the predicate.
 */
function classifyThrown(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  expired: boolean,
  isFatal: ((error: unknown) => boolean) | undefined,
): TransportErrorKind {
  if (callerSignal?.aborted === true) return "caller_aborted";
  if (expired) return "timeout";
  // Our own contract breach outranks the caller's predicate: the caller
  // classifies what ITS fetch implementation throws, and this is what the
  // transport itself refused to accept from that implementation.
  if (error instanceof TransportContractError) return "fatal";
  let claimed = false;
  try {
    claimed = isFatal?.(error) === true;
  } catch {
    // A predicate that cannot answer has not answered "deterministic". It
    // describes the failure; it does not get to replace it. Swallowed rather
    // than logged because library packages must not log.
    claimed = false;
  }
  return claimed ? "fatal" : "network";
}

/**
 * Perform an HTTP request, replaying it when — and only when — the caller's
 * declared replay-safety and the failure kind together allow it.
 *
 * Returns the LAST response even when it is not ok, because whether an HTTP
 * error counts as a failure is a business decision rather than a transport
 * one: the agent's fetch tool needs the status of a 404, the worker's
 * provider transports want an exception. Only a failure that produced no
 * response at all throws.
 *
 * The response comes back untouched and unheld. Read it or discard it — this
 * layer keeps no listener, no reference and no expectation either way.
 * @param url - Absolute request URL.
 * @param init - Standard fetch init (method, headers, body). Any `signal` on
 *   it is replaced by this call's per-attempt signal.
 * @param options - Replay-safety fact, the headers deadline, and hooks.
 * @returns The final response plus what the transport did to obtain it.
 * @throws {Error} When no response was ever obtained — a network failure, an
 *   attempt timeout, or a caller abort — after replays are spent. Also when
 *   the caller cancels during a backoff wait.
 */
export async function httpRequest(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
): Promise<HttpOutcome> {
  const label = options.label ?? "http";
  const doFetch = options.fetchImpl ?? fetch;
  const doSleep = options.sleepImpl ?? sleep;
  // Redacted once, up front, because everything that names this request uses
  // it. Some vendors put their API key in the query string, so the raw URL
  // must not reach a message anyone might write down.
  const safeUrl = redactUrl(url);
  refuseUnusableOptions(options, label, safeUrl);

  // Unbounded by design: `decideRetry` owns the budget and refuses past
  // MAX_RETRIES, so the exit is the predicate rather than a second counter
  // that could disagree with it.
  for (let index = 0; ; index++) {
    // A fresh deadline per attempt is the whole point. The implementation
    // this replaces let callers pass one `AbortSignal.timeout(...)` into a
    // retry loop; an `AbortSignal` is single-shot, so the first timeout
    // aborted every subsequent attempt before it left the ground.
    const deadline = withDeadline(options.signal, options.timeoutMs, `${label} attempt timed out`);
    let response: Response | null = null;
    let status: number | undefined;
    let serverWaitMs: number | null = null;
    let transportError: TransportErrorKind | undefined;
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
      // below and the outcome handed to the caller.
      serverWaitMs = parseRetryAfter(attempted.headers.get("retry-after"), Date.now());
      response = attempted;
      status = attempted.status;
      if (attempted.ok) {
        return { response: attempted, attempts: index + 1, stopped: "nothing_to_retry", retryAfterMs: serverWaitMs };
      }
    } catch (error) {
      failure = error;
      transportError = classifyThrown(error, options.signal, deadline.expired(), options.isFatal);
    } finally {
      // Always, on every path out of the attempt. This is what keeps the
      // transport from holding anything once it returns: the timer is cleared
      // and the listener on the caller's signal is detached, so a response
      // nobody reads is a response nobody holds.
      deadline.dispose();
    }

    const decision = decideRetry({
      status,
      retryAfterMs: serverWaitMs,
      transportError,
      replaySafe: options.replaySafe,
      bodyReplayable: bodyCanBeResent(init.body),
      ...(options.interactive !== undefined && { interactive: options.interactive }),
      // `index` counts attempts made; the predicate counts the replay being
      // considered, which is one ahead.
      attempt: index + 1,
    });

    if (!decision.retry) {
      if (response !== null) {
        return { response, attempts: index + 1, stopped: decision.reason, retryAfterMs: serverWaitMs };
      }
      throw failure instanceof Error
        ? failure
        : new Error(`${label} request to ${safeUrl} failed: ${String(failure)}`);
    }

    // The response we walk away from is deliberately left alone. Cancelling
    // its body would be this layer managing a body, which is the one thing it
    // does not do — and the client underneath already handles an unconsumed
    // response: a small one is buffered and its socket returns to the pool,
    // a large one costs that socket its reuse. Measured: ten unread 404s used
    // two connections, not ten. A lost reuse is a cost, not a leak, and it is
    // the cost of this layer having no opinion about bodies.
    await doSleep(decision.delayMs, options.signal);
  }
}
