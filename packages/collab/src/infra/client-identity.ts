// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Who is on the other end of a collab WebSocket connection.
 *
 * Rate limiting only means something if connections can be attributed to a
 * client, and a client can only be identified two ways: by the address the
 * connection actually came from, or by a header a proxy we trust put there.
 * Which of the two applies is decided by ONE fact — whether the connection's
 * peer is loopback:
 *
 *   loopback peer      the browser reached us through the local dev proxy, so
 *                      this is a developer's own machine. Exempt.
 *   any other peer     the only thing that can reach collab is our own nginx
 *                      (its port is not published — see docker-compose.yml),
 *                      and nginx OVERWRITES `x-real-ip` with the real client
 *                      address. So the header is the client, and its absence
 *                      means the connection did not come through nginx.
 *
 * `x-forwarded-for` is deliberately never consulted. nginx APPENDS to it
 * (`$proxy_add_x_forwarded_for`), so its first hop is whatever the client
 * chose to send — reading it would hand every client a way to pick its own
 * rate-limit bucket.
 *
 * This module is pure on purpose: the hook that owns the socket lives in
 * `connection-gate.ts`, so the rule itself can be exercised without one.
 */

/** Loopback addresses that are not covered by a prefix test. */
const LOOPBACK_EXACT = new Set(["::1", "::ffff:127.0.0.1", "localhost"]);

/** What to do with a connection, once its client has been identified. */
/**
 * Why a connection could not be attributed. Named rather than inlined so the
 * caller that logs it and the rule that produces it share one list: a new
 * reason then reaches the logs without anyone remembering to widen a union.
 */
export type RefusalReason = "no-peer-address" | "missing-real-ip";

export type ClientIdentityDecision =
  /** A developer's own machine — allow it through without counting it. */
  | { kind: "exempt"; identity: string }
  /** A real client behind our proxy — count it under this identity. */
  | { kind: "identify"; identity: string }
  /** Not attributable, so not allowed. */
  | { kind: "refuse"; reason: RefusalReason };

/** The two facts the rule needs. */
export interface ClientIdentityInput {
  /** Address of the connection's immediate peer, from the raw socket. */
  peerAddress: string | undefined;
  /** Value of the `x-real-ip` request header, if the peer sent one. */
  realIpHeader: string | undefined;
}

/**
 * Whether an address belongs to this machine.
 *
 * Covers IPv4 `127.0.0.0/8`, IPv6 `::1`, and the IPv4-mapped IPv6 form.
 * @param ip - The address to test (possibly empty).
 * @returns True when the address is loopback.
 */
export function isLoopbackIp(ip: string): boolean {
  if (!ip) return false;
  if (LOOPBACK_EXACT.has(ip)) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Decide what to do with a connection, from its peer address and `x-real-ip`.
 *
 * A loopback peer is exempt on the strength of its address alone; whatever
 * header it sent is ignored, because otherwise any local process could ask to
 * be counted as somebody else.
 * @param input - The peer address and the `x-real-ip` header value.
 * @returns The decision, carrying the resolved identity or the refusal reason.
 */
export function decideClientIdentity(
  input: ClientIdentityInput,
): ClientIdentityDecision {
  const peer = input.peerAddress?.trim() ?? "";
  if (!peer) return { kind: "refuse", reason: "no-peer-address" };

  if (isLoopbackIp(peer)) return { kind: "exempt", identity: peer };

  const claimed = input.realIpHeader?.trim() ?? "";
  if (!claimed) return { kind: "refuse", reason: "missing-real-ip" };

  return { kind: "identify", identity: claimed };
}
