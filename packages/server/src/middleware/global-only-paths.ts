// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Outside the global region, refuse the API paths whose data lives only in
 * the global region (inner#1955). The web never sends them here, so a request
 * for one is someone else's: it is answered 404, the way a route that does
 * not exist is, and logged, before anything reaches a table this region's
 * database role may not read.
 */

import type { MiddlewareHandler } from "hono";
import { env, logger, NotFoundError, isGlobalRegion } from "@breatic/core";
import { GLOBAL_API_PATHS, t } from "@breatic/shared";

const API_PREFIX = "/api/v1";

/**
 * Refuse a global-only path outside the global region.
 * @param c - The request context.
 * @param next - The rest of the app.
 * @returns Once the request has been answered.
 * @throws {NotFoundError} For a global-only path in another region.
 */
export const refuseGlobalOnlyPaths: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  if (!isGlobalRegion(env) && path.startsWith(API_PREFIX) && GLOBAL_API_PATHS.test(path.slice(API_PREFIX.length))) {
    logger.warn({ path, method: c.req.method, region: env.REGION }, "global_only_path_refused");
    throw new NotFoundError(t("server.error.not_found"));
  }
  await next();
};
