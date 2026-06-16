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
    pingRedisGeneral: vi.fn(async () => true),
    pingRedisStream: vi.fn(async () => true),
    pingPostgres: vi.fn(async () => true),
    pingYjsPostgres: vi.fn(async () => true),
    isHocuspocusListening: vi.fn(() => true),
    ...overrides,
  };
}

describe("buildCollabHealthChecks", () => {
  it("probes Postgres — collab persists Yjs docs to PG, so healthz MUST cover it", () => {
    const checks = buildCollabHealthChecks(makeProbes());
    expect(checks.map((c) => c.name)).toContain("postgres");
  });

  it("probes redis_general — DB0 holds sessions + drives auth, so a drifted DB0 connection MUST flip healthz red", () => {
    const checks = buildCollabHealthChecks(makeProbes());
    expect(checks.map((c) => c.name)).toContain("redis_general");
  });

  it("probes exactly the five critical dependencies (both Redis DBs + both PG + ws socket)", () => {
    const checks = buildCollabHealthChecks(makeProbes());
    expect(checks.map((c) => c.name).sort()).toEqual([
      "hocuspocus_listening",
      "postgres",
      "postgres_yjs",
      "redis_general",
      "redis_stream",
    ]);
  });

  it("the redis_general check is wired to the pingRedisGeneral probe (DB0 session/auth store)", async () => {
    const probes = makeProbes({ pingRedisGeneral: vi.fn(async () => false) });
    const r = buildCollabHealthChecks(probes).find((c) => c.name === "redis_general")!;
    expect(await r.check()).toBe(false);
    expect(probes.pingRedisGeneral).toHaveBeenCalledOnce();
  });

  it("the postgres_yjs check is wired to the pingYjsPostgres probe (separate yjs DB)", async () => {
    const probes = makeProbes({ pingYjsPostgres: vi.fn(async () => false) });
    const yjs = buildCollabHealthChecks(probes).find((c) => c.name === "postgres_yjs")!;
    expect(await yjs.check()).toBe(false);
    expect(probes.pingYjsPostgres).toHaveBeenCalledOnce();
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
