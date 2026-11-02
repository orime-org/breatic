// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a connection ends after its request body was refused for being over a
 * limit (inner#1782): the public app's `request_body_max_bytes` and the
 * internal API's 64 KiB.
 *
 * The 413 says `Connection: close`, so the client sends nothing more on it.
 * The client may still be uploading, though, and closing a socket with
 * unread bytes makes the kernel answer with a reset that can wipe out the
 * 413 before the client reads it (RFC 9112 §9.6). So the close is staged
 * the way nginx's lingering close does it: once the 413 is written the
 * server half-closes, keeps reading and discarding the body, and closes when
 * the body ends or `request_body_linger_seconds` pass. A client that closes
 * first is closed by Node itself.
 *
 * Node has no option for this. For a response marked last (`Connection:
 * close`) its `resOnFinish` calls `socket.destroySoon()`, which ends and
 * destroys the socket as soon as the response is written; that one call is
 * replaced here. `@hono/node-server`'s drain calls it again after 500 ms,
 * which the replacement ignores.
 *
 * For an HTTP/1.1 pipelining client, bytes of a next request right behind
 * the refused body are still unread when the body ends and the socket
 * closes, and a request already parsed on the connection runs with its
 * answer queued behind the 413, which is never written. None of our clients
 * pipeline.
 */

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Context } from "hono";
import { getRequestBodyLingerSeconds } from "@server/config/limits.js";

/** Sockets whose close is already taken over; a socket is taken over once. */
const takenOver = new WeakSet<Socket>();

/**
 * Declare the close on a body-limit refusal and take over how the connection
 * ends. Call it before the 413 is built, so the header is on it.
 * @param c - The request context; `c.env.incoming` is node-server's request.
 * @throws {Error} when `config/limits.yaml` cannot be read or parsed, or holds
 * an invalid value (`z.ZodError`); it is read here, inside the request, so the
 * request answers 500 and the socket is left to Node.
 */
export function closeAfterRefusal(c: Context): void {
  c.header("Connection", "close");
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  const socket = incoming?.socket;
  if (!incoming || !socket || takenOver.has(socket)) return;
  const deadlineMs = getRequestBodyLingerSeconds() * 1000;
  takenOver.add(socket);
  socket.destroySoon = lingeringClose(socket, incoming, deadlineMs);
}

/**
 * The replacement for `socket.destroySoon`: half-close, read the rest of the
 * body, close when it ends or the deadline passes.
 * @param socket - The connection.
 * @param incoming - The refused request.
 * @param deadlineMs - How long to keep reading at most.
 * @returns The function to run where Node would destroy the socket.
 */
function lingeringClose(socket: Socket, incoming: IncomingMessage, deadlineMs: number): () => void {
  let started = false;
  /** Close now, whatever is still unwritten; a second call finds the socket destroyed. */
  const destroy = (): void => {
    if (!socket.destroyed) socket.destroy();
  };
  /** Close once the 413 is fully written; a destroy before that drops what is left of it. */
  const closeWhenWritten = (): void => {
    if (socket.writableFinished) destroy();
    else socket.once("finish", destroy);
  };
  return () => {
    if (started || socket.destroyed) return;
    started = true;
    socket.end();
    const deadline = setTimeout(destroy, deadlineMs);
    deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
    if (incoming.readableEnded) {
      closeWhenWritten();
      return;
    }
    // A body read through `Readable.toWeb` keeps its data listener, which
    // pauses the stream again as soon as the abandoned web stream is full.
    incoming.removeAllListeners("data");
    incoming.resume();
    incoming.once("end", closeWhenWritten);
  };
}
