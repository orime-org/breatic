// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Vitest globalSetup for every package's integration suite.
 *
 * Starts PostgreSQL + Redis testcontainers BEFORE any test worker is forked,
 * migrates both databases, and forwards the addresses to the workers through
 * Vitest's provide() API; `env.ts` re-applies them to process.env there.
 *
 * It also creates collab's two logins (inner#2043), both holding the role
 * `collab_writer`: `breatic_collab_test`, which only the code paths collab
 * runs normally use, and `breatic_collab_probe`, for tests that write out of
 * scope on purpose. PostgreSQL logs each line with its user, and teardown
 * fails the run when any line from `breatic_collab_test` was refused for
 * lack of a privilege, so a refusal collab's code caught and logged still
 * fails CI.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, getContainerRuntimeClient, type StartedTestContainer } from "testcontainers";

/** The login collab's own code connects as in the integration suites. */
const COLLAB_TEST_LOGIN = "breatic_collab_test";
/** The login for tests that write outside collab's scope on purpose. */
const COLLAB_PROBE_LOGIN = "breatic_collab_probe";

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
      // Each log line names its user, so teardown can find collab's refusals.
      .withCommand(["postgres", "-c", "log_line_prefix=%m [%p] %u "])
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
    // Space count lock, the connection registry). A test that runs two collab
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
  // until DATABASE_URL etc. point at the freshly-started container. The
  // migrations run through core's own functions, so this file needs no
  // database driver of its own.
  console.log("[integration] Running migrations...");
  const { migrateDatabase, migrateYjsDatabase, createTestDb, ensureCollabLogin } = await import(
    "@breatic/core"
  );
  await migrateDatabase(pgUrl);
  const collabUrl = loginUrl(pgUrl, COLLAB_TEST_LOGIN);
  const collabProbeUrl = loginUrl(pgUrl, COLLAB_PROBE_LOGIN);
  await ensureCollabLogin(pgUrl, collabUrl);
  await ensureCollabLogin(pgUrl, collabProbeUrl);

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
  provide("COLLAB_DATABASE_URL", collabUrl);
  provide("COLLAB_PROBE_DATABASE_URL", collabProbeUrl);
}

/**
 * The admin URL with another login's name, its password the same as the name.
 * @param adminUrl - The container's admin URL.
 * @param login - The login.
 * @returns The login's URL.
 */
function loginUrl(adminUrl: string, login: string): string {
  const url = new URL(adminUrl);
  url.username = login;
  url.password = login;
  return url.toString();
}

/**
 * Read the stopped PostgreSQL container's whole log and pick out the lines
 * where collab's own login was refused a privilege.
 * @param container - The stopped container; its log stream ends because it is stopped.
 * @returns The offending lines.
 */
async function collabRefusals(container: StartedPostgreSqlContainer): Promise<string[]> {
  const stream = await container.logs();
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text.split("\n").filter((line) => line.includes(` ${COLLAB_TEST_LOGIN} `) && line.includes("permission denied"));
}

/**
 * Close the pools the migration step opened, stop both containers, and fail
 * the run when PostgreSQL refused collab's own login anything.
 * @returns once the containers are stopped and removed.
 * @throws {Error} When the PostgreSQL log holds a refusal for `breatic_collab_test`.
 */
export async function teardown(): Promise<void> {
  console.log("[integration] Stopping containers...");
  // Importing @breatic/core in setup() created the env-bound singleton pool
  // as a module side effect; close it before tearing down the container.
  const { closeDb, closeYjsDb } = await import("@breatic/core");
  await Promise.allSettled([closeDb(), closeYjsDb()]);
  let refusals: string[] = [];
  /**
   * Stop PostgreSQL, read its log, then remove it.
   * @returns once it is removed.
   */
  const stopPostgres = async (): Promise<void> => {
    if (!pgContainer) return;
    // Kept until its log is read: `logs()` follows, so on a running container it never ends.
    const stopped = await pgContainer.stop({ remove: false });
    try {
      refusals = await collabRefusals(pgContainer);
    } finally {
      const client = await getContainerRuntimeClient();
      await client.container.remove(client.container.getById(stopped.getId()), { removeVolumes: true });
    }
  };
  const results = await Promise.allSettled([stopPostgres(), redisContainer?.stop()]);
  console.log("[integration] Containers stopped.");
  for (const result of results) {
    if (result.status === "rejected") console.error("[integration] Container teardown failed:", result.reason);
  }
  if (refusals.length > 0) {
    throw new Error(
      `PostgreSQL refused ${COLLAB_TEST_LOGIN} ${refusals.length} time(s); collab wrote outside its scope:\n${refusals.join("\n")}`,
    );
  }
}
