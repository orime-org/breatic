// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The gate every incoming collab WebSocket passes through.
 *
 * It spans two hooks because the two things it needs live in different places:
 *
 *   onUpgrade   the ONLY hook that sees the raw socket, and therefore the only
 *               place the connection's peer address exists. It decides, then
 *               either rewrites `x-real-ip` so the decision survives, or
 *               refuses the connection outright.
 *   onConnect   sees a standard Request and nothing else. It reads the
 *               identity onUpgrade left behind and either exempts it or hands
 *               it to the throttle to be counted.
 *
 * Why the verdict travels as a header rather than a side channel: hocuspocus
 * runs the upgrade hooks BEFORE handing the request to crossws, and crossws
 * builds the standard Request from the node request's header object at that
 * moment. Mutating those headers in the hook is therefore visible downstream.
 * Measured, not assumed — see
 * inner/engineering/demo/2026-08-05-onupgrade-header-normalisation.mjs.
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
 * See inner/engineering/demo/2026-08-05-onupgrade-reject-semantics.mjs.
 */

import type { IncomingMessage } from "node:http";
import { Throttle } from "@hocuspocus/extension-throttle";
import { createLogger } from "@breatic/core";
import { decideClientIdentity, isLoopbackIp } from "@collab/infra/client-identity.js";
import type { RefusalReason } from "@collab/infra/client-identity.js";

const logger = createLogger("connection-gate");

/** Throttle tuning: connections per window before a ban, and ban length in minutes. */
export interface ThrottleConfig {
  throttle: number;
  banTime: number;
}

/** The part of the throttle extension this gate uses. */
export interface ThrottleLike {
  onConnect(data: unknown): Promise<unknown>;
  onDestroy(): Promise<unknown>;
}

/** Just enough of a socket to answer and hang up on it. */
interface RefusableSocket {
  remoteAddress?: string;
  write(chunk: string): unknown;
  destroy(): unknown;
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

/** The three hooks hocuspocus wires this gate in through. */
export interface ConnectionGate {
  onUpgrade(data: UpgradeHookPayload): Promise<void>;
  onConnect(data: ConnectHookPayload): Promise<void>;
  onDestroy(): Promise<void>;
}

/** Header carrying the client identity, the only one this gate trusts. */
const REAL_IP_HEADER = "x-real-ip";

/** Header this gate always removes, because a client can prepend to it. */
const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** What a refused client is told before the socket goes away. */
const REFUSAL_RESPONSE = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n";

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
  socket.write(REFUSAL_RESPONSE);
  socket.destroy();
  // A falsy rejection is hocuspocus's own signal for "abort this upgrade
  // quietly"; anything truthy is rethrown out of an async event listener and
  // kills the process. Measured: see the module docstring.
  throw undefined;
}

/**
 * Build the connection gate.
 * @param config - Throttle tuning passed through to the throttle extension.
 * @param deps - Overridable collaborators.
 * @param deps.throttle - Throttle implementation; defaults to the real extension.
 * @returns The hooks to register on the Hocuspocus server.
 */
export function createConnectionGate(
  config: ThrottleConfig,
  deps: { throttle?: ThrottleLike } = {},
): ConnectionGate {
  const throttle: ThrottleLike =
    deps.throttle ?? (new Throttle(config) as unknown as ThrottleLike);

  return {
    onUpgrade: (data: UpgradeHookPayload): Promise<void> => {
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

      // Carries the verdict to onConnect. For a loopback peer this overwrites
      // whatever the peer claimed, which is the point.
      headers[REAL_IP_HEADER] = decision.identity;
      return Promise.resolve();
    },

    onConnect: (data: ConnectHookPayload): Promise<void> => {
      const identity = data.request.headers.get(REAL_IP_HEADER) ?? "";
      if (isLoopbackIp(identity)) return Promise.resolve();
      return throttle.onConnect(data).then(() => undefined);
    },

    onDestroy: (): Promise<void> => throttle.onDestroy().then(() => undefined),
  };
}
