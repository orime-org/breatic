import { fetchEventSource } from '@microsoft/fetch-event-source';

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
 * httpOnly `breatic_session` cookie on the request (2026-05-26
 * cookie migration). No Bearer token is read from JS.
 *
 * Throws an immediate error if 4xx auth fails; otherwise retries on
 * transient network errors (handled by fetch-event-source defaults).
 *
 * Caller controls cancellation via an `AbortController` passed as
 * `signal` — closing the stream when the user clicks Abort.
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
      },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      openWhenHidden: true,
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
