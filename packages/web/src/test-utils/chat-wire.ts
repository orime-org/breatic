// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A turn's stream, held open by the test rather than by a server.
 *
 * Every chat case that has a turn in it needs the same thing: a `fetch` that
 * answers with a stream the case can push protocol chunks into, one at a time,
 * and read back what went out in the request. Written once because a second
 * copy is a second harness to keep in step with the protocol -- and because
 * what these cases are about is everything above `fetch`, which is real:
 * the transport parses the frames, the `Chat` state machine holds them, and
 * the hook renders what it holds.
 *
 * Not a test file itself: it lives in `src/`, so it is linted and typed like
 * anything else, and its own comments are in English for that reason.
 */
import { vi } from 'vitest';

/** One turn's stream, from the test's end of it. */
export interface ChatWire {
  /** Put one protocol chunk on it. */
  push: (chunk: Record<string, unknown>) => void;
  /** End it, the way a server that has finished does. */
  close: () => void;
}

/** What a stubbed `fetch` hands back to whoever is watching. */
export interface WatchedWire {
  /** The stream of the turn that is running, or null before one goes out. */
  current: () => ChatWire | null;
  /** Every request body that went out, in order. */
  sent: () => Array<Record<string, unknown>>;
  /** The abort signal of the turn that is running. */
  signal: () => AbortSignal | null | undefined;
}

/**
 * Stub `fetch` with one that answers every turn with a held-open stream.
 *
 * Undo it with `vi.unstubAllGlobals()`, which is what an `afterEach` doing
 * that already covers.
 * @returns Handles on the stream, the bodies sent, and the signal.
 */
export function stubChatWire(): WatchedWire {
  const encoder = new TextEncoder();
  let wire: ChatWire | null = null;
  let signal: AbortSignal | null | undefined;
  const bodies: Array<Record<string, unknown>> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      wire = {
        push: (chunk) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        close: () => {
          controller.close();
        },
      };
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );

  return {
    current: () => wire,
    sent: () => bodies,
    signal: () => signal,
  };
}

/**
 * Stub `fetch` with one that refuses every turn the way our server refuses.
 *
 * The envelope matters and is not a detail: our error handler answers
 * `{ error: { code, message } }` (`middleware/error-handler.ts`), and a double
 * that answers some other shape lets a reader of that shape pass while the
 * real one fails. That is exactly what happened once.
 * @param status - The status to refuse with.
 * @param message - The sentence the server writes for the reader.
 */
export function stubRefusingWire(status: number, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: status, message } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

/**
 * The chunks a turn opens with, before any of its content.
 *
 * Named because every case that wants a reply on screen has to send them, and
 * a case that forgets one gets a turn that never leaves `submitted` -- which
 * looks like the thing being tested failing.
 * @param textId - The id the text part of this turn is written under.
 * @returns Those chunks, in order.
 */
export function turnOpens(textId = 't1'): Array<Record<string, unknown>> {
  return [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: textId },
  ];
}
