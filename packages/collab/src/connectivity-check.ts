/**
 * Fail-fast connectivity check for Collab's dependencies.
 *
 * Collab does not depend on @breatic/core, so it has its own check
 * implementation. Called at startup before the server begins accepting
 * connections.
 */

import postgres from "postgres";
import IoRedis from "ioredis";

function fatal(label: string, err: unknown, hint: string): never {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`\n❌ ${label} not reachable: ${message}`);
  // eslint-disable-next-line no-console
  console.error(`   → ${hint}\n`);
  process.exit(1);
}

/**
 * Verify that PostgreSQL and Redis are reachable.
 *
 * @param databaseUrl - PostgreSQL connection string
 * @param redisUrl - Redis connection string (general-purpose DB)
 * @param streamRedisUrl - Redis connection string (stream DB)
 * @throws Exits process with code 1 if any check fails.
 */
export async function checkCollabInfraReady(
  databaseUrl: string,
  redisUrl: string,
  streamRedisUrl: string,
): Promise<void> {
  // PostgreSQL: confirm server accepts queries
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    await sql`SELECT 1`;
    await sql.end();
  } catch (err) {
    await sql.end().catch(() => {});
    fatal(
      "PostgreSQL",
      err,
      `Check DATABASE_URL=${databaseUrl} or run: docker compose up -d postgres`,
    );
  }

  // Redis (general): PING
  const redis = new IoRedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`unexpected PING response: ${pong}`);
    await redis.quit();
  } catch (err) {
    redis.disconnect();
    fatal(
      "Redis",
      err,
      `Check REDIS_URL=${redisUrl} or run: docker compose up -d redis`,
    );
  }

  // Redis (stream DB): if different from REDIS_URL, verify it separately
  if (streamRedisUrl !== redisUrl) {
    const streamRedis = new IoRedis(streamRedisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await streamRedis.connect();
      const pong = await streamRedis.ping();
      if (pong !== "PONG") throw new Error(`unexpected PING response: ${pong}`);
      await streamRedis.quit();
    } catch (err) {
      streamRedis.disconnect();
      fatal(
        "Redis (stream DB)",
        err,
        `Check REDIS_STREAM_URL=${streamRedisUrl} or run: docker compose up -d redis`,
      );
    }
  }
}
