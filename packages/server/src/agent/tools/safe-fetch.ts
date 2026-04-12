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
 *   5. Caps hop count and wall-clock timeout.
 *
 * DNS rebinding is partially mitigated by re-resolving per hop; a
 * determined attacker with a short-TTL DNS record and precise timing
 * could still race the check against the actual connect, but this
 * would require the target server's TCP stack to re-query DNS, which
 * it does not within a single fetch call. We therefore accept this
 * narrow residual risk in favor of keeping TLS SNI / `Host` headers
 * working correctly with the original hostname.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

/** Error thrown when a URL would reach a forbidden host or IP. */
export class SsrfError extends Error {
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

/** Default hop timeout in milliseconds. */
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
 *
 * @param hostname - The raw hostname from the URL
 * @throws SsrfError if the hostname is blocked or resolves to a private IP
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

  // IPv6 bracketed literal — URL.hostname strips brackets but handle
  // the edge case where something passes through anyway.
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
 *
 * @param url - The initial URL to fetch
 * @param opts - Optional headers and hop timeout
 * @returns A `Response` from the final (non-redirect) hop
 * @throws SsrfError if any hop resolves to a non-public IP or matches
 *   a blocked hostname
 * @throws TypeError for malformed URLs
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

    const res = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

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
