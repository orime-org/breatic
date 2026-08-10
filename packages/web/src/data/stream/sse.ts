// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getLocale, t } from '@breatic/shared';

/** The content-type of a stream that opened. Anything else is an answer. */
const EVENT_STREAM = 'text/event-stream';

/**
 * Decide what a non-streaming response means for the caller.
 *
 * The library's own `defaultOnOpen` looks at `content-type` and throws a
 * hardcoded English Error without reading the body — so the localised
 * `{error:{code,message}}` the server produced for a rejected body was being
 * discarded unread, and the user saw "Expected content-type to be
 * text/event-stream" instead of what was actually wrong.
 * @param response - The response that opened the stream.
 * @throws {Error} When the response is not a stream, carrying the server's
 *   own message when it sent one.
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
  throw new Error(message ?? t('server.error.internal'));
}

interface SseOptions<TEvent> {
  /** Endpoint relative to `/api` (or absolute URL). */
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
 *   - `POST /api/chat/message` — Agent chat token stream
 *   - `POST /api/mini-tools/text` — text mini-tool token stream
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
 * @param root0.url - Endpoint relative to `/api`, or an absolute URL.
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
  const fullUrl = url.startsWith('http') ? url : `/api${url}`;

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
      onopen: readEnvelopeOrOpen,
      onmessage(msg) {
        if (!msg.data) return;
        const parsed = parseEvent(msg.data);
        if (parsed) onEvent(parsed);
      },
      onclose() {
        onClose?.();
      },
      onerror(err) {
        onError?.(err);
        // Re-throw so fetch-event-source stops retrying on hard errors.
        throw err;
      },
    });
  } catch (err) {
    // AbortError from caller is expected — swallow.
    if (signal?.aborted) return;
    onError?.(err);
  }
}
