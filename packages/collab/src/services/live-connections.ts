// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What this instance holds, indexed the way a socket-level event needs it.
 *
 * Two things are asked of this table and neither can be answered from the
 * per-document view the framework hands the hooks:
 *
 *   A pong, a ping or a message arrives on a SOCKET, and the seats it should
 *   refresh are spread across every document that socket carries. The listener therefore goes on
 *   once per socket, the first time this instance sees it — a socket carrying
 *   twenty documents must not end up with twenty listeners refreshing the
 *   same seats twenty times per ping.
 *
 *   A demote request names a document and a socket, and arrives from whatever
 *   instance ran that handshake. Answering it means asking whether this
 *   process is the one holding that connection.
 */

import type * as Y from "yjs";

/**
 * The socket events crossws counts as the socket being alive (`markAlive` in
 * its node adapter): a socket showing any of them is never closed for
 * silence, so any of them refreshes what the socket holds.
 */
const SIGNS_OF_LIFE = ["pong", "ping", "message"] as const;

/**
 * The subset of a Hocuspocus Connection this table stores.
 *
 * Every field here is one the framework's `Connection` really declares
 * (`@hocuspocus/server`'s `index.d.ts`), apart from the socket's emitter
 * methods: its `WebSocketLike` declares only `send`, `close` and `readyState`,
 * while the object the node adapter hands over is an `ws` socket that emits.
 * That one gap is the whole reason a cast is needed at all, and nothing
 * verifies it at runtime — what does verify it is
 * `connection-liveness.integration.test.ts`, which stands up a real server,
 * measures the pongs arriving and keeps a seat on messages alone.
 */
export interface HeldConnection {
  /** Whether the framework refuses writes on this connection. */
  readOnly: boolean;
  /** Whatever `onAuthenticate` resolved for this connection. */
  context?: { user?: { id?: string } };
  /** The document this connection is for. */
  document: Y.Doc;
  /** The underlying socket. */
  webSocket: {
    send(data: Uint8Array): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    off?(event: string, listener: (...args: unknown[]) => void): unknown;
  };
}

/** Options for {@link createLiveConnections}. */
export interface LiveConnectionsOptions {
  /**
   * Called when the socket shows a sign of life (a pong, a ping or any
   * message), as often as `pingIntervalMs` allows, with the socket and
   * everything it carries. This is the evidence a connection is still there,
   * the same the transport keeps the socket open on: every seat that socket
   * holds rides on it, and so does the presence record of whoever owns its
   * meta connection.
   */
  onPong: (
    socketId: string,
    connections: ReadonlyMap<string, HeldConnection>,
  ) => void;
  /**
   * How often the transport pings each connection. A sign of life less than
   * half of this after the last one handled on its socket waits until half a
   * period has passed, and further early ones while one waits are dropped: a
   * client sends messages as often as it likes and RFC 6455 lets it send
   * pongs unasked, and each handled one runs a seat script per document on
   * the Redis every tenant shares. The waiting one is not dropped, because it
   * may be the only answer to a ping, and the seat expires two periods after
   * the last one handled.
   */
  pingIntervalMs: number;
  /**
   * Clock the gap between signs of life is measured with, injectable for tests
   * (default `performance.now`). Monotonic, so a step of the system clock
   * cannot hold back the next one.
   */
  now?: () => number;
}

/** This instance's connections, indexed by socket (see module doc). */
export interface LiveConnections {
  /**
   * Record a connection and, the first time this socket is seen, start
   * listening for its signs of life.
   * @param socketId - The socket carrying it.
   * @param documentName - The document this connection is for.
   * @param connection - The connection itself.
   * @returns Nothing.
   */
  remember(
    socketId: string,
    documentName: string,
    connection: HeldConnection,
  ): void;
  /**
   * The connection this instance holds for that document on that socket.
   * @param documentName - The document.
   * @param socketId - The socket.
   * @returns The connection, or undefined when it belongs elsewhere.
   */
  find(documentName: string, socketId: string): HeldConnection | undefined;
  /**
   * Drop one connection. The socket's entry stays, with its listeners,
   * until the socket itself closes: a socket whose last document left can
   * open another, and that one's seats ride the same listener.
   * @param socketId - The socket.
   * @param documentName - The document whose connection ended.
   * @returns Nothing.
   */
  forget(socketId: string, documentName: string): void;
}

/**
 * Build the per-socket connection table.
 * @param options - See {@link LiveConnectionsOptions}.
 * @returns A {@link LiveConnections}.
 */
export function createLiveConnections(
  options: LiveConnectionsOptions,
): LiveConnections {
  const { onPong, pingIntervalMs, now = (): number => performance.now() } = options;
  const minPongGapMs = pingIntervalMs / 2;

  const bySocket = new Map<string, Map<string, HeldConnection>>();

  return {
    remember(
      socketId: string,
      documentName: string,
      connection: HeldConnection,
    ): void {
      let entry = bySocket.get(socketId);
      if (!entry) {
        const held = new Map<string, HeldConnection>();
        entry = held;
        bySocket.set(socketId, held);
        // The socket's own events. crossws swallows its heartbeat pong before
        // dispatching its own hook, but that early return leaves only
        // crossws's handler — every other listener on the emitter still
        // fires. No extra frames on the wire; the only timer is the one
        // holding back an early sign of life.
        let lastHandledAt = -Infinity;
        let deferred: ReturnType<typeof setTimeout> | undefined;
        /** Refresh what this socket holds, because it is still there. */
        const handle = (): void => {
          deferred = undefined;
          lastHandledAt = now();
          onPong(socketId, held);
        };
        /**
         * Handle a sign of life now, or, within half a period of the last one
         * handled, once half a period has passed (see `pingIntervalMs`).
         */
        const alive = (): void => {
          const wait = lastHandledAt + minPongGapMs - now();
          if (wait <= 0) {
            clearTimeout(deferred);
            handle();
          } else if (deferred === undefined) {
            deferred = setTimeout(handle, wait);
          }
        };
        for (const event of SIGNS_OF_LIFE) connection.webSocket.on(event, alive);
        connection.webSocket.once("close", () => {
          clearTimeout(deferred);
          for (const event of SIGNS_OF_LIFE) connection.webSocket.off?.(event, alive);
          bySocket.delete(socketId);
        });
      }
      entry.set(documentName, connection);
    },

    find(documentName: string, socketId: string): HeldConnection | undefined {
      return bySocket.get(socketId)?.get(documentName);
    },

    forget(socketId: string, documentName: string): void {
      bySocket.get(socketId)?.delete(documentName);
    },
  };
}
