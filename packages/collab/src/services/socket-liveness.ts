// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a socket answering its ping proves, and everything that rides on it.
 *
 * There is more than one fact hanging off this one signal — a seat per
 * document the socket carries, and the presence record of whoever owns its
 * meta connection — and they are only ever refreshed together. Written as two
 * calls inside the callback passed to the per-socket table, one of them can go
 * missing without anything noticing: the module it belongs to keeps passing
 * its own tests, because those call it directly.
 *
 * That is not hypothetical. Presence went a whole change without being wired
 * to the pong while its expiry was cut to two ping periods, and every test in
 * the package stayed green.
 *
 * The seat renewal can answer back, and the answers are acted on here too:
 * `replaced` (an arrival retried on this pong took one of the person's
 * earlier seats) asks for that connection to be demoted; `full` (the retried
 * arrival found no seat) and `lost` (a held seat was gone and the document
 * full) demote this socket's connection on that document.
 */

import { createLogger } from "@breatic/core";

import {
  refreshPresenceForSocket,
  type PresencePolicy,
  type SocketConnection,
} from "@collab/hooks/presence-wiring.js";
import type { SeatRefreshResult } from "@collab/services/connection-registry.js";
import {
  demoteForSeat,
  type DemotableConnection,
} from "@collab/services/seat-handover.js";

const logger = createLogger("socket-liveness");

/** What refreshing a socket's facts needs. */
export interface SocketLivenessDeps {
  /** Renew every seat this socket holds; returns what needs acting on. */
  refreshSeats: (socketId: string) => Promise<SeatRefreshResult[]>;
  /**
   * Ask whichever instance holds it to demote a replaced connection. Bound
   * late by the caller: the demote channel is built after the table this
   * handler is handed to.
   */
  requestDemote: (documentName: string, member: string) => Promise<void>;
  /** Clock and presence threshold. */
  presencePolicy: PresencePolicy;
}

/** One connection on the socket, as much of it as a pong needs. */
type PongConnection = SocketConnection & DemotableConnection;

/**
 * Build the callback the per-socket table calls on every pong.
 * @param deps - See {@link SocketLivenessDeps}.
 * @returns The callback, taking the socket and what it carries.
 */
export function createPongHandler(
  deps: SocketLivenessDeps,
): (
  socketId: string,
  connections: ReadonlyMap<string, PongConnection>,
) => void {
  const { refreshSeats, requestDemote, presencePolicy } = deps;

  /**
   * Act on what the seat renewal answered.
   * @param socketId - The socket that answered.
   * @param connections - What it carries.
   * @returns once every demote request has been attempted.
   */
  async function settleSeats(
    socketId: string,
    connections: ReadonlyMap<string, PongConnection>,
  ): Promise<void> {
    const answers = await refreshSeats(socketId);
    for (const answer of answers) {
      const { documentName } = answer;
      if (answer.outcome === "replaced") {
        await requestDemote(documentName, answer.replaced);
        continue;
      }
      // Closed in the meantime: `unregister` has the seat.
      const connection = connections.get(documentName);
      if (!connection) continue;
      demoteForSeat(connection, {
        reason: answer.outcome === "full" ? "connection_cap_race_degraded" : "connection_seat_lost",
        socketId,
        userId: connection.context?.user?.id,
        documentName,
        liveCount: answer.liveCount,
        cap: answer.cap,
      });
    }
  }

  return (socketId, connections): void => {
    settleSeats(socketId, connections).catch((err: unknown) => {
      logger.error({ err, socketId }, "seat_refresh_failed");
    });
    refreshPresenceForSocket(connections, presencePolicy);
  };
}
