// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * provider's own HTTP (design 2.2): the one place that calls the platform
 * `fetch`. It decides whether a request may be sent again, keeps every
 * delivery inside the caller's signal and deadline, reads bodies within
 * limits, and hands failures over in three classes: NotSent, NoAnswer and
 * HttpStatus.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Aborted, BodyTooLarge, HttpStatus, NoAnswer, NotSent } from "@provider/http/errors.js";

/** One outgoing request. */
export interface OutgoingRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** What the caller decides about one request (design 2.2). */
export interface SendOptions {
  /** True only when sending again has no second side effect (queries, billing reads). Submits are false. A 408 or 429 is resent either way: the server did not process it. */
  replaySafe: boolean;
  signal?: AbortSignal;
  /** Epoch ms after which nothing is sent and anything in flight is cut. */
  deadlineAt?: number;
}

/** Limits for reading a JSON body. */
export interface ReadOptions extends SendOptions {
  maxBodyBytes: number;
  /** Fail when no bytes arrive for this long. */
  idleMs: number;
}

/** Deliveries a request gets in all: any request on a 408 or 429, a replay-safe one also on NotSent, NoAnswer and 5xx. */
const MAX_DELIVERIES = 3;
/** Base of the full-jitter exponential backoff between deliveries. */
const BASE_DELAY_MS = 1_000;
/** A Retry-After longer than this is not waited for. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** The longest delay a timer holds; a longer one fires at once, so a deadline beyond it sets no timer. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long a request beside a call may take: a cost lookup, a file delete. */
export const SIDE_REQUEST_MS = 30_000;
/** Error codes that mean the request never left this machine. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Every error code on an error, its causes and an aggregate's members.
 * @param error - The error.
 * @returns The codes found.
 */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  /**
   * Collect the codes of one value and what it wraps.
   * @param value - The value.
   */
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    const { code, cause, errors } = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === "string") codes.push(code);
    walk(cause);
    if (Array.isArray(errors)) errors.forEach(walk);
  };
  walk(error);
  return codes;
}

/**
 * The provider failure class of a platform fetch error.
 * @param url - Where the request was going.
 * @param error - What fetch threw.
 * @returns NotSent when every code says the connection was never made, NoAnswer otherwise.
 */
function classify(url: string, error: unknown): NotSent | NoAnswer {
  const codes = codesOf(error);
  return codes.length > 0 && codes.every((code) => NOT_SENT_CODES.has(code)) ? new NotSent(url, error) : new NoAnswer(url, error);
}

/**
 * The signal one delivery runs under: the caller's, and the deadline.
 * @param options - The caller's signal and deadline.
 * @returns The combined signal and a disposer for its timer.
 */
export function boundSignal(options: Pick<SendOptions, "signal" | "deadlineAt">): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  /**
   * End the delivery.
   */
  const onAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  const left = options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now();
  const timer = left > MAX_TIMER_MS ? undefined : setTimeout(onAbort, Math.max(0, left));
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Whether the caller's bounds have ended.
 * @param options - The caller's signal and deadline.
 * @returns True when the signal fired or the deadline passed.
 */
function ended(options: SendOptions): boolean {
  return options.signal?.aborted === true || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt);
}

/** Delay-seconds, the first form RFC 9110 10.2.3 allows. */
const DELAY_SECONDS = String.raw`\d+`;
/** IMF-fixdate, the second form, as `toUTCString` writes it. */
const IMF_FIXDATE = String.raw`[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT`;
/** One legal value, possibly sent more than once with the same content (Headers.get joins repeats with commas). */
const ONE_VALUE_POSSIBLY_REPEATED = new RegExp(`^(${DELAY_SECONDS}|${IMF_FIXDATE})(?:,\\s*\\1)*$`);
/** The seconds form on its own. */
const IS_DELAY_SECONDS = new RegExp(`^${DELAY_SECONDS}$`);

/**
 * A Retry-After header in milliseconds, read as shared's parseRetryAfter reads it: delay-seconds
 * or an IMF-fixdate that writes itself back unchanged (Date.parse rolls impossible days, ignores
 * the weekday and truncates seconds), identical repeats allowed, a date already past naming none.
 * @param raw - The header.
 * @returns The delay, or undefined when absent, malformed or past.
 */
export function retryAfterOf(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const matched = ONE_VALUE_POSSIBLY_REPEATED.exec(raw.trim());
  if (matched === null) return undefined;
  const value = matched[1]!;
  if (IS_DELAY_SECONDS.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  if (new Date(at).toUTCString() !== value) return undefined;
  const wait = at - Date.now();
  return wait > 0 ? wait : undefined;
}

/**
 * Whether a status says the server's own side failed: 500 to 599, no class above it.
 * @param status - The status.
 * @returns True for 5xx.
 */
export function isServerError(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Whether a status may be resent. A 408 or 429 says the server did not process the
 * request, so it is resent whatever the caller declared; a 5xx only for a replay-safe one.
 * @param status - The status.
 * @param replaySafe - Whether the caller declared the request safe to send again.
 * @returns True when the request may go again.
 */
function resendable(status: number, replaySafe: boolean): boolean {
  return status === 408 || status === 429 || (replaySafe && isServerError(status));
}

/**
 * Wait, ending early when the caller's bounds end.
 * @param ms - How long.
 * @param options - The caller's signal and deadline.
 * @param url - For the error.
 * @throws {Aborted} When the bounds end first.
 */
export async function wait(ms: number, options: SendOptions, url: string): Promise<void> {
  const { signal, dispose } = boundSignal(options);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      /**
       * End the wait early.
       */
      const stop = (): void => {
        clearTimeout(timer);
        reject(new Aborted(url));
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  } finally {
    dispose();
  }
}

/**
 * One delivery.
 * @param request - The request.
 * @param options - The caller's bounds.
 * @returns The response, its body still open; the bounds keep cutting it until it is read.
 * @throws {NotSent} When the request never left.
 * @throws {NoAnswer} When no response came.
 * @throws {Aborted} When the bounds ended.
 */
export async function deliver(request: OutgoingRequest, options: SendOptions): Promise<Response> {
  if (ended(options)) throw new Aborted(request.url);
  const { signal, dispose } = boundSignal(options);
  try {
    const response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
      redirect: "manual",
    });
    // The deadline keeps cutting the body; the timer is released once it is read.
    return withRelease(response, dispose);
  } catch (error) {
    dispose();
    if (signal.aborted) throw new Aborted(request.url);
    throw classify(request.url, error);
  }
}

/**
 * A response whose body releases the delivery's timer when it ends.
 * @param response - The response.
 * @param release - Called once the body is done or cancelled.
 * @returns The same response, its body wrapped.
 */
function withRelease(response: Response, release: () => void): Response {
  if (response.body === null) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  // A Response cannot be built with a status past 599, which a server may still send; it is
  // built at 599 and given the status that came.
  const inRange = response.status >= 200 && response.status <= 599;
  const wrapped = new Response(body, { status: inRange ? response.status : 599, statusText: response.statusText, headers: response.headers });
  if (!inRange) Object.defineProperty(wrapped, "status", { value: response.status });
  return wrapped;
}

/**
 * Send a request and hand back the response, whatever its status.
 * @param request - The request.
 * @param options - Replay, abort and deadline.
 * @returns The response.
 * @throws {NotSent} When the request never left.
 * @throws {NoAnswer} When it was sent and no response came.
 * @throws {Aborted} When the signal fired or the deadline passed.
 */
export async function send(request: OutgoingRequest, options: SendOptions): Promise<Response> {
  for (let delivery = 1; ; delivery++) {
    const last = delivery >= MAX_DELIVERIES;
    let response: Response;
    try {
      response = await deliver(request, options);
    } catch (error) {
      // A replay-safe request is sent again whether it never left or got no answer (RFC 9110 9.2.2).
      if (last || !options.replaySafe || !(error instanceof NotSent || error instanceof NoAnswer)) throw error;
      await wait(backoff(delivery), options, request.url);
      continue;
    }
    if (last || !resendable(response.status, options.replaySafe)) return response;
    const asked = retryAfterOf(response.headers.get("retry-after"));
    if (asked !== undefined && asked > MAX_RETRY_AFTER_MS) return response;
    await response.body?.cancel();
    await wait(asked ?? backoff(delivery), options, request.url);
  }
}

/**
 * The full-jitter delay before the next delivery.
 * @param delivery - The delivery just made, from 1.
 * @returns Milliseconds.
 */
export function backoff(delivery: number): number {
  return Math.random() * BASE_DELAY_MS * 2 ** (delivery - 1);
}

/**
 * Read a body within a byte limit and an idle limit.
 * @param url - Where it came from.
 * @param response - The response.
 * @param maxBytes - The most bytes read.
 * @param idleMs - The longest wait for the next bytes.
 * @param options - The caller's bounds.
 * @returns The bytes.
 * @throws {BodyTooLarge} When the body exceeds the limit.
 * @throws {NoAnswer} When the body stalls or breaks.
 * @throws {Aborted} When the bounds end.
 */
export async function readBody(url: string, response: Response, maxBytes: number, idleMs: number, options: SendOptions): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<"idle">((resolve) => {
      if (idleMs <= MAX_TIMER_MS) timer = setTimeout(() => resolve("idle"), idleMs);
    });
    let next: ReadableStreamReadResult<Uint8Array> | "idle";
    try {
      next = await Promise.race([reader.read(), idle]);
    } catch (error) {
      if (ended(options)) throw new Aborted(url);
      throw new NoAnswer(url, error);
    } finally {
      clearTimeout(timer);
    }
    if (next === "idle") {
      await reader.cancel().catch(() => undefined);
      throw new NoAnswer(url, new Error(`no bytes for ${idleMs} ms`));
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(url, maxBytes);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * Send a request and read a JSON body within limits; any non-2xx is a failure.
 * @param request - The request.
 * @param options - Replay, abort, deadline and body limits.
 * @returns The parsed body.
 * @throws {NotSent} When the request never left.
 * @throws {NoAnswer} When no complete answer came.
 * @throws {HttpStatus} When the status is not 2xx (after any allowed resends).
 * @throws {BodyTooLarge} When the body exceeds the limit.
 * @throws {Aborted} When the signal fired or the deadline passed.
 * @throws {SyntaxError} When a 2xx body is not JSON.
 */
export async function fetchJson(request: OutgoingRequest, options: ReadOptions): Promise<unknown> {
  const response = await send(request, options);
  const bytes = await readBody(request.url, response, options.maxBodyBytes, options.idleMs, options);
  const text = new TextDecoder().decode(bytes);
  if (response.status < 200 || response.status >= 300) {
    throw new HttpStatus(request.url, response.status, text);
  }
  return JSON.parse(text) as unknown;
}

/** Where a copy of each answer aiSdkFetch hands back goes, inside a `tapAnswers` scope. */
const answerTaps = new AsyncLocalStorage<(copy: Response) => void>();

/**
 * Run a model call with a copy of every answer its SDK fetches handed to `tap`, for an
 * answer the SDK throws without its body (a 2xx whose body is an error).
 * @param tap - Takes each copy; it must read or cancel it.
 * @param run - The call.
 * @returns What the call returned.
 * @throws {unknown} What the call threw.
 */
export async function tapAnswers<T>(tap: (copy: Response) => void, run: () => Promise<T>): Promise<T> {
  return answerTaps.run(tap, run);
}

/**
 * The `fetch` handed to AI SDK providers: every response is returned as is, and only
 * NotSent and NoAnswer are thrown, so they survive on the `cause` chain of AI SDK's
 * own error (design 2.2, S2). An abort is rethrown as the platform raised it, so the
 * SDK reads it as an abort.
 * @param input - The request target.
 * @param init - The request options.
 * @returns The response, whatever its status.
 * @throws {NotSent} When the request never left.
 * @throws {NoAnswer} When it was sent and no response came.
 * @throws {Error} The platform's abort error when the request's signal fired.
 */
export async function aiSdkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  let response: Response;
  try {
    response = await globalThis.fetch(input, init);
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    throw classify(url, error);
  }
  answerTaps.getStore()?.(response.clone());
  return response;
}
