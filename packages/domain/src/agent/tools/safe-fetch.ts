// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * SSRF-safe `fetch` wrapper used by the agent `web_fetch` tool.
 *
 * The raw `web_fetch` previously only checked that the URL scheme
 * was `http` or `https`. That let an authenticated user drive the
 * agent into fetching internal addresses like
 * `http://169.254.169.254/latest/meta-data/` (AWS instance metadata),
 * `http://127.0.0.1:5432/` (internal Postgres), or any private
 * network resource visible to the server process.
 *
 * This module:
 *
 *   1. Blocks non-http/https schemes outright.
 *   2. Resolves the hostname to ALL of its IP addresses up front and
 *      rejects any result that classifies as non-`unicast` — covering
 *      loopback, link-local, private (RFC 1918), reserved, multicast,
 *      metadata (169.254.169.254), and the IPv6 equivalents.
 *   3. Blocks a hard-coded deny list of hostnames that can still
 *      resolve to unicast IPs in unusual network setups.
 *   4. Follows redirects manually, re-checking DNS for every hop. A
 *      redirect from a public host to `http://10.0.0.1/` is rejected.
 *   5. Caps hop count, and gives each DELIVERY a deadline — not each hop.
 *      What that unit means is asserted in the tests; it is stated here
 *      because a reader meeting the number needs to know what it bounds.
 *
 * The request itself goes through the shared HTTP transport, which may
 * deliver one hop up to three times. That is deliberate: a dropped
 * connection used to fail the tool outright.
 *
 * DNS rebinding is partially mitigated by re-resolving per hop; a
 * determined attacker with a short-TTL DNS record and precise timing
 * could still race the check against the actual connect, but this
 * would require the target server's TCP stack to re-query DNS, which
 * it does not within a single fetch call.
 *
 * The retries widen that race, because the DNS check runs once per HOP
 * while a hop may now be delivered up to three times. How much wider
 * depends on things this module does not control — whether the client
 * reuses its pooled connection, and how long the far side asks it to
 * wait — so no figure is quoted here; one would go stale silently.
 * Hardening the guard is tracked separately.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { getAgentConfig } from "@breatic/core";
import { httpRequest } from "@breatic/shared";

/**
 * What this guard refuses a URL with, whatever the reason.
 *
 * Not only forbidden hosts: a name the resolver turns down ends here too, so
 * that callers reading this type get every fact the guard established about
 * the address. Which kind it was is `aboutTheAddress` below.
 */
export class SsrfError extends Error {
  /**
   * Whether this refusal is about which address the URL points at.
   *
   * Only those may not be described to the model: the message names a
   * hostname on our block list or an address inside the network, and knowing
   * it is a way to read the inside of the network from outside. Everything
   * else this guard rejects -- a name with no DNS records, a scheme it does
   * not speak, a redirect chain that never ends -- is a plain fact about the
   * request, and one the model needs to correct its next move.
   */
  readonly aboutTheAddress: boolean;

  /**
   * Create an SsrfError.
   * @param message - Description of why the URL or host was rejected.
   * @param aboutTheAddress - True when the message names a blocked host or a
   *   resolved address, which is detail the model may not be shown.
   */
  constructor(message: string, aboutTheAddress = false) {
    super(message);
    this.name = "SsrfError";
    this.aboutTheAddress = aboutTheAddress;
  }
}

/**
 * IP range labels that must NOT be reachable from the agent.
 *
 * `ipaddr.js` returns one of: `unicast` (public), `private`,
 * `loopback`, `linkLocal`, `multicast`, `reserved`, `unspecified`,
 * `broadcast`, `uniqueLocal`, `ipv4Mapped`, `ipv4Compatible`,
 * `rfc6145`, `rfc6052`, `6to4`, `teredo`, `benchmarking`,
 * `amt`, `as112v6`, `deprecated`, `orchid2`, `droneRemoteIdProtocol`.
 *
 * Anything other than `unicast` is rejected. Using a denylist-of-
 * ranges is the safest default: new range classes added by the
 * library automatically get rejected rather than silently allowed.
 */
const ALLOWED_RANGES: ReadonlySet<string> = new Set(["unicast"]);

/** Hostnames that must be blocked even if DNS returns a unicast IP. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Maximum redirect hops followed by {@link safeFetch}. */
const MAX_REDIRECTS = 5;

/**
 * The default per-DELIVERY deadline in milliseconds, from configuration.
 *
 * Not per hop: the transport may deliver a hop more than once and gives each
 * of them this full figure. The unit is stated here because this is where a
 * reader meets the number.
 *
 * Configuration rather than a literal because how long a page may take is not
 * a fact about this code, and because it is a knob operations may want to turn
 * without a deploy. Read per call rather than at import, so that a caller
 * reaching this module before the config is loaded does not freeze a default.
 * @returns The configured deadline for one delivery.
 */
function defaultTimeoutMs(): number {
  return getAgentConfig().web_fetch_timeout_ms;
}

/**
 * Resolve a hostname and throw {@link SsrfError} if any resolved
 * address falls in a blocked range, or the hostname itself is on the
 * denylist.
 *
 * Note: `dns.lookup` returns only one address by default, but the
 * system resolver typically prefers the first record. For defense in
 * depth we call `lookup(host, { all: true })` when possible. `{ all: true }`
 * is supported in Node.js and returns every address record.
 * @param hostname - The raw hostname from the URL
 * @throws {SsrfError} if the hostname is blocked or resolves to a private IP
 */
async function assertHostnameAllowed(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().trim();

  if (normalized.length === 0) {
    throw new SsrfError("Empty hostname");
  }

  if (BLOCKED_HOSTNAMES.has(normalized)) {
    throw new SsrfError(`Blocked hostname: ${hostname}`, true);
  }

  // A bare IP literal in the URL — check it directly.
  if (ipaddr.isValid(normalized)) {
    assertIpAllowed(normalized);
    return;
  }

  // IPv6 literal. Not the edge case this comment used to call it: measured,
  // `new URL("http://[::1]/").hostname` KEEPS the brackets and
  // `ipaddr.isValid("[::1]")` is therefore false, so every IPv6 literal
  // misses the branch above and is refused here or nowhere.
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    assertIpAllowed(normalized.slice(1, -1));
    return;
  }

  // Resolve and check every returned address. A name the resolver turns down
  // ends here as this guard's own outcome rather than as whatever the system
  // resolver raised: what reaches the caller from this function is an
  // `SsrfError`, which is what its callers read to tell a fact about the
  // address from a fact about the request. A bare ENOTFOUND is neither, and
  // downstream it lands among the transport's pre-delivery refusals -- the
  // one group whose whole point is that nothing about the address is known.
  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(normalized, { all: true });
  } catch (err: unknown) {
    throw new SsrfError(
      `No DNS records for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfError(`No DNS records for ${hostname}`);
  }
  for (const { address } of addresses) {
    assertIpAllowed(address);
  }
}

/**
 * Throw {@link SsrfError} if the given IP (v4 or v6 string) is not
 * in the allowed unicast range.
 * @param ip - The IPv4 or IPv6 address literal to validate.
 */
function assertIpAllowed(ip: string): void {
  if (!ipaddr.isValid(ip)) {
    throw new SsrfError(`Invalid IP address: ${ip}`, true);
  }
  const parsed = ipaddr.parse(ip);
  const range = parsed.range();
  if (!ALLOWED_RANGES.has(range)) {
    throw new SsrfError(`Blocked IP range '${range}' for ${ip}`, true);
  }
}

/** Options accepted by {@link safeFetch}. A subset of `RequestInit`. */
export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Raised when the caller no longer wants the result.
   *
   * Checked once per hop as well as handed to the transport, because the two
   * cover different ground: the transport can end a delivery that is under
   * way, and only this loop can decline to start the next hop.
   */
  signal?: AbortSignal;
}

/**
 * Like `fetch`, but restricted to public-unicast HTTP(S) targets and
 * following redirects manually so that each hop is re-checked against
 * DNS and the IP deny list.
 *
 * The caller receives a native `Response` on success.
 * @param url - The initial URL to fetch
 * @param opts - Optional headers, and the deadline for ONE DELIVERY (not for
 *   a hop: a hop may be delivered more than once, each given the full figure)
 * @returns A `Response` from the final (non-redirect) hop
 * @throws {SsrfError} if any hop resolves to a non-public IP or matches
 *   a blocked hostname
 * @throws {TypeError} for malformed URLs
 * @throws {HttpRetryError} when the transport gave up without a response.
 *   This is the shape a caller meets on a bad network, and the one this
 *   module had no way of producing before the retries. Its exact form is
 *   asserted in `safe-fetch-retry.test.ts`.
 * @throws {Error} the transport's own refusals, which are about the request
 *   rather than about where it points and so are not `SsrfError`: a URL
 *   carrying credentials, or a `timeoutMs` no timer can hold. Both are raised
 *   before any delivery.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  let current = url;
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Asked at the top of every hop, not once before the loop. Following a
    // redirect chain means coming back here, and a caller that gave up during
    // the first hop must not have the second one started on its behalf — the
    // work is real (a DNS resolution and a request) and nobody is waiting for
    // the answer. The resolution below is the reason it goes first: once a
    // lookup is under way it cannot be called off, because `dns.lookup`
    // ignores an abort signal outright.
    opts.signal?.throwIfAborted();

    const parsed = new URL(current);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SsrfError(
        `Only http/https allowed, got '${parsed.protocol}'`,
      );
    }

    await assertHostnameAllowed(parsed.hostname);

    // Through the shared transport, which owns the retrying. `replaySafe` is
    // a statement about this request rather than a wish for reliability: a
    // hop is a read, so its only effect is the response, and a delivery that
    // produced none produced no effect to repeat. That declaration is what
    // buys the retry on a dropped connection — the failure this module used
    // to pass straight to the caller, and the reason this batch exists.
    //
    // The deadline goes in as `timeoutMs`, not as a signal on the init: the
    // transport replaces the caller's signal, so one left there would be a
    // no-op and every DELIVERY would silently get the transport's default
    // instead of this module's figure.
    //
    // `redirect: "manual"` stays in the init, because following redirects
    // here is the whole point — it is what lets the check above run again on
    // every hop rather than on the first URL only.
    const res = await httpRequest(
      current,
      { headers, redirect: "manual" },
      { replaySafe: true, timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
    );

    // Not a redirect — return to caller.
    if (res.status < 300 || res.status >= 400) {
      return res;
    }

    const location = res.headers.get("location");
    if (!location) {
      // 3xx without a Location header — pass it back, caller decides.
      return res;
    }

    // Resolve relative redirect against the current URL.
    current = new URL(location, current).href;
  }

  throw new SsrfError(`Too many redirects (>${MAX_REDIRECTS})`);
}
