// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { finished, type Duplex } from "node:stream";
import type { onUpgradePayload } from "@hocuspocus/server";
import {
  createLogger,
  decideClientIdentity,
  getSession,
  redactSessionError,
  sessionCookieName,
  sessionId,
  type Redis,
} from "@breatic/core";
import { readCookie } from "@collab/infra/cookie.js";

const logger = createLogger("upgrade-session-gate");

/** Native hook fields consumed before Hocuspocus creates a ClientConnection. */
type UpgradePayload = Pick<onUpgradePayload, "request"> & {
  socket: Duplex & { remoteAddress?: string };
};

/** Authority and optional accounting shared with the document authentication path. */
interface UpgradeSessionOptions {
  redis: Redis;
  recordFailedUpgrade?: (request: IncomingMessage) => Promise<void>;
}

/** The raw-socket extension and the entry's synchronous shutdown boundary. */
export interface UpgradeSessionGate {
  onUpgrade(payload: UpgradePayload): Promise<void>;
  stop(): void;
  onDestroy(): Promise<void>;
}

/** The first terminal decision remains authoritative for this physical request. */
type UpgradeDecision = "pending" | "admitted" | "rejected" | "peer_gone" | "stopped";

/** Ownership ends at transport handoff or Node's stream termination callback. */
type Ownership = "owned" | "closing" | "handed_off" | "released";

/** A terminal input submitted by one observed event. */
interface FinishOutcome {
  kind: Exclude<UpgradeDecision, "pending">;
  reason: string;
  status?: 401 | 503;
  error?: unknown;
  errorEvent?: "collab_upgrade_cookie_error" | "collab_upgrade_session_error";
}

/**
 * Require a current session before the native WebSocket upgrade allocates queues.
 * @param options - Session authority and optional failed-upgrade accounting.
 * @returns The native hook and its shared stop lifecycle.
 */
export function createUpgradeSessionGate(options: UpgradeSessionOptions): UpgradeSessionGate {
  let stopping = false;
  const pending = new Set<() => void>();

  /** Stop every raw socket still owned by this extension synchronously. */
  function stop(): void {
    stopping = true;
    for (const terminate of pending) terminate();
  }

  /**
   * Own one raw socket until session admission or stream termination.
   * @param payload - The library's native upgrade request and stream.
   * @returns Once transport owns the stream or refusal and accounting have settled.
   * @throws {undefined} When the upgrade ends without admission.
   */
  function onUpgrade(payload: UpgradePayload): Promise<void> {
    const { request, socket } = payload;
    const cookieHeader = request.headers.cookie;
    const rawIdentity = request.headers["x-real-ip"];
    const identity = decideClientIdentity({
      peerAddress: socket.remoteAddress,
      realIpHeader: Array.isArray(rawIdentity) ? rawIdentity[0] : rawIdentity,
    });
    const attemptId = randomUUID();
    let token: string | null = null;
    let decision: UpgradeDecision = "pending";
    let ownership: Ownership = "owned";
    let resolveCompletion!: () => void;
    let rejectCompletion!: (reason: undefined) => void;
    let resolveTermination!: () => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const termination = new Promise<void>((resolve) => { resolveTermination = resolve; });

    /**
     * Build the allowlisted diagnostic context for this request.
     * @param phase - The boundary producing the event.
     * @param reason - Its diagnostic reason.
     * @returns Context carrying no request credentials.
     */
    function context(phase: string, reason: string): Record<string, unknown> {
      return {
        attemptId,
        phase,
        peerAddress: socket.remoteAddress ?? null,
        identity: identity.kind === "refuse" ? null : identity.identity,
        identityReason: identity.kind === "refuse" ? identity.reason : identity.kind,
        reason,
        decision,
        ...(token ? { sessionId: sessionId(token) } : {}),
      };
    }

    /**
     * Record an error from a boundary outside the core session reader.
     * @param error - The observed error.
     * @param event - Its structured event name.
     * @param phase - The failing boundary.
     * @param reason - Its diagnostic reason.
     * @param status - The HTTP refusal status when this is its final event.
     */
    function logError(error: unknown, event: string, phase: string, reason: string, status?: 401 | 503): void {
      logger.error({
        err: redactSessionError(error, [cookieHeader ?? "", token ?? ""]),
        ctx: context(phase, reason),
        status,
      }, event);
    }

    /**
     * Maintain the socket ownership index and its native observations together.
     * @param next - The new responsibility owner.
     */
    function advanceOwnership(next: Ownership): void {
      ownership = next;
      if (next === "owned") {
        pending.add(stopRequest);
      } else if (next === "handed_off" || next === "released") {
        cleanupFinished();
        socket.off("end", onEnd);
        pending.delete(stopRequest);
        if (next === "released") resolveTermination();
      }
    }

    /**
     * Consume this rejected request's single failure-accounting operation.
     * @returns Once the operation succeeds or its failure has been recorded.
     */
    async function recordFailure(): Promise<void> {
      try {
        await options.recordFailedUpgrade?.(request);
      } catch (err) {
        logError(err, "collab_upgrade_failure_count_error", "accounting", "failure_count_failed");
      }
    }

    /**
     * Arbitrate the first terminal decision and start its ownership transition.
     * @param outcome - The event's proposed terminal decision.
     */
    function finish(outcome: FinishOutcome): void {
      if (decision !== "pending") return;
      if (outcome.kind === "admitted") {
        if (socket.destroyed || socket.readableEnded) {
          outcome = { kind: "peer_gone", reason: "peer_closed" };
        } else if (stopping) {
          outcome = { kind: "stopped", reason: "stopping", status: 503 };
        }
      }
      decision = outcome.kind;
      if (decision === "admitted") {
        advanceOwnership("handed_off");
        resolveCompletion();
        return;
      }

      if (outcome.errorEvent === "collab_upgrade_session_error") {
        logger.error({ err: outcome.error, ctx: context("lookup", outcome.reason), status: outcome.status }, outcome.errorEvent);
      } else if (outcome.errorEvent === "collab_upgrade_cookie_error") {
        logError(outcome.error, outcome.errorEvent, "cookie", outcome.reason, outcome.status);
      } else if (decision === "rejected") {
        logger.warn({ ctx: context("session", outcome.reason), status: outcome.status }, "collab_upgrade_session_rejected");
      } else if (decision === "stopped") {
        logger.info({ ctx: context("shutdown", outcome.reason), status: outcome.status }, "collab_upgrade_stopped");
      } else {
        logger.info({ ctx: context("socket", outcome.reason) }, "collab_upgrade_peer_closed");
      }

      const accounting = decision === "rejected" ? recordFailure() : Promise.resolve();
      advanceOwnership("closing");
      if (outcome.status && !socket.destroyed && socket.writable && !socket.writableEnded) {
        const statusText = outcome.status === 401 ? "401 Unauthorized" : "503 Service Unavailable";
        try {
          socket.write(`HTTP/1.1 ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        } catch (err) {
          logError(err, "collab_upgrade_socket_error", "socket", "response_write_failed");
        }
      }
      socket.destroy();
      void Promise.all([termination, accounting]).then(() => rejectCompletion(undefined));
    }

    /** A readable FIN ends the waiting socket's local side immediately. */
    function onEnd(): void {
      finish({ kind: "peer_gone", reason: "peer_closed" });
    }

    /** Submit this instance's synchronous shutdown event to the shared arbiter. */
    function stopRequest(): void {
      finish({ kind: "stopped", reason: "stopping", status: 503 });
    }

    const cleanupFinished = finished(socket, (err) => {
      if (err && (decision === "pending" || err.code !== "ERR_STREAM_PREMATURE_CLOSE")) {
        logError(err, "collab_upgrade_socket_error", "socket", "stream_terminated");
      }
      finish({ kind: "peer_gone", reason: "peer_closed" });
      if (ownership !== "handed_off" && ownership !== "released") advanceOwnership("released");
    });
    socket.on("end", onEnd);
    advanceOwnership("owned");
    if (socket.destroyed || socket.readableEnded) {
      finish({ kind: "peer_gone", reason: "peer_closed" });
    } else if (stopping) {
      stopRequest();
    } else {
      try {
        token = readCookie(cookieHeader, sessionCookieName());
      } catch (err) {
        finish({ kind: "rejected", reason: "cookie_malformed", status: 401, error: err, errorEvent: "collab_upgrade_cookie_error" });
      }
      if (decision === "pending") {
        if (!token) {
          finish({ kind: "rejected", reason: "missing_cookie", status: 401 });
        } else {
          void getSession(options.redis, token).then(
            (userId) => finish(userId
              ? { kind: "admitted", reason: "session_valid" }
              : { kind: "rejected", reason: "session_not_found", status: 401 }),
            (err: unknown) => {
              if (decision === "pending") {
                finish({ kind: "rejected", reason: "lookup_failed", status: 503, error: err, errorEvent: "collab_upgrade_session_error" });
              } else {
                logger.error({ err, ctx: context("lookup", "lookup_failed"), status: 503 }, "collab_upgrade_session_error");
              }
            },
          );
        }
      }
    }
    return completion;
  }

  return {
    onUpgrade,
    stop,
    onDestroy: async (): Promise<void> => { stop(); },
  };
}
