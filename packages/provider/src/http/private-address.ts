// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

/**
 * Whether one parsed address is in the public unicast range; a v4 address in
 * the v6-mapped form is judged as the v4 address it reaches.
 * @param address - The parsed address.
 * @returns True for public unicast.
 */
function allowed(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    return allowed((address as ipaddr.IPv6).toIPv4Address());
  }
  return address.range() === "unicast";
}

/**
 * Whether an address may be fetched: every address its host resolves to is
 * public unicast. A name that does not resolve is let through, so the request
 * reports why it failed.
 * @param url - The address.
 * @returns False for a malformed url, a scheme other than http or https, or any private, loopback, link-local or reserved address.
 */
export async function reachable(url: string): Promise<boolean> {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (ipaddr.isValid(bare)) return allowed(ipaddr.parse(bare));
  let records: { address: string; family: number }[];
  try {
    records = await lookup(bare, { all: true });
  } catch {
    return true;
  }
  return records.every(({ address }) => ipaddr.isValid(address) && allowed(ipaddr.parse(address)));
}
