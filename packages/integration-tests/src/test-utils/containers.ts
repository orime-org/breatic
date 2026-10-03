// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Vitest globalSetup for every package's integration suite.
 *
 * Starts PostgreSQL + Redis testcontainers BEFORE any test worker is forked,
 * migrates both databases, and forwards the addresses to the workers through
 * Vitest's provide() API; `env.ts` re-applies them to process.env there.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

/** Shared state across setup / teardown. */
let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;

type ProvideContext = {
  provide: (key: string, value: string) => void;
};

/**
 * Start the containers, migrate both databases and provide their addresses.
 * @param ctx - Vitest's globalSetup context.
 * @param ctx.provide - Forwards a value to the test workers' `inject()`.
 * @returns once both databases are migrated.
 */
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
  // The Yjs document store is a SEPARATE database — a second DB in the
  // same container (mirrors the "same instance early" dev topology).
  const yjsUrlObj = new URL(pgUrl);
  yjsUrlObj.pathname = "/breatic_yjs_test";
  const yjsUrl = yjsUrlObj.toString();
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisBase = `redis://${redisHost}:${redisPort}`;

  const urls = {
    DATABASE_URL: pgUrl,
    YJS_DATABASE_URL: yjsUrl,
    REDIS_URL: `${redisBase}/0`,
    REDIS_QUEUE_URL: `${redisBase}/1`,
    REDIS_STREAM_URL: `${redisBase}/2`,
    // DB3 is collab's instance-coordination database (Hocuspocus pub/sub, the
    // Space-delete lock, the connection registry). A test that runs two collab
    // instances needs it to be the same Redis for both, which is what makes
    // cross-instance behaviour observable at all.
    REDIS_COLLAB_URL: `${redisBase}/3`,
  };

  // Inject into THIS process's env so any synchronous module imports
  // within globalSetup itself (e.g. postgres/drizzle for migrations) can find them.
  process.env.DATABASE_URL = urls.DATABASE_URL;
  process.env.YJS_DATABASE_URL = urls.YJS_DATABASE_URL;
  process.env.REDIS_URL = urls.REDIS_URL;
  process.env.REDIS_QUEUE_URL = urls.REDIS_QUEUE_URL;
  process.env.REDIS_STREAM_URL = urls.REDIS_STREAM_URL;
  process.env.REDIS_COLLAB_URL = urls.REDIS_COLLAB_URL;
  // The rest of what the config schema wants, needed because the migration step
  // below imports core. The R2 settings live in `env.ts` instead: they are
  // read when a storage adapter is built, and nothing here builds one.
  // ENV must be "dev" | "staging" | "prod" (see core/config/env.ts)
  process.env.ENV = "dev";
  process.env.STORAGE_PROVIDER = "r2";
  process.env.ALLOWED_ORIGINS = "http://localhost:8000";

  // Run migrations against the fresh PG container before any test runs.
  // Imported dynamically AFTER the env vars above are set: @breatic/core's
  // env.ts validates process.env at module-load, so core must not be imported
  // until DATABASE_URL etc. point at the freshly-started container. Routing
  // migration through core keeps drizzle-orm a core-only dependency
  // (CLAUDE.md "@core 内容归属").
  console.log("[integration] Running migrations...");
  const { migrateDatabase, migrateYjsDatabase, createTestDb } = await import(
    "@breatic/core"
  );
  await migrateDatabase(pgUrl);

  // Create + migrate the separate yjs test database in the same container.
  // CREATE DATABASE can't run inside a transaction; postgres-js sends the
  // single `unsafe` statement outside one. Connect via the business DB.
  const { client: bootstrapClient } = createTestDb(pgUrl, 1);
  try {
    await bootstrapClient.unsafe("CREATE DATABASE breatic_yjs_test");
  } finally {
    await bootstrapClient.end();
  }
  await migrateYjsDatabase(yjsUrl);

  console.log("[integration] Containers ready, migrations applied.");
  console.log(`[integration] PG: ${pgUrl}`);
  console.log(`[integration] yjs PG: ${yjsUrl}`);
  console.log(`[integration] Redis base: ${redisBase}`);

  // Forward URLs to test worker processes via inject() in env.ts
  provide("DATABASE_URL", urls.DATABASE_URL);
  provide("YJS_DATABASE_URL", urls.YJS_DATABASE_URL);
  provide("REDIS_URL", urls.REDIS_URL);
  provide("REDIS_QUEUE_URL", urls.REDIS_QUEUE_URL);
  provide("REDIS_STREAM_URL", urls.REDIS_STREAM_URL);
  provide("REDIS_COLLAB_URL", urls.REDIS_COLLAB_URL);
}

/**
 * Close the pools the migration step opened, then stop both containers.
 * @returns once the containers are stopped.
 */
export async function teardown(): Promise<void> {
  console.log("[integration] Stopping containers...");
  // Importing @breatic/core in setup() created the env-bound singleton pool
  // as a module side effect; close it before tearing down the container.
  const { closeDb, closeYjsDb } = await import("@breatic/core");
  await Promise.allSettled([closeDb(), closeYjsDb()]);
  await Promise.allSettled([
    pgContainer?.stop(),
    redisContainer?.stop(),
  ]);
  console.log("[integration] Containers stopped.");
}
