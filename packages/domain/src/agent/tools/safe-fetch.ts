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
  /** Per-hop deadline; applies alongside `signal`, not instead of it. */
  timeoutMs?: number;
  /**
   * Caller cancellation, honoured on every hop.
   *
   * Supplied by the shared HTTP transport when this function is used as its
   * fetch implementation: that signal carries both the per-attempt deadline
   * and the user's stop button. Retrying happens ABOVE this guard, so each
   * replay re-runs the full per-hop DNS and range check — which is the point
   * of driving it this way rather than retrying inside a connection pool.
   */
  signal?: AbortSignal;
}

/**
 * Header names carrying a credential, dropped when a redirect leaves the
 * origin the caller aimed at.
 *
 * `Authorization` is the one the Fetch Standard itself removes on a
 * cross-origin redirect (whatwg/fetch#1544, shipped in Gecko and WebKit); the
 * stated goal is to scope a developer-set credential to the origin of the
 * initial request. The other two are on the browser's forbidden list so a page
 * could never set them — but this runs in Node, where a caller can, so they are
 * covered here too.
 *
 * The limit is worth stating rather than hiding: a vendor's own scheme
 * (`X-Api-Key`, `X-Subscription-Token`) is NOT recognised. The spec does not
 * recognise it either, and guessing which custom headers are secret would mean
 * silently dropping ones that are not.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/**
 * Drop credential headers when a redirect crosses to a different origin.
 * @param headers - The headers sent on the previous hop.
 * @param from - The URL the redirect came from.
 * @param to - The URL the redirect points at.
 * @returns The headers to send on the next hop.
 */
function headersForNextHop(
  headers: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  if (new URL(from).origin === new URL(to).origin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()),
    ),
  );
}

/** A hop's signal plus the clock it has to be able to stop. */
interface HopDeadline {
  /** Aborts on this hop's deadline or the caller's cancellation. */
  signal: AbortSignal;
  /**
   * Stop the deadline, keeping the caller's cancellation live.
   *
   * Called the moment the headers land. The deadline bounds "connect and
   * answer" for ONE hop; leaving it running turns it into a total budget on
   * the whole exchange, body included. That contradicts the transport above,
   * whose body deadline is deliberately IDLE — a page streaming steadily for
   * longer than this timeout is healthy, not stuck. Measured before this
   * existed, against a real socket:
   * a body writing every 120ms was killed at 603ms by a 600ms hop deadline.
   *
   * The transport does the same thing with its own headers deadline
   * (`startAttemptDeadline(...).dispose()`), so this is one rule applied in
   * both halves of a request rather than a new one.
   */
  headersArrived: () => void;
  /**
   * Detach from the caller's signal — this hop is over and nothing will read
   * its body.
   *
   * Separate from `headersArrived` because the two retire different
   * things at different times. Only the hop whose response is RETURNED keeps
   * its listener: the caller's cancellation still has to reach that request
   * while the body is being read. Every hop we walk past, and every hop that
   * failed, is finished the moment we leave it — and leaving the listener
   * attached meant a five-hop chain left five behind on a signal the caller may
   * hold for a whole session.
   */
  release: () => void;
}

/**
 * Combine the caller's cancellation with this hop's own deadline.
 *
 * Built by hand rather than from `AbortSignal.timeout` + `AbortSignal.any`,
 * because a composed signal cannot be told to drop one of its inputs — and
 * dropping the deadline while keeping the cancellation is the whole point.
 * @param callerSignal - The caller's signal, if any.
 * @param timeoutMs - This hop's ceiling in milliseconds.
 * @returns The signal to pass to `fetch`, and the way to stop its clock.
 */
function hopSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): HopDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`safeFetch hop exceeded ${timeoutMs}ms`, "TimeoutError"),
    );
  }, timeoutMs);

  /**
   * Forward the caller's cancellation to this hop.
   * @returns Nothing.
   */
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      // Registered for the whole life of the hop, not just the fetch: the
      // caller's cancellation must keep reaching the returned response while
      // its body is being read, which is long after this function returns.
      // `release()` is what takes it off again for every hop that does NOT get
      // returned.
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    headersArrived: (): void => clearTimeout(timer),
    release: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Like `fetch`, but restricted to public-unicast HTTP(S) targets and
 * following redirects manually so that each hop is re-checked against
 * DNS and the IP deny list.
 *
 * The caller receives a native `Response` on success.
 * @param url - The initial URL to fetch
 * @param opts - Optional headers and hop timeout
 * @returns A `Response` from the final (non-redirect) hop
 * @throws {SsrfError} if any hop resolves to a non-public IP, matches a
 *   blocked hostname, or carries a URL this guard cannot parse and therefore
 *   cannot check. A URL that will not parse is refused as an SSRF failure
 *   rather than a `TypeError` ON PURPOSE: the transport above skips its
 *   replays only for errors the caller recognises as deterministic, and an
 *   unparseable URL is exactly that — replaying it three times spends the
 *   whole budget re-deriving the same answer.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  let current = url;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let deadline: HopDeadline | undefined;

  try {
    for (let hopCount = 0; hopCount <= MAX_REDIRECTS; hopCount++) {
      // Stop before spending a DNS lookup or a request on a cancelled call.
      // Checked per hop, so a long redirect chain cannot outlive the caller.
      if (opts.signal?.aborted === true) {
        throw opts.signal.reason instanceof Error
          ? opts.signal.reason
          : new Error("safeFetch cancelled by caller");
      }

      const parsed = parseOrRefuse(current);

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new SsrfError(
          `Only http/https allowed, got '${parsed.protocol}'`,
        );
      }

      await assertHostnameAllowed(parsed.hostname);

      deadline = hopSignal(opts.signal, timeoutMs);
      let res: Response;
      try {
        res = await fetch(current, {
          headers,
          redirect: "manual",
          signal: deadline.signal,
        });
      } finally {
        // Whether the headers arrived or the hop failed, this clock is done. On
        // a redirect the next hop gets its own.
        deadline.headersArrived();
      }

      // Not a redirect — return to caller.
      if (res.status < 300 || res.status >= 400) {
        return res;
      }

      const location = res.headers.get("location");
      if (!location) {
        // 3xx without a Location header — pass it back, caller decides.
        return res;
      }

      // Let this hop's body go before asking for the next one. Dropping the
      // reference is not the same thing: an unread body holds its connection
      // until the peer gives up, so a chain of redirects held one apiece — and
      // a redirect is the common case, not the exotic one (http to https, a
      // tracking hop, a CDN). A 3xx body is a stub page, so this resolves at
      // once. The catch is required rather than tidy: cancelling a body the
      // peer already errored returns a rejected promise, and an unhandled
      // rejection ends the process.
      await res.body?.cancel().catch(() => {});

      // Resolve relative redirect against the current URL.
      const next = parseOrRefuse(location, current).href;
      // Scope any credential to the origin the caller aimed at, the way the
      // platform's own fetch does. Computed BEFORE `current` moves on, because
      // the question is about the step between the two.
      headers = headersForNextHop(headers, current, next);
      current = next;

      // This hop is finished and nothing will read its body, so it must stop
      // holding a listener on the caller's signal. Only the response we RETURN
      // keeps one.
      deadline.release();
      deadline = undefined;
      }

    throw new SsrfError(`Too many redirects (>${MAX_REDIRECTS})`);
  } catch (err) {
    // Nothing will read a body we never handed out, so the last hop's listener
    // goes too. The success paths above return without reaching this.
    deadline?.release();
    throw err;
  }
}

/**
 * Parse a URL, refusing an unparseable one as an SSRF failure.
 *
 * A URL we cannot parse is a URL we cannot check, which is the guard's whole
 * subject — and the TYPE matters as much as the refusal: `new URL()` throws a
 * `TypeError`, which the transport above reads as weather and replays. The
 * same malformed `Location` was followed three times before this existed.
 * @param input - The URL text.
 * @param base - Base URL for a relative reference.
 * @returns The parsed URL.
 * @throws {SsrfError} When it cannot be parsed.
 */
function parseOrRefuse(input: string, base?: string): URL {
  try {
    return base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    throw new SsrfError(`Unparseable URL: ${input}`);
  }
}
