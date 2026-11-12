// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A stand-in for the run streams a page reads (inner#1717).
 *
 * Every `GET /chat/conversations/:id/stream` the page makes opens a stream the
 * case writes to frame by frame, or answers 204 when the case said no run
 * holds the conversation. Everything else the page asks of the server goes
 * through axios (`chatApi`), which a case doubles with `vi.spyOn`.
 */
import { vi } from 'vitest';

/** One run stream the page opened. */
export interface RunStream {
  conversationId: string;
  /** Put one protocol chunk on it. */
  push: (chunk: Record<string, unknown>) => void;
  /** End it, the way the server does once the run is over. */
  close: () => void;
  /** Break it, the way a dropped connection does. */
  breakOff: () => void;
  /** Whether the page has stopped reading it. */
  abandoned: () => boolean;
}

/** The stand-in. */
export interface RunWire {
  /** Every stream opened so far, in order. */
  streams: () => RunStream[];
  /** The stream opened last, or null. */
  last: () => RunStream | null;
  /** How many stream requests the page made, 204s included. */
  asked: () => number;
  /** Answer the next stream request with 204: no run holds the conversation. */
  noRunNext: () => void;
}

/** The path a run is read from, with the conversation captured. */
const STREAM_PATH = /\/chat\/conversations\/([^/]+)\/stream$/;

/**
 * Stub `fetch` for run streams.
 * @returns The stand-in.
 */
export function stubRunWire(): RunWire {
  const encoder = new TextEncoder();
  const streams: RunStream[] = [];
  let asked = 0;
  let noRun = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const match = STREAM_PATH.exec(String(url));
      if (match === null) throw new Error(`unexpected fetch of ${String(url)}`);
      asked += 1;
      if (noRun > 0) {
        noRun -= 1;
        return new Response(null, { status: 204 });
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let done = false;
      let abandoned = false;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          abandoned = true;
          done = true;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        abandoned = true;
        done = true;
      });
      streams.push({
        conversationId: decodeURIComponent(match[1]!),
        push: (chunk) => {
          if (!done) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        close: () => {
          if (done) return;
          done = true;
          controller.close();
        },
        breakOff: () => {
          if (done) return;
          done = true;
          controller.error(new TypeError('network error'));
        },
        abandoned: () => abandoned,
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }),
  );
  return {
    streams: () => streams,
    last: () => streams.at(-1) ?? null,
    asked: () => asked,
    noRunNext: () => {
      noRun += 1;
    },
  };
}

/** The beat every run stream opens with. */
export const BEAT = { type: 'data-heartbeat', transient: true, data: {} };

/**
 * The frames a run's reply opens with, as the server writes them.
 * @param textId - The text part's id.
 * @returns The frames.
 */
export function replyOpens(textId = 't1'): Array<Record<string, unknown>> {
  return [
    BEAT,
    { type: 'start', messageId: 'server-named' },
    { type: 'start-step' },
    { type: 'text-start', id: textId },
  ];
}

/**
 * The frames a reply that finished ends with.
 * @param textId - The text part's id.
 * @returns The frames.
 */
export function replyEnds(textId = 't1'): Array<Record<string, unknown>> {
  return [{ type: 'text-end', id: textId }, { type: 'finish-step' }, { type: 'finish' }];
}

/**
 * Let what the page does with what it was handed run its course.
 * @param times - How many macrotask turns to wait.
 */
export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}
