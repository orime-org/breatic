/**
 * Fail-fast connectivity check for Collab's dependencies.
 *
 * Collab depends on `@breatic/core` only for infrastructure
 * factories (createRedisClient + production-safety defaults); the
 * business-logic-laden `checkInfraReady` in core/infra exists for
 * server/worker, but collab keeps its own focused boot-time check
 * implementation. Called at startup before the server begins accepting
 * connections.
 */

import {
  checkPgReachable,
  createRedisClient,
  pingRedis,
  InfraNotReadyError,
} from "@breatic/core";

/**
 * Verify that PostgreSQL and Redis are reachable.
 * @param databaseUrl - PostgreSQL connection string
 * @param redisUrl - Redis connection string (general-purpose DB)
 * @param streamRedisUrl - Redis connection string (stream DB)
 * @throws {InfraNotReadyError} when PostgreSQL or either Redis connection (general or stream DB) is unreachable; the application entry catches it and exits with code 1.
 */
export async function checkCollabInfraReady(
  databaseUrl: string,
  redisUrl: string,
  streamRedisUrl: string,
): Promise<void> {
  // PostgreSQL: fail-fast reachability probe on a throwaway short-
  // connect-timeout client. core owns the postgres.js driver + the
  // probe client's lifecycle (createPgClient → SELECT 1 → end), so
  // collab takes no direct `postgres` dependency.
  try {
    await checkPgReachable(databaseUrl, { connectTimeout: 5 });
  } catch (err) {
    throw new InfraNotReadyError(
      "PostgreSQL",
      `Check DATABASE_URL=${databaseUrl} or run: docker compose up -d postgres`,
      err,
    );
  }

  // Redis (general): PING
  // Connectivity check is a startup-only single PING with
  // fail-fast semantics, so we override `maxRetriesPerRequest: 1`
  // (the factory default of 3 would mask a genuinely down Redis
  // for ~10 seconds during boot) while keeping the rest of the
  // production defaults from `createRedisClient`.
  const redis = createRedisClient(redisUrl, {
    name: "collab-connectivity-check",
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    if (!(await pingRedis(redis))) throw new Error("unexpected PING response");
    await redis.quit();
  } catch (err) {
    redis.disconnect();
    throw new InfraNotReadyError(
      "Redis",
      `Check REDIS_URL=${redisUrl} or run: docker compose up -d redis`,
      err,
    );
  }

  // Redis (stream DB): if different from REDIS_URL, verify it separately
  if (streamRedisUrl !== redisUrl) {
    const streamRedis = createRedisClient(streamRedisUrl, {
      name: "collab-connectivity-check-stream",
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await streamRedis.connect();
      if (!(await pingRedis(streamRedis))) throw new Error("unexpected PING response");
      await streamRedis.quit();
    } catch (err) {
      streamRedis.disconnect();
      throw new InfraNotReadyError(
        "Redis (stream DB)",
        `Check REDIS_STREAM_URL=${streamRedisUrl} or run: docker compose up -d redis`,
        err,
      );
    }
  }
}
