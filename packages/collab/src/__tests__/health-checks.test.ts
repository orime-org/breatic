// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * collab `/healthz` check-wiring tests.
 *
 * Guards the dependency probe list against two regression classes:
 *
 *   1. A critical dependency silently dropped from the probe set — the
 *      bug this PR fixes: collab persists every Yjs document to
 *      Postgres yet the original healthz only probed Redis + the WS
 *      listen socket, so a dead Postgres reported "ok".
 *   2. A probe wired to the wrong source — the PR #155/#156 failure
 *      where `hocuspocus_listening` read the wrong field and always
 *      returned false, 503-ing healthz forever.
 *
 * Probes are passed in as thunks, so these run with zero real
 * Postgres / Redis / Hocuspocus.
 */

import { describe, it, expect, vi } from "vitest";
import { buildCollabHealthChecks, type CollabHealthProbes } from "@collab/infra/health-checks.js";

function makeProbes(overrides: Partial<CollabHealthProbes> = {}): CollabHealthProbes {
  return {
    pingRedisStream: vi.fn(async () => true),
    pingPostgres: vi.fn(async () => true),
    isHocuspocusListening: vi.fn(() => true),
    ...overrides,
  };
}

describe("buildCollabHealthChecks", () => {
  it("probes Postgres — collab persists Yjs docs to PG, so healthz MUST cover it", () => {
    const checks = buildCollabHealthChecks(makeProbes());
    expect(checks.map((c) => c.name)).toContain("postgres");
  });

  it("probes exactly the three critical dependencies (redis stream + postgres + ws socket)", () => {
    const checks = buildCollabHealthChecks(makeProbes());
    expect(checks.map((c) => c.name).sort()).toEqual([
      "hocuspocus_listening",
      "postgres",
      "redis_stream",
    ]);
  });

  it("the postgres check is wired to the pingPostgres probe (reports its result)", async () => {
    const probes = makeProbes({ pingPostgres: vi.fn(async () => false) });
    const pg = buildCollabHealthChecks(probes).find((c) => c.name === "postgres")!;
    expect(await pg.check()).toBe(false);
    expect(probes.pingPostgres).toHaveBeenCalledOnce();
  });

  it("the hocuspocus check reflects the live listen socket (PR #155/#156 mis-wire guard)", async () => {
    const probes = makeProbes({ isHocuspocusListening: vi.fn(() => false) });
    const ws = buildCollabHealthChecks(probes).find((c) => c.name === "hocuspocus_listening")!;
    expect(await ws.check()).toBe(false);
  });
});
