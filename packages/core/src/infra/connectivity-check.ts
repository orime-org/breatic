/**
 * Fail-fast connectivity check for infrastructure dependencies.
 *
 * Called at service startup (API/Worker) before any business logic.
 * If PostgreSQL or Redis is unreachable, prints a clear error message
 * and exits the process with code 1.
 *
 * This is intentionally called at startup — it cannot be bypassed
 * by running the service from a non-standard entry point (e.g. via
 * `tsx packages/server/src/index.ts` directly).
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { getRedis } from "./redis.js";
import { env } from "../config/env.js";

/** Print a clear error message and exit with code 1. */
function fatal(label: string, err: unknown, hint: string): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ ${label} not reachable: ${message}`);
  console.error(`   → ${hint}\n`);
  process.exit(1);
}

/**
 * Check that PostgreSQL and Redis are reachable.
 *
 * @throws Exits process with code 1 if either check fails.
 */
export async function checkInfraReady(): Promise<void> {
  // PostgreSQL: run a trivial query to confirm the server accepts connections
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    fatal(
      "PostgreSQL",
      err,
      `Check DATABASE_URL=${env.DATABASE_URL} or run: docker compose up -d postgres`,
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
    fatal(
      "Redis",
      err,
      `Check REDIS_URL=${env.REDIS_URL} or run: docker compose up -d redis`,
    );
  }
}
