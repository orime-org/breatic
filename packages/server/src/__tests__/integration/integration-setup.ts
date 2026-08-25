// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Per-worker setup file for integration tests (runs in the forked worker process).
 *
 * Applies the container URLs that globalSetup started into process.env
 * BEFORE any module is imported by test files. This is the only place
 * where it's safe to do so — Vitest's setupFiles run before test file
 * modules are evaluated.
 *
 * @breatic/core no longer reads process.env itself; the application
 * entry injects validated config via initCore(process.env). This setup
 * file only *applies* the env vars (container URLs from inject() + the
 * required fixed vars) — it deliberately does NOT import @breatic/core
 * to call initCore here, so that importing this setup file pulls in no part
 * of the application. Each test that exercises real core calls
 * initCore(process.env) itself (see canvas-native-e2e). Tests
 * that never touch the env Proxy (e.g. v10-schema-invariants, which
 * only uses createTestDb with an explicit URL) need neither.
 */

import { inject, afterAll } from "vitest";

// Declare the shape of values provided by globalSetup.setup() via provide().
// Vitest uses declaration merging on this interface to type inject() calls.
declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
    YJS_DATABASE_URL: string;
    REDIS_URL: string;
    REDIS_QUEUE_URL: string;
    REDIS_STREAM_URL: string;
    REDIS_COLLAB_URL: string;
  }
}

const urls = inject("DATABASE_URL")
  ? {
      DATABASE_URL: inject("DATABASE_URL"),
      YJS_DATABASE_URL: inject("YJS_DATABASE_URL"),
      REDIS_URL: inject("REDIS_URL"),
      REDIS_QUEUE_URL: inject("REDIS_QUEUE_URL"),
      REDIS_STREAM_URL: inject("REDIS_STREAM_URL"),
      REDIS_COLLAB_URL: inject("REDIS_COLLAB_URL"),
    }
  : null;

if (urls) {
  process.env.DATABASE_URL = urls.DATABASE_URL;
  process.env.YJS_DATABASE_URL = urls.YJS_DATABASE_URL;
  process.env.REDIS_URL = urls.REDIS_URL;
  process.env.REDIS_QUEUE_URL = urls.REDIS_QUEUE_URL;
  process.env.REDIS_STREAM_URL = urls.REDIS_STREAM_URL;
  process.env.REDIS_COLLAB_URL = urls.REDIS_COLLAB_URL;
}

// Required env vars that @breatic/core validates at import time.
// ENV must be "dev" | "staging" | "prod" — not "test" (see core/config/env.ts z.enum).
// We use "dev" so that the stream key published by the worker
// (dev:stream:task-events) matches the key the task-listener reads.
process.env.ENV = "dev";
process.env.STORAGE_PROVIDER = "local";
process.env.ALLOWED_ORIGINS = "http://localhost:8000";

// Each test file hands back the connections it opened.
//
// This file is a setupFile, so it is evaluated once per test file, inside
// that file's own module registry. Core's connection singletons — the two
// Postgres pools and the four Redis clients — are therefore built once PER
// FILE, and the suite runs single-fork, so at any moment only one file's
// connections are in use. Without this hook the other ~57 sets just sit
// there: the Postgres pools until `idle_timeout` (30s), the Redis clients
// until the process exits. The whole run takes ~35s, so almost nothing is
// reclaimed on its own.
//
// Measured over a full run, that accumulation was 106 Postgres connections
// and 52 Redis clients. Postgres is the one that broke: its container
// ceiling is 100, so the last files to run could not open a connection at
// all (`FATAL 53300`). Redis has a default `maxclients` of 10000 and never
// hit a wall — it is closed here because a file that is finished should not
// be holding anything, not because anything was failing.
//
// With this hook the peaks are 12 and about 25. The Redis remainder was not
// traced further: those clients belong to things with their own lifecycles
// (BullMQ's own connections, the Hocuspocus Redis extension in the
// cross-instance test), not to the singletons this file opened, and at that
// scale against a 10000 ceiling there is nothing to chase. Closing the four
// Redis singletons costs the run about 2-3 seconds.
//
// Registered here rather than in each test file: `afterAll` from a setupFile
// applies to the file being set up, so one registration covers all of them
// and no test file has to remember.
//
// Every close is a no-op when this file never opened that kind of
// connection, and core is imported lazily inside the hook so that merely
// loading this setup file still pulls in no part of the application (the
// property the header above describes).
afterAll(async () => {
  const core = await import("@breatic/core").catch(() => null);
  if (!core) return;
  await Promise.allSettled([
    core.closeDb(),
    core.closeYjsDb(),
    core.closeRedis(),
    core.closeQueueRedis(),
    core.closeStreamRedis(),
    core.closeCollabRedis(),
    // Nothing in the suite builds queues through core's factories today, so
    // this closes an empty registry. It is here because the list is meant to
    // be "everything core hands out that has to come back" — leaving one out
    // is how the next test to call `createQueue` silently starts leaking.
    core.closeQueues(),
  ]);
});
