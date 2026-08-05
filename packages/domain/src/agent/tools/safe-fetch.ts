// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 *   5. Caps hop count, and gives each DELIVERY a deadline. Not each hop —
 *      the transport may deliver a hop up to three times, and each of those
 *      gets the full figure, so a hop's own worst case is a multiple of it.
 *
 * The request itself goes through the shared HTTP transport, which may
 * deliver one hop up to three times. That is deliberate: a dropped
 * connection used to fail the tool outright. The DNS check above runs
 * once per HOP, not once per delivery — what that widens is the next
 * paragraph.
 *
 * DNS rebinding is partially mitigated by re-resolving per hop; a
 * determined attacker with a short-TTL DNS record and precise timing
 * could still race the check against the actual connect, but this
 * would require the target server's TCP stack to re-query DNS, which
 * it does not within a single fetch call.
 *
 * What the retries add to that race was MEASURED rather than reasoned
 * about, because the obvious guess is wrong. A replay re-resolves only
 * when it needs a NEW connection, and undici pools by origin — so a
 * replay landing inside the keep-alive window reuses the socket and
 * resolves nothing at all. Counting TCP connections against a local
 * server (Node 24): three deliveries across the transport's own 1s and
 * 2s backoff opened ONE connection; three deliveries after dropped
 * connections opened three; two deliveries either side of a
 * `Retry-After: 6` opened two.
 *
 * So the widening is not "every delivery". It is the delivery that
 * waits long enough to outlive the pooled socket, and the far side is
 * what decides how long that is. A `Retry-After` on a 429 is honoured
 * up to 60 seconds, and 429 takes the protocol branch that does not
 * consult `replaySafe` at all, so a host answering "come back in 59
 * seconds" outlives any keep-alive: it forces a fresh connection, hence
 * a fresh and unchecked resolution, 59 seconds after the check that
 * cleared it. The precise timing the paragraph above asks of an
 * attacker arrives in the attacker's own header.
 *
 * That is accepted here rather than fixed here: the guard is the one
 * rigid gate, and hardening it is tracked separately.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { httpRequest } from "@breatic/shared";

/** Error thrown when a URL would reach a forbidden host or IP. */
export class SsrfError extends Error {
  /**
   * Create an SsrfError.
   * @param message - Description of why the URL or host was rejected.
   */
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
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
 * Default per-DELIVERY deadline in milliseconds.
 *
 * Not per hop: the transport may deliver a hop up to three times and gives
 * each of them this full figure, so a hop's own worst case is a multiple of
 * it. The name stays short; the unit is stated here because this is where a
 * reader learns what the number means.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

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
    throw new SsrfError(`Blocked hostname: ${hostname}`);
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

  // Resolve and check every returned address.
  const addresses = await dnsLookup(normalized, { all: true });
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
    throw new SsrfError(`Invalid IP address: ${ip}`);
  }
  const parsed = ipaddr.parse(ip);
  const range = parsed.range();
  if (!ALLOWED_RANGES.has(range)) {
    throw new SsrfError(
      `Blocked IP range '${range}' for ${ip}`,
    );
  }
}

/** Options accepted by {@link safeFetch}. A subset of `RequestInit`. */
export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Like `fetch`, but restricted to public-unicast HTTP(S) targets and
 * following redirects manually so that each hop is re-checked against
 * DNS and the IP deny list.
 *
 * The caller receives a native `Response` on success.
 * @param url - The initial URL to fetch
 * @param opts - Optional headers, and the deadline for ONE DELIVERY (not
 *   for a hop: a hop is up to three deliveries, each given the full figure)
 * @returns A `Response` from the final (non-redirect) hop
 * @throws {SsrfError} if any hop resolves to a non-public IP or matches
 *   a blocked hostname
 * @throws {TypeError} for malformed URLs
 * @throws {HttpRetryError} when a hop was delivered more than once and the
 *   last delivery still produced no response. This is the shape a caller now
 *   meets most often on a bad network, and it is the one this module used to
 *   have no way of producing — before the retries there was one delivery, so
 *   its failure reached the caller as itself.
 * @throws {Error} the transport's own refusals, which are about the request
 *   rather than about where it points and so are not `SsrfError`: a URL
 *   carrying credentials, or a `timeoutMs` no timer can hold. Both are raised
 *   before any delivery.
 *
 *   Not listed, because it cannot arrive HERE: the transport also rethrows a
 *   first failure unwrapped when no replay follows, but this call site sends
 *   no body and declares `replaySafe`, so a delivery that produced no
 *   response always earns one. Every connection-level failure therefore
 *   leaves as `HttpRetryError`. Documenting the unwrapped shape would send a
 *   caller looking for something this path never produces.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  let current = url;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
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
    // no-op and every hop would silently get the transport's 300s default.
    //
    // `redirect: "manual"` stays in the init, because following redirects
    // here is the whole point — it is what lets the check above run again on
    // every hop rather than on the first URL only.
    const res = await httpRequest(
      current,
      { headers, redirect: "manual" },
      { replaySafe: true, timeoutMs },
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
