// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Builds the collab service's `/healthz` dependency probes.
 *
 * Extracted from `index.ts` so the wiring is unit-testable. A
 * mis-wired probe is a real, shipped failure mode here: PR #155/#156
 * read the wrong "listening" field and produced a healthz that always
 * returned 503, which - combined with the docker `healthcheck:` - would
 * have had production collab containers marked unhealthy and restarted
 * in a loop. Probe wiring this load-bearing must be covered by a test.
 *
 * The builder takes opaque probe thunks instead of live clients so a
 * test can drive each dependency's reachability without standing up
 * real Postgres / Redis / Hocuspocus.
 *
 * **Postgres is a critical dependency and MUST be probed.** collab
 * persists every Yjs document to Postgres (see `persistence.ts`) and
 * authenticates against it (`auth.ts`); a healthz that omits Postgres
 * reports "ok" while document load/store is dead - the worst possible
 * state for a load balancer to see. This is required by the CLAUDE.md
 * "industrial-grade server standards" mandate (healthz must ping PG + Redis + queue).
 */

import type { HealthCheck } from "@breatic/core";

/** Reachability probes for each of collab's critical dependencies. */
export interface CollabHealthProbes {
  /** Resolves true when the members-sync control Redis answers PING. */
  pingRedisStream: () => Promise<boolean>;
  /** Resolves true when Postgres answers a trivial round-trip query. */
  pingPostgres: () => Promise<boolean>;
  /** Resolves true when the separate yjs-store Postgres answers a round-trip. */
  pingYjsPostgres: () => Promise<boolean>;
  /** True while the Hocuspocus WS http server's listen socket is open. */
  isHocuspocusListening: () => boolean;
}

/**
 * Assemble the `/healthz` check list for the collab service.
 * @param probes - Per-dependency reachability thunks
 * @returns The check array to hand to {@link startHealthServer}
 */
export function buildCollabHealthChecks(probes: CollabHealthProbes): HealthCheck[] {
  return [
    { name: "redis_stream", check: probes.pingRedisStream },
    { name: "postgres", check: probes.pingPostgres },
    { name: "postgres_yjs", check: probes.pingYjsPostgres },
    { name: "hocuspocus_listening", check: async () => probes.isHocuspocusListening() },
  ];
}
