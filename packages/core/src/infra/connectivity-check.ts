/**
 * Fail-fast connectivity check for infrastructure dependencies.
 *
 * Called at service startup (API/Worker) before any business logic.
 * Per CLAUDE.md "进程生命周期" mandate: library code doesn't decide
 * when the process dies. If a dependency probe fails this throws
 * `InfraNotReadyError` and the application entry's top-level
 * catch logs + exits.
 *
 * This is intentionally called at startup — it cannot be bypassed
 * by running the service from a non-standard entry point (e.g. via
 * `tsx packages/server/src/index.ts` directly).
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { getRedis } from "./redis.js";
import { env } from "../config/env.js";
import { InfraNotReadyError } from "./errors.js";

/**
 * Check that PostgreSQL and Redis are reachable.
 *
 * @throws {InfraNotReadyError} If either check fails. The
 *   application entry catches, logs `{ component, hint, cause }`,
 *   and calls `process.exit(1)`.
 */
export async function checkInfraReady(): Promise<void> {
  // PostgreSQL: run a trivial query to confirm the server accepts connections
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    throw new InfraNotReadyError(
      "PostgreSQL",
      `Check DATABASE_URL=${env.DATABASE_URL} or run: docker compose up -d postgres`,
      err,
    );
  }

  // Redis: PING round-trip confirms the server is ready
  try {
    const redis = getRedis();
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error(`unexpected PING response: ${pong}`);
    }
  } catch (err) {
    throw new InfraNotReadyError(
      "Redis",
      `Check REDIS_URL=${env.REDIS_URL} or run: docker compose up -d redis`,
      err,
    );
  }
}
