// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A stand-in for `textToolsApi.stream` that the case drives by hand: each
 * call is recorded with its body and signal, and stays open until the case
 * sends `done`, fails it, or the caller aborts it. A case wraps `emit` and
 * `fail` in `act`, since each is something arriving from the network.
 */

import type { Mock } from 'vitest';

/** The handlers the client is called with, as far as the fake uses them. */
interface StreamHandlers {
  onEvent: (event: unknown) => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
}

/** One call to the stream, held open. */
export interface FakeStream {
  /** The request body the caller sent. */
  readonly body: Record<string, unknown>;
  /** The signal the caller handed over, if any. */
  readonly signal: AbortSignal | undefined;
  /**
   * Delivers a parsed frame, as the client hands it on.
   * @param event - The frame.
   */
  emit: (event: Record<string, unknown>) => void;
  /**
   * Fails the request the way the client reports a refusal, a drop or a
   * stream that closed with no end event.
   * @param err - What failed.
   */
  fail: (err?: unknown) => void;
}

/**
 * Makes a mocked `stream` record its calls and hold each open.
 * @param stream - The mock standing in for `textToolsApi.stream`.
 * @returns The calls, in order, filled in as they arrive.
 */
export function fakeStreams(stream: Mock): FakeStream[] {
  const calls: FakeStream[] = [];
  stream.mockImplementation((body: Record<string, unknown>, handlers: StreamHandlers) =>
    new Promise<void>((resolve) => {
      calls.push({
        body,
        signal: handlers.signal,
        emit: (event) => {
          handlers.onEvent(event);
          if (event['type'] === 'done' || event['type'] === 'error') resolve();
        },
        fail: (err = new Error('the stream dropped')) => {
          handlers.onError?.(err);
          resolve();
        },
      });
      handlers.signal?.addEventListener('abort', () => resolve());
    }));
  return calls;
}
