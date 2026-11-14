// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Rate limits for downstream-token requests (#1488 §6).
 *
 * The external agent's counters live in Redis DB 4, never in the DB 0
 * counters people use. A route that names a Project counts each of its own
 * actions per user per Studio, once its `validate` has read the `project_id`
 * (the route's limiter hands the request to {@link limitDownstream}); every
 * other request counts once, when it is authenticated, in the user's total.
 * The same user's agents share these counters across every connection.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import {
  checkRateLimit,
  getMcpConfig,
  getMcpRedis,
  logger,
  projectsRepo,
  type RateLimitQuota,
} from "@breatic/core";
import { t } from "@breatic/shared";
import { getRateLimit } from "@server/config/rate-limits.js";
import type { DownstreamAgent } from "@server/modules/agent-access/downstream-auth.js";
import { matchDownstreamRoute } from "@server/modules/agent-access/downstream-routes.js";

/** One route quota, as the shared limiter holds it. */
interface ActionQuota {
  prefix: string;
  max: number;
  windowSeconds: number;
}

/**
 * The user's total quota, for requests that resolve no Studio.
 * @param userId - The user.
 * @returns The quota.
 */
function totalQuota(userId: string): RateLimitQuota {
  return { key: `mcp:rate:${userId}:all`, max: getMcpConfig().rate_limit.user_total_per_minute, windowSeconds: 60 };
}

/**
 * The signed-in user's id.
 * @param c - The request context, past `requireAuth`.
 * @returns The id.
 */
function userIdOf(c: Context): string {
  return (c.get("user") as { id: string }).id;
}

/**
 * Judge a downstream request against its quotas in Redis DB 4.
 * @param c - The request context.
 * @param next - The rest of the chain.
 * @param quotas - The quotas it falls under.
 * @returns A 429 with `Retry-After` when any is full; otherwise what the chain answers.
 * @throws {Error} When Redis cannot count.
 */
async function judge(c: Context, next: Next, quotas: readonly RateLimitQuota[]): Promise<Response | void> {
  const verdict = await checkRateLimit(getMcpRedis(), quotas);
  if (!verdict.allowed) {
    const agent = c.get("agent") as DownstreamAgent | undefined;
    logger.warn({ keys: quotas.map((q) => q.key), connectionId: agent?.connectionId }, "mcp_rate_limit_hit");
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: { code: 429, message: t("server.error.rate_limited") } }, 429);
  }
  await next();
}

/**
 * Count a just-authenticated downstream request in the user's total, unless
 * its route names a Project, which its limiter counts after `validate`.
 * @param c - The request context; `user` is set.
 * @param next - The rest of the chain.
 * @returns A 429 with `Retry-After` when the total is spent; otherwise what the chain answers.
 * @throws {Error} When Redis cannot count.
 */
export async function limitDownstreamTotal(c: Context, next: Next): Promise<Response | void> {
  if (matchDownstreamRoute(c)?.project) return next();
  return judge(c, next, [totalQuota(userIdOf(c))]);
}

/**
 * Count a downstream request on a route that names a Project, in place of the
 * route's DB 0 limiter: each of the route's actions per user per Studio. A
 * request whose Project resolves to no Studio counts in the user's total; one
 * on any other route was counted when it was authenticated.
 * @param c - The request context; the route's `validate` has run.
 * @param next - The rest of the chain.
 * @param quotas - The route's own quotas.
 * @returns A 429 with `Retry-After` when any quota is full; otherwise what the chain answers.
 * @throws {Error} When Redis or the database cannot be read.
 */
export async function limitDownstream(c: Context, next: Next, quotas: readonly ActionQuota[]): Promise<Response | void> {
  const route = matchDownstreamRoute(c);
  if (!route?.project) return next();
  const userId = userIdOf(c);
  const body = (c.req.valid as (target: string) => unknown)(route.project) as { project_id?: unknown } | undefined;
  const projectId = typeof body?.project_id === "string" ? body.project_id : undefined;
  const studioId = projectId === undefined ? undefined : await projectsRepo.findOwnerStudioId(projectId);
  if (studioId === undefined) return judge(c, next, [totalQuota(userId)]);
  return judge(c, next, quotas.map((q) => ({ key: `mcp:rate:${userId}:${studioId}:${q.prefix}`, max: q.max, windowSeconds: q.windowSeconds })));
}

/**
 * A limiter for a route that names a Project and has no limiter of its own:
 * cookie requests pass untouched, downstream requests count `action` from
 * `config/rate-limits.yaml` per user per Studio.
 * @param action - The yaml key and the counter's name.
 * @returns The middleware; mount it after the route's `validate`.
 */
export function downstreamRateLimitFor(action: string): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get("agent")) return next();
    return limitDownstream(c, next, [{ prefix: action, ...getRateLimit(action) }]);
  };
}
