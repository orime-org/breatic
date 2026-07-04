// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared rate-limit middleware (auth + studio routes).
 *
 * Extracted from the auth route's private limiter so studio routes can reuse it
 * without a second implementation. Adds a `keyBy` dimension: `'ip'` (the
 * original behaviour, keyed by `x-forwarded-for`) for pre-auth endpoints, and
 * `'user'` (keyed by the authenticated user's id) for post-auth endpoints where
 * an IP key is too coarse (shared NAT) or too easy to rotate.
 */

import type { MiddlewareHandler } from "hono";
import { getRedis, checkRateLimit, logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { getRateLimit } from "@server/config/rate-limits.js";

/** A request's rate-limit key dimension. */
type KeyBy = "ip" | "user";

/**
 * Resolve the rate-limit key for a request under the given dimension.
 *
 * `'user'` reads the authenticated user's id (the middleware must run AFTER
 * `requireAuth`); it falls back to `"anonymous"` if no user is present so a
 * misconfigured chain degrades to a single shared bucket rather than throwing.
 * `'ip'` reads the first `x-forwarded-for` hop.
 * @param c - The Hono context for the current request
 * @param keyBy - The key dimension (`'ip'` or `'user'`)
 * @returns The bucket key (without the action prefix)
 */
function resolveKey(c: Parameters<MiddlewareHandler>[0], keyBy: KeyBy): string {
  if (keyBy === "user") {
    const user = c.get("user") as { id: string } | undefined;
    return user?.id ?? "anonymous";
  }
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * Rate-limit middleware factory (sliding window via Redis).
 * @param opts - Limiter configuration.
 * @param opts.prefix - Redis key prefix identifying the limited action (e.g. `login`, `studio-create`).
 * @param opts.max - Maximum allowed requests per window.
 * @param opts.windowSeconds - Sliding window length in seconds.
 * @param opts.keyBy - Bucket dimension: `'ip'` (default) or `'user'` (requires `requireAuth` upstream).
 * @returns A Hono middleware that returns `429` with a `Retry-After` header when the limit is exceeded.
 */
export function rateLimit(opts: {
  prefix: string;
  max: number;
  windowSeconds: number;
  keyBy?: KeyBy;
}): MiddlewareHandler {
  return async (c, next) => {
    const key = resolveKey(c, opts.keyBy ?? "ip");
    const redis = getRedis();
    const allowed = await checkRateLimit(
      redis,
      `${opts.prefix}:${key}`,
      opts.max,
      opts.windowSeconds,
    );
    if (!allowed) {
      logger.warn({ action: opts.prefix, key }, "rate_limit_hit");
      return c.json(
        { error: { code: 429, message: t("server.error.rate_limited") } },
        429,
        { "Retry-After": String(opts.windowSeconds) },
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
 * @param keyBy - Bucket dimension: `'ip'` (default) or `'user'` (needs `requireAuth` upstream).
 * @returns The configured rate-limit middleware.
 */
export function rateLimitFor(
  action: string,
  keyBy?: KeyBy,
): MiddlewareHandler {
  // Config is read + the inner middleware built on the FIRST request,
  // not at import — route registration must stay side-effect-free so a
  // route file can be imported without a config file present (tests).
  let inner: MiddlewareHandler | null = null;
  return async (c, next) => {
    if (!inner) {
      const { max, windowSeconds } = getRateLimit(action);
      inner = rateLimit({ prefix: action, max, windowSeconds, keyBy });
    }
    return inner(c, next);
  };
}
