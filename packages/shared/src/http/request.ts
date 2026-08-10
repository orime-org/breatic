// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One HTTP request, replayed when a replay is warranted.
 *
 * The whole of it: the caller says where to connect, what to send, and the two
 * things this layer cannot work out for itself — whether sending the same
 * request twice costs anything, and how long one delivery may take. Everything
 * after that is this layer's own business. Network trouble is handled here. If
 * it cannot be handled, the caller is told what went wrong. If it can, the
 * caller gets the response.
 *
 * The test for what is a parameter and what is not: could this layer work it
 * out from a url and some bytes? Replay cost, no — only the caller knows the
 * endpoint bills. Timeout, no — it comes from the model being called or the
 * size of the file being sent. Retry count and backoff, yes, so they are
 * compiled in.
 *
 * Every other knob is gone, and each removal took a pile of machinery with it:
 *
 *   - No injected fetch, so the global one is always what runs. It honours a
 *     signal, so nothing has to race it; it returns a real Response, so nothing
 *     has to check the shape of what came back.
 *   - No caller cancellation. The deadline below is the only thing that can
 *     abort a delivery, so there is one abort source instead of two composed
 *     ones, and nothing to detach afterwards. A caller that no longer wants the
 *     answer stops holding the promise, and what nobody holds is collected.
 *     Be exact about what that does NOT do: a loop already running finishes on
 *     its own, so walking away can still cost two more deliveries and both
 *     backoffs. Measured at the server, relative to the moment the caller let
 *     go, four runs against an always-503 server: the second delivery landed
 *     between 0.3s and 0.9s, the third between 0.4s and 2.6s. No fixed pair of
 *     figures can be stated, because both waits are drawn uniformly at random
 *     below a ceiling (1s, then 2s) — only the bound is statable. What bounds
 *     the whole thing is item 4 rather than the caller: three deliveries and
 *     it is over, which is why an unbounded transport could not have made this
 *     trade and this one can.
 *   - No injected wait and no label. The first was a test seam on a production
 *     surface; the second was something this layer can answer for itself.
 *
 * It does not read the body — how long, how big and how to stop are the
 * caller's, and the client underneath already times a stalled read (measured:
 * Node's fetch rejects a server that sends headers then goes silent, after
 * 301s, with UND_ERR_BODY_TIMEOUT). It does not log — library packages report
 * by returning and throwing. And it does not say why it stopped: a response IS
 * the answer, and a caller that wants to branch reads the status it has.
 */

import { DEFAULT_TIMEOUT_MS, MAX_TIMER_MS } from "@shared/http/constants.js";
import { decideRetry, parseRetryAfter } from "@shared/http/decide-retry.js";
import { redactUrl } from "@shared/http/redact-url.js";

/**
 * The LAST delivery produced no response, and replays had happened.
 *
 * Say "the last" rather than "none of them", because an earlier delivery may
 * well have brought a response back: a 503 followed by two dropped connections
 * ends here, and the 503 is gone. That is deliberate — the last delivery is
 * the most recent thing known about the far side, and a server that answered a
 * moment ago and now refuses the connection is better described as unreachable
 * than as "returning 503". It also matches what retrying clients do when their
 * budget runs out: urllib3 raises rather than handing back an earlier
 * response.
 *
 * Thrown only when a replay actually happened. A failure on the very first
 * delivery carries no count worth reporting — "attempts: 1" states that the
 * request was made, which the caller knew — so that one is rethrown exactly as
 * it arrived.
 */
export class HttpRetryError extends Error {
  /**
   * How many times the request was handed to `fetch` before giving up.
   *
   * Handed to, not delivered. A request `fetch` refuses to build at all — a
   * GET carrying a body, say — never reaches the network, and those tries are
   * counted all the same. Measured: three attempts, zero bytes at the server.
   */
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

/** What only the caller can know, and this layer must therefore be told. */
export interface HttpRequestOptions {
  /**
   * Delivering this exact request again produces no additional side effects.
   *
   * A fact, not a preference. Only the caller knows that `POST /predictions`
   * spends the vendor's money a second time, and no amount of inspecting the
   * request would reveal it. Setting it true to "make things more reliable"
   * inverts its meaning and pays for it twice.
   */
  replaySafe: boolean;

  /**
   * How long ONE delivery may take, in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}.
   *
   * The caller's, because only the caller can work it out: a vendor timeout
   * comes from the model being called, an upload's from the size of the file.
   * This layer sees a url, some bytes and no context, so any figure it chose
   * would be overruling somebody who knows better. It was briefly not a
   * parameter, and the fixed figure that replaced it made a 2 GB upload
   * impossible rather than slow.
   *
   * It bounds the whole delivery, sending included, because the only lever
   * this API offers is an abort signal and aborting ends the whole operation.
   */
  timeoutMs?: number;

  /**
   * Raised when the caller no longer wants the result at all.
   *
   * Not a shorter deadline, and it does not replace one. A deadline says how
   * long ONE delivery may take and is renewed for each; this says the answer
   * is no longer wanted, and it holds for the whole call. The two are composed
   * per delivery, which is what keeps a single-shot signal from aborting every
   * later delivery before it leaves the ground.
   *
   * Optional because most callers have no way to be stopped. Passing nothing
   * leaves the behaviour exactly as it was: the call ends when it ends.
   */
  signal?: AbortSignal;
}

/**
 * Parse the target, or refuse it before anything is sent.
 *
 * One parse for the whole call, and the only place that decides whether a
 * string is a usable target. It used to be two: redaction parsed the string,
 * swallowed the failure, and reported it by returning a sentinel that this
 * function compared against — and then parsed the same string again. One fact
 * ("is this a URL?") travelling between two modules as a string, with the
 * exception that already carried it thrown away in between.
 *
 * Parseable is not fetchable, and each of the three refusals below earns its
 * place differently — measured on Node 24, one url per case, each carrying a
 * secret:
 *
 *   - Not a URL: `fetch` rejects with "Failed to parse URL from …" and the
 *     whole string is in the message.
 *   - Credentials in the url: `fetch` refuses to build the request at all and
 *     quotes the entire raw url, password and query key included.
 *   - A scheme this transport does not speak: no leak — "unknown scheme" and
 *     nothing else — but `ftp` and friends cost three deliveries and two
 *     backoffs to learn what the string already said, and `data:` is worse
 *     than that: it RESOLVES, 200, with no HTTP round trip at all.
 *
 * So the first two are about secrets and the third is about cost, and neither
 * reason covers both. None of the refusals quotes the string it refused —
 * whatever is wrong with a value, we cannot know which part of it was secret.
 * @param url - The request URL as the caller wrote it.
 * @returns The parsed URL, when it is one this transport can deliver.
 * @throws {Error} When the URL cannot be delivered as given.
 */
function acceptableTarget(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("http was given something that is not a URL");
  }
  // `fetch` refuses to build a Request from a URL carrying credentials at all,
  // and the TypeError it throws quotes the whole raw url. Measured: the
  // password and a query key both reached the caller through `cause` while the
  // message beside it was properly redacted. Both halves matter — a bearer
  // token is usually the username with no password beside it.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("http was given a URL carrying credentials; put them in a header instead");
  }
  // A `data:` URL is actually fetched and returned as a 200, which is not an
  // HTTP round trip at all; every other scheme costs three deliveries to learn
  // what the string already said. Refusing here is also what keeps redaction
  // simple: a non-http URL carries its payload in the pathname, and this is
  // the gate that stops one ever reaching a redactor built for origin + path.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`http was given a ${parsed.protocol} URL; this transport speaks http and https`);
  }
  return parsed;
}

/**
 * Whether this body can be handed to `fetch` a second time.
 *
 * Three rules, not an allow-list of types. A mutation pass showed the seven
 * type branches this replaces were all dead — the last rule already answered
 * for every one of them — and naming types got the answer WRONG for anything
 * unnamed, so a plain object that `fetch` re-serialises perfectly lost its
 * retries.
 * @param body - The body from the caller's fetch init.
 * @returns True when a replay would send the same bytes again.
 */
export function bodyCanBeResent(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return true;
  // A transferred buffer still passes `instanceof` while holding no bytes at
  // all. Nothing else distinguishes it — it is not walkable-once, it is empty
  // — so it needs its own question. `detached` is ES2024 and this repo targets
  // ES2023, so it exists at runtime but not in the type; `byteLength` cannot
  // substitute, since a transferred buffer and a genuinely empty one both
  // report 0 and an empty body is perfectly replayable.
  if (body instanceof ArrayBuffer) return !isDetached(body);
  if (ArrayBuffer.isView(body)) return !isDetached(body.buffer);
  // A source you can only walk once is spent by the first delivery. Two
  // questions, because no single one covers both single-use shapes:
  //
  //   - An async generator declares itself iterable, and so does a
  //     `ReadableStream` — but NOT on Safari, which has not shipped async
  //     iteration on streams (Chrome 124+ and Firefox have). Asking only this
  //     would call a Safari stream replayable and, once Safari allows a stream
  //     request body at all, quietly deliver an exhausted one the second time.
  //   - `getReader` is the method that makes a stream single-use, it is on
  //     every engine, and it survives crossing a realm the way `instanceof`
  //     does not.
  //
  // A string, a `Blob`, `FormData`, `URLSearchParams` and plain values answer
  // neither, which is why they keep their retries.
  if (typeof body !== "object") return true;
  return !(
    Symbol.asyncIterator in body ||
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
}

/**
 * Whether a buffer has been transferred away, leaving nothing to send.
 * @param buffer - The buffer behind the body, or the view's buffer.
 * @returns True when its bytes have been transferred elsewhere.
 */
function isDetached(buffer: ArrayBufferLike): boolean {
  return (buffer as { detached?: boolean }).detached === true;
}

/**
 * Wait, then let the loop try again — unless the caller gives up first.
 *
 * The subscription is torn down on both ways out, which matters more here than
 * anywhere else in this file: everything else a delivery creates dies with the
 * delivery, while this signal belongs to the caller and outlives the call. One
 * left attached per call is a leak that grows for as long as the caller keeps
 * making them.
 * @param ms - How long to wait.
 * @param signal - The caller's, when it has one. An already-raised signal
 *   returns without waiting at all.
 * @returns A promise that resolves once the delay has elapsed or the caller
 *   gave up, whichever happens first.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    /** End the wait, and leave nothing of it behind on the caller's signal. */
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The deadline to use, or a refusal if the caller named an impossible one.
 *
 * A timer holds a delay in a signed 32-bit integer and quietly rewrites
 * anything it cannot hold to ONE MILLISECOND, so passing such a figure straight
 * through turns "wait as long as this needs" into "abort immediately" —
 * measured, on a server that was answering fine. Refused here for the same
 * reason an undeliverable URL is: something unusable arrived, and spending
 * three deliveries to discover that helps nobody.
 *
 * The range is the whole test, and a fraction inside it passes. Measured on
 * Node 24: a timer given 1500.75 fires at 1500ms and one given 300000.5 at
 * 300011ms — it truncates and carries on. This guard briefly demanded a whole
 * number, on the strength of a measurement taken for Infinity and NaN and then
 * assumed to cover fractions too, which refused every deadline a caller
 * computed as `bytes / rate * 1000`. Truncation is why the floor is 1 rather
 * than 0: 0.5 truncates to zero, and zero is one of the values a timer rewrites.
 * @param asked - The caller's `timeoutMs`, if it gave one.
 * @returns The deadline in milliseconds.
 * @throws {Error} When the figure cannot be held by a timer.
 */
function usableDeadline(asked: number | undefined): number {
  const deadlineMs = asked ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_TIMER_MS) {
    throw new Error(
      `http was given a timeout of ${deadlineMs}; it must be between 1 and ${MAX_TIMER_MS} milliseconds`,
    );
  }
  return deadlineMs;
}

/**
 * Perform an HTTP request, replaying it when — and only when — the caller's
 * declared replay-safety and the failure together allow it.
 *
 * Returns the LAST response even when it is not ok, because whether an HTTP
 * error counts as a failure is a business decision rather than a transport
 * one: an agent tool wants the status of a 404, a vendor transport wants an
 * exception. A response is an answer; only the absence of one throws.
 *
 * The response comes back untouched and unheld. Read it or discard it — this
 * layer keeps no reference and no expectation either way.
 * @param url - Absolute http or https URL.
 * @param init - Standard fetch init (method, headers, body). Any `signal` on
 *   it is replaced by this call's own deadline.
 * @param options - What only the caller can know: whether a replay costs
 *   anything, and optionally how long this delivery may take.
 * @returns The final response, exactly as `fetch` produced it.
 * @throws {HttpRetryError} When replays happened and the LAST of them produced
 *   no response. Not "none of them" — an earlier delivery may well have brought
 *   one back, and {@link HttpRetryError} says why that one is not the answer.
 * @throws {Error} The original failure, unwrapped, when the first delivery
 *   failed and no replay followed; or a refusal when the URL cannot be sent.
 */
export async function httpRequest(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions,
): Promise<Response> {
  // Parsed once and redacted once, up front, because everything that names
  // this request uses both. Order is load-bearing: the refusal runs first, so
  // redaction only ever sees an http URL — which is why it can be four lines
  // with no special cases. Some vendors put their API key in the query
  // string, so the raw URL must not reach a message anyone might write down.
  const target = acceptableTarget(url);
  const safeUrl = redactUrl(target);
  const bodyReplayable = bodyCanBeResent(init.body);
  // The caller's figure when it gave one; ours only when it did not.
  const deadlineMs = usableDeadline(options.timeoutMs);

  // Unbounded by design: `decideRetry` owns the budget and refuses past
  // MAX_RETRIES, so the exit is the predicate rather than a second counter
  // that could disagree with it.
  for (let index = 0; ; index++) {
    const attempts = index + 1;
    // A fresh deadline per delivery is the whole point. An `AbortSignal` is
    // single-shot, so one signal reused across a retry loop aborts every later
    // delivery before it leaves the ground. Ours is created and cleared inside
    // this iteration, so nothing outlives it.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`http request to ${safeUrl} timed out`)),
      deadlineMs,
    );
    let response: Response | null = null;
    let failure: unknown = null;

    try {
      // Composed per delivery, never reused: the deadline's controller is
      // created fresh above, and the caller's is the same object every time
      // round. A composite made once and kept would carry the first delivery's
      // expiry into the second.
      response = await fetch(url, {
        ...init,
        signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      });
      if (response.ok) return response;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }

    // Asked ahead of the retry policy rather than inside it, because it is a
    // different kind of question and the policy has no way to answer it. A
    // delivery cut short by the caller produces no response, so the policy
    // sees no status, falls past every status-based exit, and lands on the
    // branch for a dropped connection — where a replay-safe request is told to
    // try again. What the policy decides is whether a replay would be correct;
    // what is asked here is whether anyone still wants the answer.
    const decision = options.signal?.aborted
      ? { retry: false as const }
      : decideRetry({
      ...(response !== null && { status: response.status }),
      ...(response !== null && {
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), Date.now()),
      }),
      replaySafe: options.replaySafe,
      bodyReplayable,
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
        `http request to ${safeUrl} failed after ${attempts} attempts`,
        attempts,
        failure,
      );
    }

    // The response we walk away from is deliberately left alone. Cancelling
    // its body would be this layer managing a body, which is the one thing it
    // does not do — and the client underneath already handles an unconsumed
    // response. Measured, and the size matters: ten unread 404s with small
    // bodies used two connections, but past undici's 64 KiB buffering
    // threshold reuse collapses. A caller discarding large ones should cancel
    // them (`response.body?.cancel()`).
    // The caller's signal ends the wait as well as the delivery. Ending only
    // the delivery leaves a call that has already decided to stop sitting out
    // a backoff it will do nothing with — a delay the user watches for no work
    // at all. The next pass round the loop finds the signal raised and takes
    // the exit above.
    await wait(decision.delayMs, options.signal);
  }
}
