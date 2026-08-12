// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getLocale, t } from '@breatic/shared';

import { API_BASE_PATH } from '@web/data/api/base-path';

/** The content-type of a stream that opened. Anything else is an answer. */
const EVENT_STREAM = 'text/event-stream';

/**
 * The request never reached the server.
 *
 * Offline, DNS, connection refused, the server not running. Nothing was sent,
 * so nothing was stored — not the reply, and not even the message the user
 * typed, which the server writes as the first thing inside the turn. Telling
 * these apart from a stream that opened and then died matters: one leaves a
 * half-written reply on the record, the other leaves no record at all.
 */
export class StreamUnreachableError extends Error {
  /**
   * Build one from whatever the transport threw.
   * @param cause - The underlying failure, kept for logs
   */
  constructor(readonly cause: unknown) {
    super('the request never reached the server');
    this.name = 'StreamUnreachableError';
  }
}

/**
 * The stream opened and then died before the server said it was done.
 *
 * The server sees this as the client going away and cannot tell it from the
 * user pressing stop, so it records the turn as stopped — whatever had been
 * written by then is on the record.
 */
export class StreamDroppedError extends Error {
  /**
   * Build one from whatever the transport threw.
   * @param cause - The underlying failure, kept for logs
   */
  constructor(readonly cause: unknown) {
    super('the stream died before the turn ended');
    this.name = 'StreamDroppedError';
  }
}

/**
 * A stream that was refused before it opened.
 *
 * The server answered, and what it answered with was not a stream. The status
 * is what tells the caller which refusal this is, and some of them are
 * recoverable — a conversation that is gone can be replaced, where a
 * permission failure cannot. Nothing was stored either way: the server writes
 * the user's own message inside the turn, which never ran.
 */
export class StreamRefusedError extends Error {
  /**
   * Build a refusal from what the server answered with.
   * @param status - The HTTP status the server answered with
   * @param message - What to tell the user, from the server when it said
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StreamRefusedError';
  }
}

/**
 * Decide what a non-streaming response means for the caller.
 *
 * The library's own `defaultOnOpen` looks at `content-type` and throws a
 * hardcoded English Error without reading the body — so the localised
 * `{error:{code,message}}` the server produced for a rejected body was being
 * discarded unread, and the user saw "Expected content-type to be
 * text/event-stream" instead of what was actually wrong.
 * @param response - The response that opened the stream.
 * @throws {StreamRefusedError} When the response is not a stream, carrying the
 *   status and the server's own message when it sent one.
 */
async function readEnvelopeOrOpen(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith(EVENT_STREAM)) return;

  let message: string | undefined;
  try {
    const body = (await response.json()) as
      | { error?: { message?: string } }
      | undefined;
    message = body?.error?.message;
  } catch {
    // A proxy answering with plain text, or a truncated body — there is
    // nothing of ours to read, so fall through to the generic message.
  }
  // Never the library's string: it is hardcoded English and names transport
  // details the user has no use for.
  throw new StreamRefusedError(response.status, message ?? t('server.error.internal'));
}

/**
 * Say how far this attempt got, which is what the caller has to act on.
 *
 * A caller can only tell the user the truth about an attempt it can tell
 * apart from the others: nothing sent, sent and refused, or sent and then cut
 * off. Handing all three over as one error is what makes a caller invent a
 * verdict, and inventing one is how the panel came to say a reply had been
 * stopped when no reply had ever been begun.
 * @param err - Whatever the transport threw
 * @param opened - Whether the stream had opened before this happened
 * @returns The same failure, said in terms of how far it got
 */
function classify(err: unknown, opened: boolean): Error {
  if (err instanceof StreamRefusedError) return err;
  return opened ? new StreamDroppedError(err) : new StreamUnreachableError(err);
}

interface SseOptions<TEvent> {
  /** Endpoint relative to `API_BASE_PATH` (or an absolute URL). */
  url: string;
  /** POST body sent with the open request. */
  body?: unknown;
  /** Parse each `data:` payload into the typed event. */
  parseEvent: (data: string) => TEvent | null;
  /** Called for every parsed event. */
  onEvent: (event: TEvent) => void;
  /** Called when the stream closes cleanly. */
  onClose?: () => void;
  /** Called on transport / parse / abort error. */
  onError?: (err: unknown) => void;
  /** Abort signal for caller-controlled cancellation. */
  signal?: AbortSignal;
}

/**
 * Server-Sent Events (SSE) wrapper around `@microsoft/fetch-event-source`.
 *
 * Used for streaming endpoints:
 *   - `POST /chat/message` — Agent chat token stream
 *   - `POST /mini-tools/text` — text mini-tool token stream
 *
 * Both are relative: this wrapper puts them under `API_BASE_PATH`, the same
 * prefix the axios instance uses, so the two transports cannot drift apart.
 *
 * Auth: `credentials: 'include'` makes the browser attach the
 * httpOnly session cookie on the request (2026-05-26
 * cookie migration). No Bearer token is read from JS.
 *
 * Throws an immediate error if 4xx auth fails; otherwise retries on
 * transient network errors (handled by fetch-event-source defaults).
 *
 * Caller controls cancellation via an `AbortController` passed as
 * `signal` — closing the stream when the user clicks Abort.
 * @param root0 - SSE connection options.
 * @param root0.url - Endpoint relative to `API_BASE_PATH`, or an absolute URL.
 * @param root0.body - POST body sent with the open request.
 * @param root0.parseEvent - Parses each `data:` payload into a typed event, or null to skip.
 * @param root0.onEvent - Invoked for every successfully parsed event.
 * @param root0.onClose - Invoked when the stream closes cleanly.
 * @param root0.onError - Invoked on transport / parse / abort error.
 * @param root0.signal - Abort signal for caller-controlled cancellation.
 * @returns A promise that resolves when the stream closes or is aborted.
 */
export async function sseStream<TEvent>({
  url,
  body,
  parseEvent,
  onEvent,
  onClose,
  onError,
  signal,
}: SseOptions<TEvent>): Promise<void> {
  const fullUrl = url.startsWith('http') ? url : `${API_BASE_PATH}${url}`;

  // Set once the response turned out to be a stream, which is what separates
  // "never reached the server" from "died on the way".
  let opened = false;

  try {
    await fetchEventSource(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // This wrapper does not go through the axios instance, so the header
        // that instance adds is not here — without it the server negotiates
        // from the browser's language rather than the one the user picked.
        'Accept-Language': getLocale(),
      },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      openWhenHidden: true,
      async onopen(response) {
        await readEnvelopeOrOpen(response);
        opened = true;
      },
      onmessage(msg) {
        if (!msg.data) return;
        const parsed = parseEvent(msg.data);
        if (parsed) onEvent(parsed);
      },
      onclose() {
        onClose?.();
      },
      onerror(err) {
        onError?.(classify(err, opened));
        // Re-throw so fetch-event-source stops retrying on hard errors.
        throw err;
      },
    });
  } catch (err) {
    // AbortError from caller is expected — swallow.
    if (signal?.aborted) return;
    onError?.(classify(err, opened));
  }
}
