/**
 * Request logging middleware using pino.
 *
 * Logs method, path, status code, and response time for every request.
 */

import type { MiddlewareHandler } from "hono";
import { logger as log } from "@breatic/core";

/** HTTP request logging middleware. */
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
