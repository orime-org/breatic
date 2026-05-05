/**
 * Vitest globalSetup for integration tests.
 *
 * Starts PostgreSQL + Redis testcontainers BEFORE any test worker is forked.
 * This is essential because @breatic/core/config/env.ts calls createEnv()
 * at module-load time and reads process.env immediately — the containers
 * must be up and the env vars injected before the first import of any
 * @breatic/core symbol in the test worker.
 *
 * Uses Vitest's provide() API to forward the URLs to the test worker
 * processes, where they are re-applied to process.env in the per-worker
 * setupFile (integration-setup.ts).
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve monorepo root from this file's location.
// This file lives at: packages/server/src/__tests__/integration/global-setup.ts
// 5 levels up → packages/server/src/__tests__/integration → __tests__ → src → server → packages → breatic (root)
const __dir = fileURLToPath(new URL(".", import.meta.url));
const MONOREPO_ROOT = resolve(__dir, "../../../../../");

/** Shared state across setup / teardown. */
let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;

type ProvideContext = {
  provide: (key: string, value: string) => void;
};

export async function setup({ provide }: ProvideContext): Promise<void> {
  console.log("[integration] Starting testcontainers...");

  // Start PostgreSQL + Redis in parallel for speed
  [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("breatic_test")
      .withUsername("breatic")
      .withPassword("breatic")
      .start(),
    new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .start(),
  ]);

  const pgUrl = pgContainer.getConnectionUri();
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisBase = `redis://${redisHost}:${redisPort}`;

  const urls = {
    DATABASE_URL: pgUrl,
    REDIS_URL: `${redisBase}/0`,
    REDIS_QUEUE_URL: `${redisBase}/1`,
    REDIS_STREAM_URL: `${redisBase}/2`,
  };

  // Inject into THIS process's env so any synchronous module imports
  // within globalSetup itself (e.g. postgres/drizzle for migrations) can find them.
  process.env.DATABASE_URL = urls.DATABASE_URL;
  process.env.REDIS_URL = urls.REDIS_URL;
  process.env.REDIS_QUEUE_URL = urls.REDIS_QUEUE_URL;
  process.env.REDIS_STREAM_URL = urls.REDIS_STREAM_URL;
  // ENV must be "dev" | "staging" | "prod" (see core/config/env.ts)
  process.env.ENV = "dev";
  process.env.LOGIN_MODE = "WithAccount";
  process.env.SESSION_SECRET_KEY = "test-secret-key-for-integration-tests";
  process.env.STORAGE_PROVIDER = "local";
  process.env.ALLOWED_ORIGINS = "http://localhost:3001";

  // Run migrations against the fresh PG container before any test runs
  console.log("[integration] Running migrations...");
  const migrationsFolder = resolve(MONOREPO_ROOT, "packages/core/src/db/migrations");
  const pgClient = postgres(pgUrl, { max: 1 });
  const db = drizzle(pgClient);
  await migrate(db, { migrationsFolder });
  await pgClient.end();

  console.log("[integration] Containers ready, migrations applied.");
  console.log(`[integration] PG: ${pgUrl}`);
  console.log(`[integration] Redis base: ${redisBase}`);

  // Forward URLs to test worker processes via inject() in integration-setup.ts
  provide("DATABASE_URL", urls.DATABASE_URL);
  provide("REDIS_URL", urls.REDIS_URL);
  provide("REDIS_QUEUE_URL", urls.REDIS_QUEUE_URL);
  provide("REDIS_STREAM_URL", urls.REDIS_STREAM_URL);
}

export async function teardown(): Promise<void> {
  console.log("[integration] Stopping containers...");
  await Promise.allSettled([
    pgContainer?.stop(),
    redisContainer?.stop(),
  ]);
  console.log("[integration] Containers stopped.");
}
