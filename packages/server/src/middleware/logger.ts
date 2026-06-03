// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Request logging middleware using pino.
 *
 * Logs method, path, status code, and response time for every request.
 */

import type { MiddlewareHandler } from "hono";
import { logger as log } from "@breatic/core";

/**
 * HTTP request logging middleware.
 * @param c - The Hono request context, read for method, path, and response status.
 * @param next - The downstream handler, awaited so the elapsed duration can be measured.
 */
export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  log.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration,
    },
    `${c.req.method} ${c.req.path} ${c.res.status} ${duration}ms`,
  );
};
