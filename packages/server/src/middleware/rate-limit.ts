// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared rate-limit middleware (auth + studio routes).
 *
 * Extracted from the auth route's private limiter so studio routes can reuse it
 * without a second implementation. Adds a `keyBy` dimension: `'ip'` (the
 * original behaviour, keyed by `x-forwarded-for`) for pre-auth endpoints, and
 * `'user'` (keyed by the authenticated user's id) for post-auth endpoints where
 * an IP key is too coarse (shared NAT) or too easy to rotate.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getRedis, checkRateLimit, logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { getRateLimit } from "@server/config/rate-limits.js";

/**
 * A request's rate-limit key dimension: the client's address as forwarded,
 * the socket's own address, the signed-in user, or the signed-in user and one
 * route param (one bucket per thing that param names, such as one upload).
 */
type KeyBy = "ip" | "socket" | "user" | { readonly userAndParam: string };

/** How a limiter answers a refused request and an unreachable counter. */
export interface RateLimitAnswers {
  /** The 429 body; the public envelope when absent. `Retry-After` is set either way. */
  onLimited?: (c: Context, retryAfterSeconds: number) => Response;
  /** Answer this when the counter cannot be read, instead of letting the request through. */
  failClosed?: (c: Context) => Response;
}

/**
 * Resolve the rate-limit key for a request under the given dimension.
 *
 * `'user'` reads the authenticated user's id (the middleware must run AFTER
 * `requireAuth`); it falls back to `"anonymous"` if no user is present so a
 * misconfigured chain degrades to a single shared bucket rather than throwing.
 * `'ip'` reads the first `x-forwarded-for` hop. `'socket'` reads the
 * connection's own address, for a listener no proxy stands in front of.
 * @param c - The Hono context for the current request
 * @param keyBy - The key dimension
 * @returns The bucket key (without the action prefix)
 */
function resolveKey(c: Parameters<MiddlewareHandler>[0], keyBy: KeyBy): string {
  if (keyBy === "socket") return getConnInfo(c).remote.address ?? "unknown";
  if (keyBy !== "ip") {
    const user = c.get("user") as { id: string } | undefined;
    const id = user?.id ?? "anonymous";
    return keyBy === "user" ? id : `${id}:${c.req.param(keyBy.userAndParam) ?? ""}`;
  }
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * Rate-limit middleware factory (sliding window via Redis).
 * @param opts - Limiter configuration.
 * @param opts.prefix - Redis key prefix identifying the limited action (e.g. `login`, `studio-create`).
 * @param opts.max - Maximum allowed requests per window.
 * @param opts.windowSeconds - Sliding window length in seconds.
 * @param opts.keyBy - Bucket dimension: `'ip'` (default), `'socket'`, `'user'`, or the user and one route param (the last two need `requireAuth` upstream).
 * @param opts.onLimited - The 429 body; the public envelope when absent.
 * @param opts.failClosed - The answer when Redis cannot count; absent lets the request through.
 * @returns A Hono middleware that returns `429` with a `Retry-After` header when the limit is exceeded.
 */
export function rateLimit(
  opts: {
    prefix: string;
    max: number;
    windowSeconds: number;
    keyBy?: KeyBy;
  } & RateLimitAnswers,
): MiddlewareHandler {
  return async (c, next) => {
    const key = resolveKey(c, opts.keyBy ?? "ip");
    const bucket = `${opts.prefix}:${key}`;
    let allowed: boolean;
    try {
      allowed = await checkRateLimit(getRedis(), bucket, opts.max, opts.windowSeconds, {
        strict: opts.failClosed !== undefined,
      });
    } catch (err) {
      if (!opts.failClosed) throw err;
      logger.error({ err, action: opts.prefix }, "rate_limit_unavailable");
      return opts.failClosed(c);
    }
    if (!allowed) {
      logger.warn({ action: opts.prefix, key }, "rate_limit_hit");
      c.header("Retry-After", String(opts.windowSeconds));
      if (opts.onLimited) return opts.onLimited(c, opts.windowSeconds);
      return c.json(
        { error: { code: 429, message: t("server.error.rate_limited") } },
        429,
      );
    }
    await next();
  };
}

/**
 * Build a rate-limit middleware whose `max` / `windowSeconds` come from
 * `config/rate-limits.yaml` (via {@link getRateLimit}) instead of
 * hardcoded literals — the single way routes should throttle, so no
 * throttle number lives in code. The `action` doubles as the yaml key
 * and the Redis prefix.
 * @param action - Throttle action (yaml key + Redis prefix, e.g. `login`).
 * @param keyBy - Bucket dimension: `'ip'` (default), `'socket'`, `'user'`, or the user and one route param (the last two need `requireAuth` upstream).
 * @param answers - The 429 body and the fail-closed answer, when not the public ones.
 * @returns The configured rate-limit middleware.
 */
export function rateLimitFor(
  action: string,
  keyBy?: KeyBy,
  answers: RateLimitAnswers = {},
): MiddlewareHandler {
  // Config is read + the inner middleware built on the FIRST request,
  // not at import — route registration must stay side-effect-free so a
  // route file can be imported without a config file present (tests).
  let inner: MiddlewareHandler | null = null;
  return async (c, next) => {
    if (!inner) {
      const { max, windowSeconds } = getRateLimit(action);
      inner = rateLimit({ prefix: action, max, windowSeconds, keyBy, ...answers });
    }
    return inner(c, next);
  };
}
