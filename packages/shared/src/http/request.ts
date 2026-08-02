// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One HTTP request, replayed when a replay is warranted.
 *
 * This layer does six things and no seventh:
 *
 *   1. send the request the caller asked for, byte for byte
 *   2. decide whether a failure is worth replaying
 *   3. wait as long as the server said, or work it out when it did not
 *   4. deliver at most three times
 *   5. hand the response over, or throw when none was ever obtained
 *   6. hold nothing once the call is over
 *
 * What it deliberately does NOT do is as load-bearing as what it does. It does
 * not read the body — how long, how big and how to stop are the caller's, and
 * the client underneath already times a stalled read (measured: Node's fetch
 * rejects a server that sends headers then goes silent, after 301s, with
 * UND_ERR_BODY_TIMEOUT). It does not log — library packages report by
 * returning and throwing. And it does not tell the caller why it stopped: a
 * response IS the answer, and a caller that wants to branch reads the status
 * it already has.
 *
 * The count of deliveries rides with the failure, never with the response.
 * A caller holding a 200 has no use for "and it took two tries"; a caller
 * holding a failure has a log line to write.
 */

import { sleep } from "@shared/sleep.js";
import { withDeadline, type DeadlineSignal } from "@shared/http/cancellation.js";
import { MAX_TIMER_MS } from "@shared/http/constants.js";
import { decideRetry, type TransportErrorKind, parseRetryAfter } from "@shared/http/decide-retry.js";
import { redactUrl, UNPARSEABLE_URL } from "@shared/http/redact-url.js";

/**
 * Every delivery failed and none produced a response.
 *
 * Thrown only when a replay actually happened. A failure on the very first
 * delivery carries no count worth reporting — "attempts: 1" states that the
 * request was made, which the caller knew — so that one is rethrown exactly
 * as it arrived.
 */
export class HttpRetryError extends Error {
  /** How many times the request was delivered before giving up. */
  readonly attempts: number;

  /**
   * Build the failure.
   * @param message - What was being attempted, with the url already redacted.
   * @param attempts - How many deliveries were made.
   * @param cause - The failure the last delivery produced.
   */
  constructor(message: string, attempts: number, cause: unknown) {
    super(message, { cause });
    this.name = "HttpRetryError";
    this.attempts = attempts;
  }
}

/** What the caller must state, and the seams tests inject. */
export interface HttpRequestOptions {
  /**
   * Caller-owned fact: delivering this exact request again produces no
   * additional side effects.
   *
   * A fact, not a preference. Only the caller knows that `POST /predictions`
   * spends the vendor's money a second time, and no amount of inspecting the
   * request would reveal it. Setting it true to "make things more reliable"
   * inverts its meaning.
   */
  replaySafe: boolean;
  /**
   * How long one delivery may wait FOR RESPONSE HEADERS, in milliseconds.
   *
   * The deadline ends when the headers arrive; what happens while the body is
   * read is not this layer's business.
   */
  timeoutMs: number;
  /** Fetch implementation; defaults to the global one. */
  fetchImpl?: typeof fetch;
  /** The caller's cancellation, composed with each delivery's own deadline. */
  signal?: AbortSignal;
  /**
   * The caller's deterministic-failure predicate.
   *
   * Some failures are the caller's own policy rather than the network's — an
   * SSRF guard refusing an address will refuse it identically on every
   * delivery, so replaying only burns the budget. Only the caller can
   * recognise what its own fetch implementation throws.
   *
   * If it throws, it has not answered "deterministic"; it describes the
   * failure and does not get to replace it.
   */
  isFatal?: (error: unknown) => boolean;
  /** Provider or tool name, used only to make a thrown message legible. */
  label?: string;
  /** Sleep implementation; the seam that keeps the tests off a real clock. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * A fetch implementation that broke the contract this transport drives it by.
 *
 * Its own type because the failure is deterministic: the same stand-in will do
 * the same thing on every delivery, so replaying is pure waste. It is OUR bug
 * rather than the network's, and it outranks the caller's own predicate.
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
 * @param url - The request URL as the caller wrote it.
 * @param options - The caller's options.
 * @param label - Provider or tool name, for the message.
 * @param safeUrl - The redacted request URL, for the message.
 * @throws {TransportContractError} When the URL or an option cannot be honoured.
 */
function refuseUnusableOptions(
  url: string,
  options: HttpRequestOptions,
  label: string,
  safeUrl: string,
): void {
  // Refused here, before anything is sent, for two reasons that compound.
  // Sending it anyway costs three deliveries and two backoffs against a string
  // that can never usefully resolve — and the rejection `fetch` produces
  // carries the RAW url, so a password or a query key travels out in an error
  // message that never passed through redaction and then becomes the `cause`
  // this package tells callers to log.
  if (safeUrl === UNPARSEABLE_URL) {
    throw new TransportContractError(`${label} was given something that is not a URL`);
  }
  const parsed = new URL(url);
  // Credentials in the URL: `fetch` refuses to build a Request from one at all,
  // and the TypeError it throws quotes the whole raw url — userinfo, query and
  // everything else. Measured: the password and a query key both reached the
  // caller through `cause` while the message beside it was properly redacted.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TransportContractError(
      `${label} was given a URL carrying credentials; put them in a header instead`,
    );
  }
  // Parseable is not fetchable. A `data:` URL is actually fetched and returned
  // as a 200, which is not an HTTP round trip at all; every other scheme costs
  // three deliveries to learn what the string already said.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TransportContractError(
      `${label} was given a ${parsed.protocol} URL; this transport speaks http and https`,
    );
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TransportContractError(
      `${label} was given a signal that is not an AbortSignal`,
    );
  }
  if (!usableDuration(options.timeoutMs)) {
    throw new TransportContractError(
      `${label} request to ${safeUrl} asked for a timeout of ${options.timeoutMs}ms, which no timer can hold (expected 1..${MAX_TIMER_MS})`,
    );
  }
}

/**
 * Whether a buffer has been transferred away, leaving nothing to send.
 *
 * `ArrayBuffer.prototype.detached` is ES2024 and this repo targets ES2023, so
 * the property exists at runtime but not in the type. Asserted narrowly rather
 * than widening the whole project's lib for one predicate. `byteLength` cannot
 * substitute: a transferred buffer and a genuinely empty one both report 0, and
 * an empty body is perfectly replayable.
 * @param buffer - The buffer behind the body, or the view's buffer.
 * @returns True when its bytes have been transferred elsewhere.
 */
function isDetached(buffer: ArrayBufferLike): boolean {
  return (buffer as { detached?: boolean }).detached === true;
}

/**
 * Whether this body can be handed to `fetch` a second time.
 *
 * Answered by allow-list rather than by looking for streams, and deliberately
 * so: an unrecognised body is treated as one-shot, which costs a replay that
 * might have worked. The other way round costs a replay that CANNOT work, plus
 * the real answer — the first delivery's response is discarded and the caller
 * is handed a TypeError about a disturbed body instead. Between a missed retry
 * and a destroyed answer, miss the retry.
 *
 * Every listed type can be read more than once: strings and byte buffers are
 * values, a `Blob` opens a fresh read per use, and `FormData` /
 * `URLSearchParams` are re-serialised on each send. A `ReadableStream` — what a
 * streamed upload passes — cannot, and neither can an async iterable.
 * @param body - The body from the caller's fetch init.
 * @returns True when a replay would send the same bytes again.
 */
function bodyCanBeResent(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return true;
  // A transferred buffer still passes `instanceof` while holding no bytes at
  // all. Nothing else distinguishes it — it is not walkable-once, it is empty
  // — so it needs its own question.
  if (body instanceof ArrayBuffer) return !isDetached(body);
  if (ArrayBuffer.isView(body)) return !isDetached(body.buffer);
  // One rule for everything else: a source you can only walk once is spent by
  // the first delivery. `ReadableStream` and async generators both declare
  // themselves with `Symbol.asyncIterator`; a string, a `Blob`, `FormData`,
  // `URLSearchParams` and plain values do not, and `fetch` re-serialises those
  // identically on every delivery.
  //
  // This was an allow-list of named types until a mutation pass showed all
  // seven positive branches were dead: the rule below already answered for
  // every one of them, so deleting them left the suite green. Naming types
  // also got the answer WRONG for anything unnamed — a plain object, an array
  // — which fetch handles perfectly well and which lost its retries for it.
  return !(typeof body === "object" && Symbol.asyncIterator in body);
}

/**
 * Whether the caller has stopped this call.
 *
 * Read through a function on purpose. Inline, TypeScript narrows `aborted` to
 * `false` after the guard before the loop and then reports every later check as
 * a comparison that cannot hold — but the value changes underneath, which is
 * the entire point of a cancellation signal.
 * @param signal - The caller's signal, if it supplied one.
 * @returns True when the caller has aborted.
 */
function wasCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * A promise that rejects when this delivery's deadline or the caller fires.
 *
 * Raced against the fetch rather than merely handed to it. Passing the signal
 * is a request an implementation is free to ignore, and one that ignores it
 * left the call pending indefinitely with `timeoutMs` silently unenforced.
 *
 * When the fetch settles first this promise is simply dropped: nothing holds
 * it, nothing holds the composed signal it listens on, so both are collectable
 * together.
 * @param deadline - This delivery's composed deadline.
 * @param label - Provider or tool name, for the message.
 * @returns A promise that never resolves and rejects on abort.
 */
function deadlineReached(deadline: DeadlineSignal, label: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener(
      "abort",
      () => {
        const { reason } = deadline.signal;
        reject(reason instanceof Error ? reason : new Error(`${label} attempt timed out`));
      },
      { once: true },
    );
  });
}

/**
 * Whether a value is a Response, including one from another realm.
 *
 * `instanceof` compares against THIS realm's constructor, so a Response built
 * by undici — already in this repo's tree via jsdom and testcontainers — failed
 * the check and was reported as a broken implementation. Since a caller-injected
 * fetch is this layer's whole seam, rejecting the commonest way to supply one
 * defeats the feature. The shape below is what the loop actually uses, and a
 * duck-typed stand-in missing any of it is still refused.
 * @param value - Whatever the fetch implementation resolved with.
 * @returns True when it can be used, and handed on, as a response.
 */
function isResponseLike(value: unknown): value is Response {
  if (value instanceof Response) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { status?: unknown; ok?: unknown; headers?: { get?: unknown } };
  return (
    typeof candidate.status === "number" &&
    typeof candidate.ok === "boolean" &&
    typeof candidate.headers === "object" &&
    candidate.headers !== null &&
    typeof candidate.headers.get === "function"
  );
}

/**
 * Classify a thrown fetch failure into the retry predicate's vocabulary.
 *
 * Keyed on observable state rather than on the error's name or message: the
 * caller's own signal tells us a cancellation, and this delivery's timeout flag
 * tells us a deadline. Everything else is a transport-level failure unless the
 * caller recognises it as deterministic. Error names would be a weaker
 * discriminator — an abort surfaces whatever reason the caller passed to
 * `abort()`, which may be any value at all.
 * @param error - The error the fetch delivery rejected with.
 * @param callerSignal - The caller's cancellation signal, if any.
 * @param expired - Whether this delivery's own deadline is what fired.
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
 * one: the agent's fetch tool wants the status of a 404, a vendor transport
 * wants an exception. A response is an answer; only the absence of one throws.
 *
 * The response comes back untouched and unheld. Read it or discard it — this
 * layer keeps no listener, no reference and no expectation either way.
 * @param url - Absolute request URL.
 * @param init - Standard fetch init (method, headers, body). Any `signal` on it
 *   is replaced by this call's per-delivery signal.
 * @param options - The replay-safety fact, the headers deadline, and the seams.
 * @returns The final response, exactly as `fetch` produced it.
 * @throws {HttpRetryError} When replays happened and none produced a response.
 * @throws {Error} The original failure, unwrapped, when the first delivery
 *   failed and no replay followed — including a cancellation by the caller.
 */
export async function httpRequest(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
): Promise<Response> {
  const label = options.label ?? "http";
  const doFetch = options.fetchImpl ?? fetch;
  const doSleep = options.sleepImpl ?? sleep;
  // Redacted once, up front, because everything that names this request uses
  // it. Some vendors put their API key in the query string, so the raw URL must
  // not reach a message anyone might write down.
  const safeUrl = redactUrl(url);
  refuseUnusableOptions(url, options, label, safeUrl);
  // Already stopped before we began. Delivering once anyway spends a request
  // the caller has explicitly withdrawn.
  if (options.signal?.aborted === true) throw options.signal.reason;

  // Unbounded by design: `decideRetry` owns the budget and refuses past
  // MAX_RETRIES, so the exit is the predicate rather than a second counter that
  // could disagree with it.
  for (let index = 0; ; index++) {
    const attempts = index + 1;
    // A fresh deadline per delivery is the whole point. The implementation this
    // replaces let callers pass one `AbortSignal.timeout(...)` into a retry
    // loop; an `AbortSignal` is single-shot, so the first timeout aborted every
    // subsequent delivery before it left the ground.
    const deadline = withDeadline(options.signal, options.timeoutMs, `${label} attempt timed out`);
    let response: Response | null = null;
    let status: number | undefined;
    let serverWaitMs: number | null = null;
    let transportError: TransportErrorKind | undefined;
    let failure: unknown = null;

    try {
      // Raced, not merely signalled. Handing the deadline over as `init.signal`
      // is a request, and an implementation that drops it — this repo's own
      // SSRF guard hardcodes its own timeout and discards ours — left the call
      // hanging forever with the deadline silently unenforced.
      const attempted = await Promise.race([
        doFetch(url, { ...init, signal: deadline.signal }),
        deadlineReached(deadline, label),
      ]);
      // Checked before anything is recorded about the delivery. A stand-in that
      // hands back something else is OUR bug, not the network's, and the fields
      // below were being assigned before the first line that touches the object
      // — so a duck-typed stand-in was replayed three times and then returned
      // to the caller dressed as a response.
      if (!isResponseLike(attempted)) {
        throw new TransportContractError(
          `${label} fetch implementation for ${safeUrl} did not return a Response`,
        );
      }
      serverWaitMs = parseRetryAfter(attempted.headers.get("retry-after"), Date.now());
      response = attempted;
      status = attempted.status;
      if (attempted.ok) return attempted;
    } catch (error) {
      // Stopping is not a failed retry. It used to fall through the same gate
      // as one, so pressing stop on the second delivery reached the caller as
      // "failed after 2 attempts" — a decision the caller made, reported back
      // as a network fault with a count attached that means nothing. Rethrown
      // as-is, whatever value it aborted with; `finally` below still runs.
      if (wasCancelled(options.signal)) throw options.signal?.reason;
      failure = error;
      transportError = classifyThrown(error, options.signal, deadline.expired(), options.isFatal);
    } finally {
      // Always, on every path out of the delivery. This is what keeps the
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
      attempt: attempts,
    });

    if (!decision.retry) {
      // A response is an answer, whatever its status. Only its absence throws.
      if (response !== null) return response;
      // One delivery, no count worth reporting: the caller learns nothing from
      // "attempts: 1" that it did not already know, and wrapping would bury the
      // error it can actually act on. More than one, and the count is the part
      // it could not have worked out for itself.
      if (attempts === 1) throw failure;
      throw new HttpRetryError(
        `${label} request to ${safeUrl} failed after ${attempts} attempts`,
        attempts,
        failure,
      );
    }

    // The response we walk away from is deliberately left alone. Cancelling its
    // body would be this layer managing a body, which is the one thing it does
    // not do — and the client underneath already handles an unconsumed
    // response: a small one is buffered and its socket returns to the pool, a
    // large one costs that socket its reuse. Measured, and the size matters:
    // ten unread 404s with small bodies used two connections, but past undici's
    // 64 KiB buffering threshold reuse collapses — thirty unread megabyte
    // responses used thirty connections. A lost reuse is a cost, not a leak,
    // and it is the cost of this layer having no opinion about bodies; a caller
    // discarding large ones should cancel them (`response.body?.cancel()`).
    try {
      await doSleep(decision.delayMs, options.signal);
    } catch (error) {
      // The same rule as mid-delivery: a stop during the wait is the caller's
      // decision, handed back with the value it aborted with. Without this the
      // sleep's own rejection escaped — a fourth throw shape nothing named,
      // and one that replaced a non-Error abort reason with a generic Error.
      if (wasCancelled(options.signal)) throw options.signal?.reason;
      throw error;
    }
  }
}
