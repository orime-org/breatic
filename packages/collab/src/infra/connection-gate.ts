// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The gate every incoming collab WebSocket passes through.
 *
 * The throttle counts attempts per address: one per new WebSocket, plus one
 * per WebSocket whose authentication failed. Counting per WebSocket rather
 * than per document is the point — one socket carries a whole project, the
 * meta doc and up to `MAX_SPACES_PER_PROJECT` Spaces, so a member opening a
 * full project is one attempt, not two hundred.
 *
 *   onUpgrade         the ONLY hook that sees the raw socket, and therefore the
 *                     only place the connection's peer address exists. It
 *                     decides, rewrites `x-real-ip` so the decision survives,
 *                     then refuses the connection outright, exempts it, or
 *                     counts it and refuses it with 429 when the address is over.
 *   onConnect         runs once per DOCUMENT and sees a standard Request and
 *                     nothing else. It counts nothing; it refuses a document
 *                     whose address is banned, before any session or role
 *                     lookup runs.
 *   recordFailedAuth  called when `onAuthenticate` rejects a document (wired by
 *                     `recordingFailedAuth`). A WebSocket's first failure
 *                     counts once, so a whole project failing together (a
 *                     removed member, an expired session) is one attempt;
 *                     past a full project's documents every further failure
 *                     on that socket counts, because those are repeated
 *                     attempts. hocuspocus hands every document on one socket
 *                     the same request object (hocuspocus-server.esm.js:331,
 *                     974), which is what the failures are tallied on.
 *
 * Why the verdict travels as a header rather than a side channel: hocuspocus
 * runs the upgrade hooks BEFORE handing the request to crossws, and crossws
 * builds the standard Request from the node request's header object at that
 * moment. Mutating those headers in the hook is therefore visible downstream.
 * Measured by driving the real library through an upgrade, not read off its
 * documentation.
 *
 * The refusal shape is likewise measured. hocuspocus's upgrade handler is
 * `try { await hooks(...); handleUpgrade(...) } catch (e) { if (e) throw e }`,
 * which gives a hook three ways to say no and only one of them works:
 *
 *   throw an Error       socket stays open AND an unhandled rejection escapes,
 *                        which collab's own handler turns into process.exit(1)
 *   throw a falsy value  upgrade is skipped, but the socket is left dangling
 *   respond, destroy,
 *   then throw falsy     the client is told, the socket is released, the
 *                        upgrade is skipped, and nothing escapes  <-- this one
 *
 * All three rows were measured against the library, not inferred from its
 * source.
 */

import type { IncomingMessage } from "node:http";
import { createLogger, decideClientIdentity, type RefusalReason } from "@breatic/core";
import { DOCUMENTS_PER_SOCKET } from "@collab/infra/socket-ceilings.js";

const logger = createLogger("connection-gate");

/** The two questions the gate asks of the shared throttle. */
export interface Throttle {
  /** Record one attempt by `identity`; resolves whether it is allowed. */
  count(identity: string): Promise<boolean>;
  /** Whether `identity` is banned right now; counts nothing. */
  isBanned(identity: string): Promise<boolean>;
}

/** Just enough of a socket to answer, watch and hang up on it. */
interface RefusableSocket {
  remoteAddress?: string;
  write(chunk: string): unknown;
  destroy(): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
}

/** The upgrade hook's payload, narrowed to what the gate reads. */
export interface UpgradeHookPayload {
  request: IncomingMessage;
  socket: RefusableSocket;
}

/** The connect hook's payload, narrowed to what the gate reads. */
export interface ConnectHookPayload {
  request: { headers: Headers };
}

/** The two hooks hocuspocus wires this gate in through, plus the failed-auth count. */
export interface ConnectionGate {
  onUpgrade(data: UpgradeHookPayload): Promise<void>;
  onConnect(data: ConnectHookPayload): Promise<void>;
  recordFailedAuth(data: ConnectHookPayload): Promise<void>;
}

/** Header carrying the client identity, which the throttle keys on. */
const REAL_IP_HEADER = "x-real-ip";

/**
 * Header carrying the gate's own verdict, written on every upgrade and never
 * read from a client.
 *
 * The identity alone cannot carry it. A loopback peer's identity is its peer
 * address, and a proxied client's identity is whatever the proxy put in
 * `x-real-ip` — so "127.0.0.1" downstream means either "the peer really was
 * loopback" or "something claimed to be". Re-deriving the verdict from that
 * string hands a full rate-limit exemption to anyone who can set the header,
 * and, with no attacker at all, to every client at once the moment an edge
 * proxy sits in front of nginx and nginx's `X-Real-IP $remote_addr` starts
 * reading 127.0.0.1.
 */
const VERDICT_HEADER = "x-breatic-connection-verdict";

/** Verdict value meaning "a developer's own machine — do not count it". */
const VERDICT_EXEMPT = "exempt";

/** Header this gate always removes, because a client can prepend to it. */
const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** What a client with no trustworthy identity is told before the socket goes away. */
const REFUSAL_RESPONSE = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n";

/** What a client over the attempt limit is told before the socket goes away. */
const THROTTLED_RESPONSE = "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n";

/**
 * Refuse an upgrade: record it, answer the client, release the socket, then
 * abort the hook chain with a falsy rejection so hocuspocus skips the upgrade
 * without letting anything escape into the process.
 *
 * The log line is not optional detail. A refusal happens before any document,
 * hook or request handler exists, so nothing downstream will ever see it — an
 * operator staring at a service that refuses everyone would otherwise read
 * exactly the same logs as one that is healthy. `missing-real-ip` in
 * particular means traffic reached collab without passing through the proxy
 * that sets the header, which is a deployment fault worth alerting on.
 * @param socket - The raw socket the upgrade arrived on.
 * @param reason - Why the identity could not be established.
 * @throws {undefined} Always — the falsy value is what makes hocuspocus's
 *   `if (error) throw error` swallow it instead of crashing the process.
 */
function refuseUpgrade(
  socket: RefusableSocket,
  reason: RefusalReason,
): never {
  // The peer address comes off the socket, never off a header: refusing is
  // precisely the case where the client's own claim cannot be trusted, so
  // logging that claim would put an attacker-chosen string in the field an
  // operator reads as the source of the traffic.
  logger.warn(
    { reason, peerAddress: socket.remoteAddress },
    "collab_upgrade_refused",
  );
  hangUp(socket, REFUSAL_RESPONSE);
}

/**
 * Answer the client, release the socket, and abort the upgrade quietly.
 * @param socket - The raw socket the upgrade arrived on.
 * @param response - The HTTP response written before the socket goes away.
 * @throws {undefined} Always — see {@link refuseUpgrade}.
 */
function hangUp(socket: RefusableSocket, response: string): never {
  socket.write(response);
  socket.destroy();
  // A falsy rejection is hocuspocus's own signal for "abort this upgrade
  // quietly"; anything truthy is rethrown out of an async event listener and
  // kills the process. Measured: see the module docstring.
  throw undefined;
}

/**
 * Count a new WebSocket against its address, refusing it with 429 when the
 * address is over the limit.
 *
 * The count awaits Redis while the raw socket belongs to nobody: hocuspocus
 * has not handed it to the WebSocket server yet, so nothing else listens for
 * its errors. A client that resets in that window would raise an 'error'
 * with no listener, which Node turns into an uncaught exception. The gate
 * holds a listener for exactly that window and removes it once the socket is
 * handed on.
 * @param throttle - The shared throttle.
 * @param socket - The raw socket the upgrade arrived on.
 * @param identity - The address the throttle keys on.
 * @returns Resolves when the WebSocket may proceed.
 * @throws {undefined} When the socket failed or the address is over the limit.
 */
async function countUpgrade(
  throttle: Throttle,
  socket: RefusableSocket,
  identity: string,
): Promise<void> {
  let failed = false;
  /**
   * The client went away while the count was pending: record it and release
   * the socket.
   * @param err - The socket error.
   */
  const onError = (err: Error): void => {
    failed = true;
    logger.info({ err, identity }, "collab_upgrade_socket_error");
    socket.destroy();
  };
  socket.on("error", onError);
  let allowed: boolean;
  try {
    allowed = await throttle.count(identity);
  } finally {
    socket.off("error", onError);
  }
  // The client went away mid-count; there is nobody left to answer.
  if (failed) throw undefined;
  if (!allowed) {
    logger.warn(
      { identity, peerAddress: socket.remoteAddress },
      "collab_upgrade_throttled",
    );
    hangUp(socket, THROTTLED_RESPONSE);
  }
}

/**
 * The address a later hook keys on, or null for a connection the upgrade
 * judged a developer's own machine.
 * @param data - A per-document hook payload.
 * @returns The identity, or null when the connection is exempt.
 */
function countedIdentity(data: ConnectHookPayload): string | null {
  // Reads the verdict rather than re-deriving one. The identity cannot be
  // re-judged here: these hooks never see the peer address, so a loopback
  // identity is indistinguishable from a claim to be loopback.
  if (data.request.headers.get(VERDICT_HEADER) === VERDICT_EXEMPT) return null;
  return data.request.headers.get(REAL_IP_HEADER) ?? "";
}

/**
 * Build the connection gate.
 * @param throttle - Counts the attempts the gate does not exempt; the shared
 *   Redis throttle in production (`infra/shared-throttle.ts`).
 * @returns The hooks to register on the Hocuspocus server.
 */
export function createConnectionGate(throttle: Throttle): ConnectionGate {
  // Failed authentications so far on each WebSocket, keyed on its request.
  // Weak, so a closed socket's request leaves with it.
  const failures = new WeakMap<object, number>();
  return {
    onUpgrade: async (data: UpgradeHookPayload): Promise<void> => {
      const headers = data.request.headers;
      // Dropped unconditionally: nothing downstream may fall back to a header
      // whose first hop the client chose.
      delete headers[FORWARDED_FOR_HEADER];

      const raw = headers[REAL_IP_HEADER];
      const decision = decideClientIdentity({
        peerAddress: data.socket.remoteAddress,
        realIpHeader: Array.isArray(raw) ? raw[0] : raw,
      });

      if (decision.kind === "refuse") {
        refuseUpgrade(data.socket, decision.reason);
      }

      // The identity the throttle keys on. For a loopback peer this overwrites
      // whatever the peer claimed, which is the point.
      headers[REAL_IP_HEADER] = decision.identity;
      // Written on EVERY upgrade, so whatever a client sent under this name is
      // gone by the time anything downstream looks. Only `exempt` is spelled
      // out; every other verdict is "count it", which is what an unset or
      // unrecognised value has to mean.
      headers[VERDICT_HEADER] = decision.kind === "exempt" ? VERDICT_EXEMPT : "count";
      if (decision.kind === "exempt") return;
      await countUpgrade(throttle, data.socket, decision.identity);
    },

    onConnect: async (data: ConnectHookPayload): Promise<void> => {
      const identity = countedIdentity(data);
      if (identity === null) return;
      // A falsy rejection refuses the document quietly, before any session
      // or role lookup runs for an address that is already banned.
      if (await throttle.isBanned(identity)) throw undefined;
    },

    recordFailedAuth: async (data: ConnectHookPayload): Promise<void> => {
      const identity = countedIdentity(data);
      if (identity === null) return;
      const failed = (failures.get(data.request) ?? 0) + 1;
      failures.set(data.request, failed);
      if (failed !== 1 && failed <= DOCUMENTS_PER_SOCKET) return;
      if (!(await throttle.count(identity))) {
        logger.warn({ identity }, "collab_failed_auth_throttled");
      }
    },
  };
}

/**
 * Wrap an `onAuthenticate` hook so every rejection it gives is counted by the
 * gate before it goes on to hocuspocus unchanged.
 * @param onAuthenticate - The authentication hook to wrap.
 * @param gate - Where the failure is recorded.
 * @returns The hook to register in its place.
 */
export function recordingFailedAuth<P extends ConnectHookPayload, R>(
  onAuthenticate: (payload: P) => Promise<R>,
  gate: Pick<ConnectionGate, "recordFailedAuth">,
): (payload: P) => Promise<R> {
  return async (payload: P): Promise<R> => {
    try {
      return await onAuthenticate(payload);
    } catch (rejection) {
      await gate.recordFailedAuth(payload);
      throw rejection;
    }
  };
}
