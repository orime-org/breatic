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
  /**
   * Make the next request be refused instead of opening a stream.
   *
   * Here rather than by stubbing `fetch` a second time: a case that wants one
   * turn to succeed and the next to be refused cannot swap the stub between
   * them -- the `Chat` has already taken the transport built over the first
   * one, and the second stub is never reached. Which is a thing worth saying
   * out loud, because a case written that way reads as though it works and
   * quietly runs both turns against the first answer.
   * @param status - The status to refuse with.
   * @param message - The sentence the server writes for the reader.
   */
  refuseNext: (status: number, message: string) => void;
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
  let refusal: { status: number; message: string } | null = null;
  const bodies: Array<Record<string, unknown>> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (refusal) {
        const { status, message } = refusal;
        refusal = null;
        return new Response(JSON.stringify({ error: { code: status, message } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
    refuseNext: (status, message) => {
      refusal = { status, message };
    },
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

/** The frame the server opens every stream with, before anything else. */
export const OPENING_BEAT = { type: 'data-heartbeat', transient: true, data: {} };

/**
 * The chunks a turn opens with, before any of its content.
 *
 * In the order the server writes them, and the first one matters: the route
 * writes a heartbeat the moment there is a socket, before the interval starts
 * (`routes/chat.ts:141`). It is transient, so the SDK hands it to `onData` and
 * drops it there -- it is the one frame that arrives without the turn having
 * said anything.
 *
 * A double that started at `start` was not a shorter version of the real
 * opening but a different one, and it is the reason a defect about which
 * frame counts as the first went through a full round of review green.
 * @param textId - The id the text part of this turn is written under.
 * @returns Those chunks, in order.
 */
export function turnOpens(textId = 't1'): Array<Record<string, unknown>> {
  return [
    OPENING_BEAT,
    // What the route writes next, on every turn: the conversation answers
    // with the name it has, so this goes out even when the name did not
    // change (`main-agent.ts`, the first line of `execute`). It is not
    // transient, so it is the frame that moves the status.
    { type: 'data-conversation-titled', data: { title: 'a title' } },
    // With an id, which is how it arrives: `handleUIMessageStreamFinish`
    // gives every `start` one. A bare `start` takes a different path in the
    // SDK -- it pushes no assistant message at all -- so a double that sent
    // one was testing a stream no server produces.
    { type: 'start', messageId: 'm-reply' },
    { type: 'start-step' },
    { type: 'text-start', id: textId },
  ];
}

/**
 * The chunks a turn ends with, after all of its content.
 *
 * Here for the same reason as {@link turnOpens}: what a case runs against
 * should be the stream the server writes, not a shorter one that happens to
 * work. A double that opened differently from the server is how a defect
 * about which frame counts as the first went through a whole round of review
 * green.
 *
 * They are not what ends the turn, and it is worth saying so because the
 * commit that added this claimed they were. Closing the stream is enough on
 * its own -- measured by emptying this function out, after which all of
 * `turn-lifecycle.test.ts` still passes. What that commit actually fixed was
 * `settle()`, which spun too few microtasks to carry a closed stream through
 * to `status === 'ready'` and left turns stopped halfway, where they look
 * exactly like turns still running.
 * @returns Those chunks, in order.
 */
export function turnEnds(): Array<Record<string, unknown>> {
  return [{ type: 'finish-step' }, { type: 'finish' }];
}
