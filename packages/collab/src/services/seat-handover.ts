// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Demoting a connection to read-only, and the channel that asks for it.
 *
 * Every way a writable content connection loses its write access mid-life
 * goes through {@link demoteConnection}:
 *
 *   handover      another of the same person's connections replaced its seat;
 *                 the replacing instance asks over the channel below
 *   race lost     the `connected` hook's seat script found the document full
 *   seat lost     a pong found the seat gone and the document full (or a
 *                 retried arrival found it full)
 *
 * The last two also share their log line, through {@link demoteForSeat}, so
 * one tag carries the same fields wherever it is written.
 *
 * Demoting is two parts, each with its own way of going wrong if skipped:
 *
 *   set `connection.readOnly`       or the connection goes on writing
 *   send an Authenticated(readonly) or that end never learns it is read-only
 *
 * A handover has a third: let the seat go, or the pong loop renews it and a
 * read-only connection holds a seat that never comes free again. The other
 * two paths have already dropped the seat in the registry by the time they
 * demote.
 *
 * Which instance holds a replaced connection is not knowable from the
 * instance that replaced it, so the request goes out on a Redis pub/sub
 * channel and every instance asks whether the socket is one of its own. The
 * replacing instance may well be the same one; it takes the same path, so
 * there is one flow rather than a local case and a remote case.
 *
 * The channel is on DB3 alongside the Hocuspocus pub/sub and the Space count
 * lock, and carries the deployment's key prefix in its name: pub/sub is not
 * scoped by database number, so that prefix is the only thing keeping two
 * deployments sharing one Redis from answering each other's requests.
 *
 * A request that reaches nobody costs nothing: the seat is already gone and
 * so, in that case, is the connection. A request that is lost while the
 * connection lives is caught by that connection's next pong, which finds its
 * seat gone.
 */

import { createLogger, type Redis } from "@breatic/core";
import { parseDocName } from "@breatic/shared";
import { OutgoingMessage } from "@hocuspocus/server";

import { parseSeatMember } from "@collab/services/connection-registry.js";

const logger = createLogger("seat-handover");

/**
 * The subset of a Hocuspocus Connection a demote needs.
 *
 * The narrowest of the three slices this package takes of that one object
 * (the others are `HeldConnection` in `services/live-connections.ts` and
 * `SocketConnection` in `hooks/presence-wiring.js`). It stays narrow on
 * purpose: a demote sends one frame, so widening it to match the others
 * would make every double here carry emitter methods nothing calls.
 */
export interface DemotableConnection {
  /** Whether the framework refuses writes on this connection. */
  readOnly: boolean;
  /** The underlying socket, for the Authenticated frame. */
  webSocket: { send(data: Uint8Array): void };
}

/**
 * Make one connection read-only and tell its client.
 *
 * Idempotent: a connection that is already read-only is left alone, so a
 * client is never sent the frame twice.
 * @param documentName - The document the connection is for.
 * @param connection - The connection.
 */
export function demoteConnection(
  documentName: string,
  connection: DemotableConnection,
): void {
  if (connection.readOnly) return;
  connection.readOnly = true;
  connection.webSocket.send(
    new OutgoingMessage(documentName).writeAuthenticated(true).toUint8Array(),
  );
}

/** A demote for a seat this connection could not hold, as it is logged. */
export interface SeatDegrade {
  /**
   * `connection_cap_race_degraded`: an arrival (in `connected`, or retried on
   * a pong) found the document full. `connection_seat_lost`: a pong found the
   * seat gone and the document full.
   */
  reason: "connection_cap_race_degraded" | "connection_seat_lost";
  /** The socket the connection rides. */
  socketId: string;
  /** Whose connection it is. */
  userId: string | undefined;
  /** The document. */
  documentName: string;
  /** How many seats the script counted. */
  liveCount: number;
  /** The ceiling the handshake judged this connection by. */
  cap: number;
}

/**
 * Demote a connection that could not hold a seat, and log why with the same
 * fields wherever it happened.
 * @param connection - The connection.
 * @param degrade - Why, and the facts the log line carries.
 */
export function demoteForSeat(
  connection: DemotableConnection,
  degrade: SeatDegrade,
): void {
  const { reason, socketId, userId, documentName, liveCount, cap } = degrade;
  demoteConnection(documentName, connection);
  logger.warn(
    {
      socketId,
      userId,
      documentName,
      projectId: parseDocName(documentName)?.projectId,
      liveCount,
      cap,
      reason,
    },
    reason,
  );
}

/** What one instance needs to carry out a demote it is responsible for. */
export interface SeatHandoverDeps {
  /**
   * Namespace for the channel. Pub/sub is not scoped by database number, so
   * this prefix is the only thing keeping two deployments sharing one Redis
   * from answering each other's demote requests.
   */
  channelPrefix: string;
  /** Publishing client (a plain command; the shared DB3 client will do). */
  publisher: Redis;
  /** A dedicated client for SUBSCRIBE, which takes over its socket. */
  subscriber: Redis;
  /**
   * The connection this instance holds on that document for that socket, or
   * undefined when the socket belongs to another instance.
   */
  findConnection: (
    documentName: string,
    socketId: string,
  ) => DemotableConnection | undefined;
  /** Let go of a seat that has gone to somebody else's connection. */
  forgetSeat: (documentName: string, member: string) => Promise<void>;
}

/** Asks every instance to demote one connection, and answers such asks. */
export interface SeatHandover {
  /**
   * Tell whichever instance holds it that this seat has been replaced.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was replaced.
   * @returns once the publish has been attempted (best-effort).
   */
  requestDemote(documentName: string, member: string): Promise<void>;
  /** Begin answering demote requests. */
  start(): Promise<void>;
  /** Stop answering them. */
  stop(): Promise<void>;
}

/**
 * Build the demote channel over the given clients.
 * @param deps - See {@link SeatHandoverDeps}.
 * @returns A {@link SeatHandover}.
 */
export function createSeatHandover(deps: SeatHandoverDeps): SeatHandover {
  const { channelPrefix, publisher, subscriber, findConnection, forgetSeat } =
    deps;
  const channel = `${channelPrefix}:collab:seat-demote`;

  /**
   * Carry out a demote, if this instance is the one holding that connection.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was replaced.
   * @returns once the seat has been let go.
   */
  async function applyDemote(
    documentName: string,
    member: string,
  ): Promise<void> {
    const parsed = parseSeatMember(member);
    if (parsed === null) {
      logger.warn(
        { documentName, member, tag: "seat_demote_member_unreadable" },
        "seat handover request named a member this build cannot read",
      );
      return;
    }
    const connection = findConnection(documentName, parsed.socketId);
    if (!connection) return;
    demoteConnection(documentName, connection);
    await forgetSeat(documentName, member);
  }

  return {
    async requestDemote(documentName: string, member: string): Promise<void> {
      try {
        await publisher.publish(
          channel,
          JSON.stringify({ documentName, member }),
        );
      } catch (err) {
        logger.warn(
          { err, documentName, tag: "seat_demote_publish_failed" },
          "seat handover request could not be published",
        );
      }
    },

    async start(): Promise<void> {
      subscriber.on("message", (_channel: string, payload: string) => {
        try {
          const parsed = JSON.parse(payload) as {
            documentName?: unknown;
            member?: unknown;
          };
          if (
            typeof parsed.documentName !== "string" ||
            typeof parsed.member !== "string"
          ) {
            return;
          }
          void applyDemote(parsed.documentName, parsed.member);
        } catch (err) {
          logger.warn(
            { err, tag: "seat_demote_apply_failed" },
            "seat handover request could not be applied",
          );
        }
      });
      await subscriber.subscribe(channel);
    },

    async stop(): Promise<void> {
      await subscriber.unsubscribe(channel);
    },
  };
}
