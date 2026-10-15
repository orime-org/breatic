// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared rate-limit middleware (auth, studio and post-auth routes).
 *
 * A route is limited by one or more quotas, each keyed by a dimension:
 * `'ip'` — the client address (pre-auth routes); `'ip+email'` — that address
 * paired with the validated email, so people behind one egress address do not
 * use up each other's attempts (inner#1478); `'user'` — the authenticated
 * user; `'socket'` — the connection's own address, for a listener no proxy
 * stands in front of. All quotas of a request are judged in one call to core,
 * so a refused request takes up room in none of them.
 *
 * The client address follows the rule collab uses (`decideClientIdentity`):
 * a request from this machine is not counted, one that did not come through
 * our nginx is refused, and otherwise it is the `x-real-ip` our nginx wrote.
 */

import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getRedis, checkRateLimit, decideClientIdentity, logger, type RateLimitQuota } from "@breatic/core";
import { t } from "@breatic/shared";
import { getRateLimit } from "@server/config/rate-limits.js";

/** A quota's key dimension. */
export type KeyBy = "ip" | "ip+email" | "user" | "socket";

/** One quota a route is limited by. */
export interface Quota {
  /** Redis key prefix naming the limited action (e.g. `login`). */
  prefix: string;
  /** Requests admitted within the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Key dimension; `'ip'` when absent. */
  keyBy?: KeyBy;
}

/** How a limiter answers a refused request and an unreachable counter. */
export interface RateLimitAnswers {
  /** The 429 body; the public envelope when absent. `Retry-After` is set either way. */
  onLimited?: (c: Context, retryAfterSeconds: number) => Response;
  /** Answer this when the counter cannot be read, instead of letting the request through. */
  failClosed?: (c: Context) => Response;
}

/** Where a request's client-address keys come from. */
type ClientAddress = { kind: "counted"; address: string } | { kind: "exempt" } | { kind: "refused"; reason: string };

/**
 * The client address of a request, by the rule collab uses.
 * @param c - The request context; must run on `@hono/node-server` bindings.
 * @returns The address to count under, an exemption, or a refusal.
 */
function clientAddress(c: Context): ClientAddress {
  const decision = decideClientIdentity({
    peerAddress: getConnInfo(c).remote.address,
    realIpHeader: c.req.header("x-real-ip"),
  });
  if (decision.kind === "exempt") return { kind: "exempt" };
  if (decision.kind === "refuse") return { kind: "refused", reason: decision.reason };
  return { kind: "counted", address: decision.identity };
}

/**
 * The validated email of a request, hashed so no address is stored in Redis.
 * @param c - The request context; `validate("json", …)` with an `email` must run first.
 * @returns The hex sha256 of the email.
 * @throws {Error} When the route did not validate an email before the limiter.
 */
function emailHash(c: Context): string {
  const body = (c.req.valid as (target: "json") => unknown)("json") as { email?: unknown } | undefined;
  if (typeof body?.email !== "string") throw new Error("rate limit keyed by email runs before an email was validated");
  return createHash("sha256").update(body.email).digest("hex");
}

/**
 * The key of one quota for a request.
 * @param c - The request context.
 * @param keyBy - The quota's dimension.
 * @param client - The request's client address, resolved once.
 * @returns The key without the action prefix, or null when the quota does not count this request.
 */
function quotaKey(c: Context, keyBy: KeyBy, client: () => ClientAddress): string | null {
  if (keyBy === "user") return (c.get("user") as { id: string } | undefined)?.id ?? "anonymous";
  if (keyBy === "socket") return getConnInfo(c).remote.address ?? "unknown";
  const resolved = client();
  if (resolved.kind !== "counted") return null;
  return keyBy === "ip" ? resolved.address : `${resolved.address}:${emailHash(c)}`;
}

/**
 * Rate-limit middleware over one or more quotas (sliding windows in Redis).
 * @param opts - The quotas and the answers.
 * @param opts.quotas - The quotas the route is limited by, judged together.
 * @param opts.onLimited - The 429 body; the public envelope when absent.
 * @param opts.failClosed - The answer when Redis cannot count; absent lets the error through.
 * @returns A Hono middleware that answers `403` for a request that did not come
 *   through our proxy, and `429` with `Retry-After` when any quota is full.
 */
export function rateLimit(opts: { quotas: readonly Quota[] } & RateLimitAnswers): MiddlewareHandler {
  return async (c, next) => {
    let resolved: ClientAddress | undefined;
    /**
     * The request's client address, resolved on first use.
     * @returns The address, exemption or refusal.
     */
    const client = (): ClientAddress => (resolved ??= clientAddress(c));
    const judged: RateLimitQuota[] = [];
    for (const quota of opts.quotas) {
      const key = quotaKey(c, quota.keyBy ?? "ip", client);
      if (key !== null) judged.push({ key: `${quota.prefix}:${key}`, max: quota.max, windowSeconds: quota.windowSeconds });
    }
    const actions = opts.quotas.map((q) => q.prefix);
    if (resolved?.kind === "refused") {
      logger.error({ actions, reason: resolved.reason }, "rate_limit_client_unidentified");
      return c.json({ error: { code: 403, message: t("server.error.forbidden") } }, 403);
    }
    if (judged.length === 0) return next();
    let verdict: Awaited<ReturnType<typeof checkRateLimit>>;
    try {
      verdict = await checkRateLimit(getRedis(), judged);
    } catch (err) {
      if (!opts.failClosed) throw err;
      logger.error({ err, actions }, "rate_limit_unavailable");
      return opts.failClosed(c);
    }
    if (!verdict.allowed) {
      logger.warn({ actions, keys: judged.map((q) => q.key) }, "rate_limit_hit");
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      if (opts.onLimited) return opts.onLimited(c, verdict.retryAfterSeconds);
      return c.json({ error: { code: 429, message: t("server.error.rate_limited") } }, 429);
    }
    await next();
  };
}

/**
 * Rate limit a route by quotas whose `max` / `windowSeconds` come from
 * `config/rate-limits.yaml` (via {@link getRateLimit}) — the single way routes
 * throttle, so no throttle number lives in code. Each action doubles as the
 * yaml key and the Redis prefix.
 * @param specs - The actions the route is limited by and each one's dimension.
 * @param answers - The 429 body and the fail-closed answer, when not the public ones.
 * @returns The configured rate-limit middleware.
 */
export function rateLimitForAll(
  specs: readonly { action: string; keyBy?: KeyBy }[],
  answers: RateLimitAnswers = {},
): MiddlewareHandler {
  // Config is read + the inner middleware built on the FIRST request,
  // not at import — route registration must stay side-effect-free so a
  // route file can be imported without a config file present (tests).
  let inner: MiddlewareHandler | null = null;
  return async (c, next) => {
    inner ??= rateLimit({
      quotas: specs.map(({ action, keyBy }) => ({ prefix: action, ...getRateLimit(action), keyBy })),
      ...answers,
    });
    return inner(c, next);
  };
}

/**
 * Rate limit a route by one quota from `config/rate-limits.yaml`.
 * @param action - Throttle action (yaml key + Redis prefix, e.g. `register`).
 * @param keyBy - The quota's dimension; `'ip'` when absent.
 * @param answers - The 429 body and the fail-closed answer, when not the public ones.
 * @returns The configured rate-limit middleware.
 */
export function rateLimitFor(action: string, keyBy?: KeyBy, answers: RateLimitAnswers = {}): MiddlewareHandler {
  return rateLimitForAll([{ action, keyBy }], answers);
}
