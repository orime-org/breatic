// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What this instance holds, indexed the way a socket-level event needs it.
 *
 * Two things are asked of this table and neither can be answered from the
 * per-document view the framework hands the hooks:
 *
 *   A pong arrives on a SOCKET, and the seats it should refresh are spread
 *   across every document that socket carries. The listener therefore goes on
 *   once per socket, the first time this instance sees it — a socket carrying
 *   twenty documents must not end up with twenty listeners refreshing the
 *   same seats twenty times per ping.
 *
 *   A demote request names a document and a socket, and arrives from whatever
 *   instance ran that handshake. Answering it means asking whether this
 *   process is the one holding that connection.
 *
 * The moment a socket was first seen is kept here too. It is what tells one
 * of a person's connections from another when the handshake picks which seat
 * to take, and it belongs to the socket rather than to any one document on
 * it: every document on a socket arrived on the same connection.
 */

import type * as Y from "yjs";

/**
 * The subset of a Hocuspocus Connection this table stores.
 *
 * Every field here is one the framework's `Connection` really declares
 * (`@hocuspocus/server`'s `index.d.ts`), apart from the socket's emitter
 * methods: its `WebSocketLike` declares only `send`, `close` and `readyState`,
 * while the object the node adapter hands over is an `ws` socket that emits.
 * That one gap is the whole reason a cast is needed at all, and
 * {@link createLiveConnections} checks for it before relying on it.
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
   * Called once per pong, with the socket that answered and everything it
   * carries. This is the only evidence a connection is still there: every
   * seat that socket holds rides on it, and so does the presence record of
   * whoever owns its meta connection.
   */
  onPong: (
    socketId: string,
    connections: ReadonlyMap<string, HeldConnection>,
  ) => void;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
}

/** This instance's connections, indexed by socket (see module doc). */
export interface LiveConnections {
  /**
   * Record a connection and, the first time this socket is seen, start
   * listening for its pongs.
   * @param socketId - The socket carrying it.
   * @param documentName - The document this connection is for.
   * @param connection - The connection itself.
   * @returns The moment this socket was first seen, in epoch ms.
   */
  remember(
    socketId: string,
    documentName: string,
    connection: HeldConnection,
  ): number;
  /**
   * The connection this instance holds for that document on that socket.
   * @param documentName - The document.
   * @param socketId - The socket.
   * @returns The connection, or undefined when it belongs elsewhere.
   */
  find(documentName: string, socketId: string): HeldConnection | undefined;
  /**
   * Drop one connection; the socket's entry goes when its last one does.
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
  const { onPong, now = Date.now } = options;

  interface SocketEntry {
    connectedAtMs: number;
    connections: Map<string, HeldConnection>;
  }

  const bySocket = new Map<string, SocketEntry>();

  return {
    remember(
      socketId: string,
      documentName: string,
      connection: HeldConnection,
    ): number {
      let entry = bySocket.get(socketId);
      if (!entry) {
        const held: SocketEntry = {
          connectedAtMs: now(),
          connections: new Map(),
        };
        entry = held;
        bySocket.set(socketId, held);
        // The socket's own pong. crossws swallows it before dispatching its
        // own hook, but that early return leaves only crossws's handler —
        // every other listener on the emitter still fires. No timer of ours
        // and no extra frames on the wire.
        /**
         * Refresh what this socket holds, because it just answered a ping.
         * @returns Nothing.
         */
        const pong = (): void => onPong(socketId, held.connections);
        connection.webSocket.on("pong", pong);
        connection.webSocket.once("close", () => {
          connection.webSocket.off?.("pong", pong);
          bySocket.delete(socketId);
        });
      }
      entry.connections.set(documentName, connection);
      return entry.connectedAtMs;
    },

    find(documentName: string, socketId: string): HeldConnection | undefined {
      return bySocket.get(socketId)?.connections.get(documentName);
    },

    forget(socketId: string, documentName: string): void {
      const entry = bySocket.get(socketId);
      if (!entry) return;
      entry.connections.delete(documentName);
      if (entry.connections.size === 0) bySocket.delete(socketId);
    },
  };
}
