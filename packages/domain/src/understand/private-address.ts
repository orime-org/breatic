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
 * plain unauthenticated GETs, which is why that range is refused by name below
 * rather than left to the private ones.
 *
 * Which ranges an address falls in is `ipaddr.js`'s answer, not ours. It
 * classifies both families, sees through the v4-mapped v6 form, and knows the
 * ranges a hand-written table forgets — carrier-grade NAT, reserved, benchmark.
 *
 * What is ours is the second half: a name is free to point at 127.0.0.1, so
 * names are resolved and every address they answer with has to pass. One
 * public record beside a private one is still a way in.
 */

import ipaddr from "ipaddr.js";
import { lookup } from "node:dns/promises";

/**
 * The ranges this server may be sent to.
 *
 * Stated as what is allowed rather than what is refused: a range nobody
 * thought of then defaults to "no", which is the direction a gate should fail
 * in. `unicast` is the ordinary public internet.
 */
const REACHABLE_RANGES = new Set(["unicast"]);

/**
 * Whether one parsed address is somewhere we will go.
 *
 * A v4 address written in the v6-mapped form is a v4 address and reaches the
 * same host, so it is judged as one — `::ffff:127.0.0.1` is loopback however
 * it is spelled.
 * @param address - The address as `ipaddr.js` parsed it.
 * @returns True when its range is one we reach.
 */
function allowed(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (address.kind() === "ipv6") {
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return allowed(v6.toIPv4Address());
  }
  return REACHABLE_RANGES.has(address.range());
}

/**
 * Whether this server may be sent to fetch the given address.
 *
 * Names are resolved, because a name is free to point anywhere. All of a
 * name's addresses have to pass.
 * @param url - The address to check.
 * @returns True when every address it resolves to is somewhere we will go.
 * @throws {Error} never; anything unparseable answers false.
 */
export async function reachable(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  // A bracketed IPv6 literal keeps its brackets in `hostname`. Everything else
  // arrives normalised: `0177.0.0.1`, `2130706433` and `127.1` all reach here
  // as `127.0.0.1`, because the URL parser settles that before we see it.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (ipaddr.isValid(bare)) {
    return allowed(ipaddr.parse(bare));
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

  return records.every(({ address }) => ipaddr.isValid(address) && allowed(ipaddr.parse(address)));
}
