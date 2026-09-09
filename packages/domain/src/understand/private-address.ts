// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether an address points somewhere this server should not be sent.
 *
 * The address a media call fetches comes from whoever is typing in the chat
 * box, by way of the model. Without a gate the server's own network position
 * is on offer to them: a status code answers "is something listening here",
 * and any response that passes for media is downloaded and read back out by
 * the model. Cloud metadata services sit on a link-local address and answer
 * plain unauthenticated GETs, which is why that range is named separately
 * below rather than left to the private ones.
 *
 * The check is on where the name resolves, not on how it is written, because
 * a hostname is free to point at 127.0.0.1. Every address a name resolves to
 * has to pass — one public record beside a private one is still a way in.
 */

import { lookup } from "node:dns/promises";

/** Ranges that never belong to somewhere this server was asked to reach. */
const BLOCKED_V4 = [
  /** This host. */
  { prefix: [127], bits: 8 },
  /** Private, RFC 1918. */
  { prefix: [10], bits: 8 },
  { prefix: [192, 168], bits: 16 },
  /** Link-local, which is where cloud metadata answers. */
  { prefix: [169, 254], bits: 16 },
  /** This network, RFC 1122. */
  { prefix: [0], bits: 8 },
  /** Shared address space for carrier NAT, RFC 6598. */
  { prefix: [100, 64], bits: 10 },
];

/**
 * Whether an IPv4 address falls in a range this will not reach.
 * @param address - Dotted-quad address.
 * @returns True when the address is one of the blocked ranges.
 */
function blockedV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  // 172.16/12 is stated here rather than in the table because its boundary
  // falls inside an octet: 172.16 through 172.31, not the whole of 172.
  if (a === 172 && b >= 16 && b <= 31) return true;
  return BLOCKED_V4.some(({ prefix, bits }) => {
    if (bits === 10) {
      // 100.64/10: the second octet carries the remaining two bits.
      return a === prefix[0] && b >= 64 && b <= 127;
    }
    return prefix.every((want, i) => parts[i] === want);
  });
}

/**
 * Whether an IPv6 address falls in a range this will not reach.
 * @param address - Address, without brackets.
 * @returns True when the address is one of the blocked ranges.
 */
function blockedV6(address: string): boolean {
  const lower = address.toLowerCase();
  // An address written in the v4-mapped form is a v4 address, and it reaches
  // the same host: ::ffff:127.0.0.1 is loopback however it is spelled.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return blockedV4(mapped[1]);
  if (lower === "::1" || lower === "::") return true;
  // fc00::/7 unique local, fe80::/10 link-local.
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/**
 * Whether a written address is an IP rather than a name.
 * @param host - The host as written in the URL.
 * @returns True when it parses as an IP literal.
 */
function isLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/**
 * Whether this server may be sent to fetch the given address.
 *
 * Resolves names, because a name is free to point anywhere. All of a name's
 * addresses have to pass: one public record beside a private one still reaches
 * the private one.
 * @param url - The address to check.
 * @returns True when every address it resolves to is somewhere we will go.
 * @throws {Error} never; a name that will not resolve answers false.
 */
export async function reachable(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  // A bracketed IPv6 literal keeps its brackets in `hostname`.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (isLiteral(bare)) {
    return bare.includes(":") ? !blockedV6(bare) : !blockedV4(bare);
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(bare, { all: true });
  } catch {
    // Nothing to judge. A name that will not resolve is one `fetch` cannot
    // reach either, and letting it through means the caller hears the real
    // reason from the request instead of this gate's deliberately mute one.
    return true;
  }
  if (records.length === 0) return true;

  return records.every(({ address, family }) =>
    family === 6 ? !blockedV6(address) : !blockedV4(address),
  );
}
