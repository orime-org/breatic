// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Dispatchers for Node's `fetch` (inner#1367).
 *
 * Two of undici's defaults decide how a request on a task chain ends, and
 * neither is ours to keep: `headersTimeout` gives up on an answer after 300s
 * however much of the task's two hours is left, and nothing at all notices a
 * send whose peer stopped reading. These are the two dispatchers that replace
 * them.
 */

import { Agent, buildConnector } from "undici";

/**
 * A dispatcher whose sockets are cut once no byte has moved either way for
 * `idleMs` — an IO idle timeout, the way rclone's `--timeout` and the AWS
 * SDK's `socketTimeout` judge a stalled transfer.
 *
 * Judged on the socket because that is the only place Node can see it: a
 * streamed request body is pulled into memory whatever the socket is doing,
 * so counting what the client pulls hears nothing when the peer stops reading.
 * @param idleMs - How long the socket may go without a byte moving.
 * @returns The dispatcher, to pass as the fetch init's `dispatcher`.
 */
export function idleSocketDispatcher(idleMs: number): Agent {
  const connect = buildConnector({});
  return new Agent({
    connect(options, callback): void {
      connect(options, (err, socket) => {
        if (err !== null || socket === null) {
          callback(err ?? new Error("connection failed"), null);
          return;
        }
        socket.setTimeout(idleMs, () =>
          socket.destroy(new Error(`no bytes moved for ${idleMs}ms`)),
        );
        callback(null, socket);
      });
    },
  });
}

/**
 * A dispatcher that waits for an answer as long as the caller lets it.
 *
 * `headersTimeout` is switched off: every call made through it is bounded by
 * its caller instead — the transport's own `timeoutMs`, or a task's deadline
 * passed as the signal. `bodyTimeout` keeps undici's default, which is itself
 * an idle window on reading the answer.
 * @returns The dispatcher, for the process-wide `setGlobalDispatcher`.
 */
export function deadlineBoundDispatcher(): Agent {
  return new Agent({ headersTimeout: 0 });
}
