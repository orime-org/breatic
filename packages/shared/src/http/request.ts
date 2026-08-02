// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One HTTP request, replayed when a replay is warranted.
 *
 * The whole of it: the caller says where to connect and what to send, plus the
 * one fact this layer cannot work out for itself — whether sending the same
 * request twice costs anything. Everything after that is this layer's own
 * business. Network trouble is handled here. If it cannot be handled, the
 * caller is told what went wrong. If it can, the caller gets the response.
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
 *   - No injected wait, no label, no timeout argument. The first was a test
 *     seam on a production surface; the others were things this layer can
 *     answer for itself.
 *
 * It does not read the body — how long, how big and how to stop are the
 * caller's, and the client underneath already times a stalled read (measured:
 * Node's fetch rejects a server that sends headers then goes silent, after
 * 301s, with UND_ERR_BODY_TIMEOUT). It does not log — library packages report
 * by returning and throwing. And it does not say why it stopped: a response IS
 * the answer, and a caller that wants to branch reads the status it has.
 */

import { HEADERS_TIMEOUT_MS } from "@shared/http/constants.js";
import { decideRetry, parseRetryAfter } from "@shared/http/decide-retry.js";
import { redactUrl } from "@shared/http/redact-url.js";

/**
 * Every delivery failed and none produced a response.
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

/** The one thing the caller must state and this layer cannot work out. */
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
 * Parseable is not fetchable, and the difference is expensive both ways.
 * Sending an undeliverable string costs three deliveries and two backoffs —
 * and the rejection `fetch` produces quotes the RAW url, so a password or a
 * query key travels out in a message that never passed through redaction and
 * then becomes the `cause` this package tells callers to log.
 *
 * None of the three refusals quotes the string. That is the point of refusing
 * here rather than letting `fetch` do it: whatever is wrong with the value, we
 * cannot know which part of it was a secret.
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
 * Wait, then let the loop try again.
 *
 * A bare timer, and that is the point. There is no signal to honour and
 * nothing to detach: the only thing that ends a wait is the wait finishing.
 * @param ms - How long to wait.
 * @returns A promise that resolves once the delay has elapsed.
 */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
 * @param options - The one fact only the caller knows.
 * @returns The final response, exactly as `fetch` produced it.
 * @throws {HttpRetryError} When replays happened and none produced a response.
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
      HEADERS_TIMEOUT_MS,
    );
    let response: Response | null = null;
    let failure: unknown = null;

    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }

    const decision = decideRetry({
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
    await wait(decision.delayMs);
  }
}
