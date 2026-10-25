// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { StreamingApi } from "hono/utils/stream";

/**
 * Open a streaming response whose work stops when the client goes away.
 *
 * On Node, hono hears a client leave only through the response body's
 * `cancel`, which `@hono/node-server` wires up once it starts sending the body.
 * A client gone before that (during a read-lock wait, or while its body was
 * still being read) is heard on the request's own signal alone, and a write to
 * the unsent body then waits forever: the turn never reaches the end where it
 * is recorded and charged. Both are routed into `StreamingApi.abort()`, which
 * drops every pending and later write and raises `signal`.
 * @param c - The request being answered.
 * @param run - Writes the stream. Hand `signal` to whatever produces it.
 * @param onError - Called with an error `run` throws.
 * @returns The streaming response.
 */
export function streamUntilClientLeaves(
  c: Context,
  run: (s: StreamingApi, signal: AbortSignal) => Promise<void>,
  onError?: (err: Error, s: StreamingApi) => Promise<void>,
): Response {
  return stream(
    c,
    async (s) => {
      const stopped = new AbortController();
      s.onAbort(() => {
        stopped.abort();
      });
      const left = c.req.raw.signal;
      if (left.aborted) {
        s.abort();
      } else {
        left.addEventListener(
          "abort",
          () => {
            if (!s.closed) s.abort();
          },
          { once: true },
        );
      }
      await run(s, stopped.signal);
    },
    onError,
  );
}
