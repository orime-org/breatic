// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Loopback-exempt wrapper around `@hocuspocus/extension-throttle`.
 *
 * The raw Throttle bans an IP for `banTime` MINUTES once it opens more than
 * `throttle` connections within the window, keyed on
 * `x-real-ip || x-forwarded-for || socket.remoteAddress`. In dev EVERY browser
 * tab shares the loopback IP (`::1` / `127.0.0.1`), and React StrictMode + a
 * multi-Space project trivially opens >threshold doc-connections in seconds —
 * so the developer's own machine gets banned. Combined with the historical
 * `throttle_ban_time` unit bug (60000 read as MINUTES = 41.7 days) this surfaced
 * as the recurring "session expired" banner that never cleared until a restart.
 *
 * Exempting loopback is safe in BOTH dev and prod: the exemption keys on the
 * RESOLVED client IP (same extraction the Throttle uses), not the transport
 * socket — so a real client behind a co-located load balancer (whose
 * `x-forwarded-for` carries the real, non-loopback IP) is still throttled, while
 * genuinely local connections (dev browser, health probes) never are.
 *
 * Rate limiting is meant as a coarse DoS backstop here; fine-grained abuse
 * control belongs at the authenticated-user layer, not per-IP (shared NAT / LB
 * IPs would otherwise false-ban whole offices).
 */

import type { IncomingHttpHeaders } from "node:http";
import { Throttle } from "@hocuspocus/extension-throttle";

/** Minimal shape of the Hocuspocus onConnect payload we read for the client IP. */
interface ThrottleConnectPayload {
  request: {
    headers: IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
}

/** Throttle tuning (connections per window before a ban + ban length in minutes). */
export interface ThrottleConfig {
  throttle: number;
  banTime: number;
}

const LOOPBACK_EXACT = new Set(["::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * Whether a resolved client IP is loopback (this machine). Covers IPv4
 * `127.0.0.0/8`, IPv6 `::1`, and IPv4-mapped IPv6 loopback.
 * @param ip - The resolved client IP string (possibly empty).
 * @returns True when the IP is a loopback address.
 */
export function isLoopbackIp(ip: string): boolean {
  if (!ip) return false;
  if (LOOPBACK_EXACT.has(ip)) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Collapse a header value (which may be a comma list or string array) to its
 * first entry.
 * @param value - A raw HTTP header value.
 * @returns The first header value, or undefined when absent.
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve the effective client IP the same way the Throttle extension does
 * (`x-real-ip` → `x-forwarded-for` → socket address).
 * @param request - The incoming connection request.
 * @returns The resolved client IP, or `""` when none is available.
 */
export function resolveClientIp(
  request: ThrottleConnectPayload["request"],
): string {
  return (
    firstHeader(request.headers["x-real-ip"]) ||
    firstHeader(request.headers["x-forwarded-for"]) ||
    request.socket.remoteAddress ||
    ""
  );
}

/**
 * Build a Throttle extension that exempts loopback client IPs. For loopback the
 * connection is allowed unconditionally; for every other IP it delegates to the
 * real Throttle (which re-resolves the IP itself and rejects when banned).
 * @param config - Throttle tuning (window threshold + ban minutes).
 * @returns A Hocuspocus extension object with `onConnect` / `onDestroy` hooks.
 */
export function createLoopbackExemptThrottle(config: ThrottleConfig): {
  onConnect: (data: ThrottleConnectPayload) => Promise<void>;
  onDestroy: () => Promise<void>;
} {
  const throttle = new Throttle(config) as unknown as {
    onConnect: (data: ThrottleConnectPayload) => Promise<void>;
    onDestroy: () => Promise<void>;
  };
  return {
    onConnect: (data: ThrottleConnectPayload): Promise<void> => {
      if (isLoopbackIp(resolveClientIp(data.request))) return Promise.resolve();
      return throttle.onConnect(data);
    },
    onDestroy: (): Promise<void> => throttle.onDestroy(),
  };
}
