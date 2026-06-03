// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fail-fast connectivity check for infrastructure dependencies.
 *
 * Called at service startup (server / worker / collab) before any
 * business logic. Per CLAUDE.md "process lifecycle" mandate, library
 * code doesn't decide when the process dies: if a dependency probe
 * fails this throws `InfraNotReadyError` and the application entry's
 * top-level catch logs the context + exits.
 *
 * Singleton-style + caller-declared: each service passes the Redis
 * clients it actually depends on (server / worker: general + queue +
 * stream; collab: general + stream), keyed by name, so boot probes
 * exactly the dependencies that service uses — no more, no less.
 * PostgreSQL is the shared `db` singleton via `pingDb()`. Every probe
 * is bounded by {@link BOOT_PROBE_TIMEOUT_MS} so a down dependency
 * fails fast at boot instead of hanging on the client's retry budget.
 */

import type { Redis } from "ioredis";
import { pingDb, yjsRawPg } from "@core/db/client.js";
import { pingRedis } from "@core/infra/redis.js";
import { env } from "@core/config/env.js";
import { InfraNotReadyError } from "@core/infra/errors.js";

/**
 * Per-probe boot timeout. Short enough that a down dependency fails the
 * fail-fast boot check in seconds rather than hanging on a client's
 * production retry budget; long enough to tolerate a briefly slow (but
 * reachable) dependency on a cold start.
 */
const BOOT_PROBE_TIMEOUT_MS = 5000;

/**
 * Race a boot probe against {@link BOOT_PROBE_TIMEOUT_MS} so a stuck
 * dependency can't hang process startup.
 * @param probe - The probe promise (one PG or Redis liveness check)
 * @param label - Dependency label used in the timeout error message
 * @returns The probe's result if it settles before the timeout
 * @throws {Error} When the probe does not settle within the timeout
 */
async function withBootTimeout<T>(probe: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} probe timed out after ${BOOT_PROBE_TIMEOUT_MS}ms`)),
      BOOT_PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Verify PostgreSQL and every Redis dependency this service uses are
 * reachable, failing fast at boot.
 * @param redisClients - The Redis singletons this service depends on,
 *   keyed by role name (e.g. server / worker pass
 *   `{ general, queue, stream }`; collab passes `{ general, stream }`).
 *   Each is PING-probed; the key tags the error so a failure points at
 *   the right `REDIS_*_URL`.
 * @throws {InfraNotReadyError} If PostgreSQL or any passed Redis client
 *   is unreachable. The application entry catches, logs
 *   `{ component, hint, cause }`, and calls `process.exit(1)`.
 */
export async function checkInfraReady(
  redisClients: Record<string, Redis>,
): Promise<void> {
  // PostgreSQL: SELECT 1 round-trip on the shared `db` singleton (the
  // same probe `/healthz` uses), so every service checks the exact
  // pool it will serve traffic with.
  try {
    if (!(await withBootTimeout(pingDb(), "PostgreSQL"))) {
      throw new Error("PostgreSQL SELECT 1 returned an unexpected result");
    }
  } catch (err) {
    throw new InfraNotReadyError(
      "PostgreSQL",
      `Check DATABASE_URL=${env.DATABASE_URL} or run: docker compose up -d postgres`,
      err,
    );
  }

  // yjs PostgreSQL: the separate Yjs binary-store DB. Probed with its
  // own pool so a down / missing yjs DB fails boot fast (every backend
  // service touches it — server/worker via lifecycle ops, collab via
  // persistence).
  try {
    if (!(await withBootTimeout(pingDb(yjsRawPg), "yjs PostgreSQL"))) {
      throw new Error("yjs PostgreSQL SELECT 1 returned an unexpected result");
    }
  } catch (err) {
    throw new InfraNotReadyError(
      "yjs PostgreSQL",
      `Check YJS_DATABASE_URL=${env.YJS_DATABASE_URL} or run: docker compose up -d postgres`,
      err,
    );
  }

  // Redis: PING each client this service depends on. The clients are
  // the per-process singletons (general / queue / stream); the key
  // names which `REDIS_*_URL` to check on failure.
  for (const [name, client] of Object.entries(redisClients)) {
    try {
      if (!(await withBootTimeout(pingRedis(client), `Redis (${name})`))) {
        throw new Error("unexpected PING response");
      }
    } catch (err) {
      throw new InfraNotReadyError(
        `Redis (${name})`,
        `Check the ${name} Redis URL (REDIS_URL / REDIS_QUEUE_URL / REDIS_STREAM_URL) or run: docker compose up -d redis`,
        err,
      );
    }
  }
}
