/**
 * Health check endpoint.
 *
 * Pings PostgreSQL and Redis to verify connectivity.
 * Returns service status for monitoring.
 */

import { Hono } from "hono";
import { rawPg } from "@breatic/core";
import { getRedis } from "@breatic/core";

const health = new Hono();

/**
 * `GET /api/health` — verify database and cache connectivity.
 *
 * @returns Service status with individual component health
 */
health.get("/", async (c) => {
  const startTime = process.uptime();
  const services: Record<string, string> = {};

  // Check PostgreSQL
  try {
    await rawPg`SELECT 1`;
    services.db = "ok";
  } catch {
    services.db = "error";
  }

  // Check Redis
  try {
    const redis = getRedis();
    await redis.ping();
    services.redis = "ok";
  } catch {
    services.redis = "error";
  }

  const allHealthy = Object.values(services).every((s) => s === "ok");
  const status = allHealthy ? "ok" : "degraded";

  return c.json(
    {
      status,
      services,
      uptime: Math.round(startTime),
      timestamp: new Date().toISOString(),
    },
    allHealthy ? 200 : 503,
  );
});

export { health as healthRoute };
