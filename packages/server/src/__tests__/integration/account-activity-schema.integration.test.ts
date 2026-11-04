// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import fc from "fast-check";
import { eq } from "drizzle-orm";
import { waitUntilBlockedOn } from "./lock-probe.js";
import * as core from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { seedActivityProject, seedActivityUser } from "./helpers/account-activity-fixture.js";

core.initCore(process.env);

interface Coverage {
  id: string;
  version: number;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
}

interface CoverageRepo {
  openActivityCoverage(version: number, at: Date): Promise<Coverage>;
  closeActivityCoverage(version: number, at: Date): Promise<Coverage>;
}

interface ActivityRepo {
  recordActivity(input: { userId: string; projectId: string | null; kind: string; occurredAt?: Date; visitId?: string }, tx?: DbTx): Promise<unknown>;
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 5, prepare: false });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Assert that the product's actual migrations supplied the new event table.
 * @returns Nothing.
 * @throws {Error} When the database or the migration assertion fails.
 */
async function requireEvents(): Promise<void> {
  const [row] = await sql<{ name: string | null }[]>`SELECT to_regclass('public.account_activity_events')::text AS name`;
  expect(row?.name).toBe("account_activity_events");
}

/**
 * Read the published coverage repository from the built cross-package entry.
 * @returns The coverage repository.
 * @throws {Error} When its product export is absent.
 */
function coverageRepo(): CoverageRepo {
  const repo = (core as unknown as { accountActivityCoverageRepo?: CoverageRepo }).accountActivityCoverageRepo;
  expect(typeof repo?.openActivityCoverage).toBe("function");
  expect(typeof repo?.closeActivityCoverage).toBe("function");
  if (!repo) throw new Error("accountActivityCoverageRepo is absent");
  return repo;
}

describe("account activity database contracts (inner#1893)", () => {
  it("P01 migrates both metadata tables with their required timestamp and identity columns", async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('account_activity_events', 'account_activity_coverage')
    `;
    const events = rows.filter((row) => row.table_name === "account_activity_events").map((row) => row.column_name);
    const coverage = rows.filter((row) => row.table_name === "account_activity_coverage").map((row) => row.column_name);
    expect(events).toEqual(expect.arrayContaining(["id", "user_id", "project_id", "kind", "visit_id", "occurred_at", "created_at"]));
    expect(coverage).toEqual(expect.arrayContaining(["id", "version", "started_at", "ended_at", "created_at"]));
  });

  it("P01 appends all five event kinds and preserves earlier confirmed instants", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    const kinds = ["generation_started", "project_action", "agent_started", "project_access", "project_edit"];
    for (const kind of kinds) {
      await sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
        VALUES (${project.userId}, ${project.projectId}, ${kind}, ${kind === "project_access" ? randomUUID() : null}, '2026-10-01T12:00:00Z')`;
    }
    await sql`INSERT INTO account_activity_events (user_id, project_id, kind, occurred_at)
      VALUES (${project.userId}, ${project.projectId}, 'project_edit', '2026-10-02T12:00:00Z')`;
    const [row] = await sql<{ count: number; original: number }[]>`
      SELECT count(*)::int AS count, count(*) FILTER (WHERE occurred_at = '2026-10-01T12:00:00Z')::int AS original
      FROM account_activity_events WHERE user_id = ${project.userId}
    `;
    expect(row).toEqual({ count: 6, original: 5 });
  });

  it("P01 rejects an unrecognized event kind", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    await expect(sql`INSERT INTO account_activity_events (user_id, project_id, kind, occurred_at)
      VALUES (${project.userId}, ${project.projectId}, 'worker_finished', now())`).rejects.toThrow();
  });

  it.each(["project_access", "project_edit"])("P01 requires a Project for %s", async (kind) => {
    await requireEvents();
    const user = await seedActivityUser(sql);
    await expect(sql`INSERT INTO account_activity_events (user_id, kind, visit_id, occurred_at)
      VALUES (${user.userId}, ${kind}, ${kind === "project_access" ? randomUUID() : null}, now())`).rejects.toMatchObject({ code: "23514" });
  });

  it("P01 requires a visit identity for project_access", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    await expect(sql`INSERT INTO account_activity_events (user_id, project_id, kind, occurred_at)
      VALUES (${project.userId}, ${project.projectId}, 'project_access', now())`).rejects.toMatchObject({ code: "23514" });
  });

  it.each(["generation_started", "project_action", "agent_started", "project_edit"])("P01 keeps visit_id exclusive to access events: %s", async (kind) => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    await expect(sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
      VALUES (${project.userId}, ${project.projectId}, ${kind}, ${randomUUID()}, now())`).rejects.toMatchObject({ code: "23514" });
  });

  it("P01 enforces one original visit per account while allowing another account's same UUID", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    const other = await seedActivityUser(sql);
    const visitId = randomUUID();
    await sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
      VALUES (${project.userId}, ${project.projectId}, 'project_access', ${visitId}, now())`;
    await expect(sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
      VALUES (${project.userId}, ${project.projectId}, 'project_access', ${visitId}, now())`).rejects.toMatchObject({ code: "23505" });
    await sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
      VALUES (${other.userId}, ${project.projectId}, 'project_access', ${visitId}, now())`;
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM account_activity_events WHERE visit_id = ${visitId}`;
    expect(row?.count).toBe(2);
  });

  it("P01 allows repeated non-access events with null visit identities", async () => {
    await requireEvents();
    const account = await seedActivityUser(sql);
    await sql`INSERT INTO account_activity_events (user_id, kind, occurred_at)
      VALUES (${account.userId}, 'agent_started', now()), (${account.userId}, 'agent_started', now())`;
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM account_activity_events WHERE user_id = ${account.userId}`;
    expect(row?.count).toBe(2);
  });

  it("P01 rejects nonexistent account and Project foreign keys", async () => {
    await requireEvents();
    const account = await seedActivityUser(sql);
    await expect(sql`INSERT INTO account_activity_events (user_id, kind, occurred_at)
      VALUES (${randomUUID()}, 'agent_started', now())`).rejects.toMatchObject({ code: "23503" });
    await expect(sql`INSERT INTO account_activity_events (user_id, project_id, kind, occurred_at)
      VALUES (${account.userId}, ${randomUUID()}, 'project_edit', now())`).rejects.toMatchObject({ code: "23503" });
  });

  it("P02 participates in its caller's real DbTx for both rollback and commit", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    const repo = (core as unknown as { accountActivityRepo?: ActivityRepo }).accountActivityRepo;
    expect(typeof repo?.recordActivity).toBe("function");
    if (!repo) throw new Error("accountActivityRepo is absent");
    await expect(core.db.transaction(async (tx) => {
      await tx.update(core.projects).set({ name: "Rolled back activity" }).where(eq(core.projects.id, project.projectId));
      await repo.recordActivity({ userId: project.userId, projectId: project.projectId, kind: "project_edit" }, tx);
      throw new Error("activity transaction fixture rollback");
    })).rejects.toThrow("activity transaction fixture rollback");
    const [rolledBack] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM account_activity_events WHERE user_id = ${project.userId}`;
    expect(rolledBack?.count).toBe(0);
    const [originalProject] = await sql<{ name: string }[]>`SELECT name FROM projects WHERE id=${project.projectId}`;
    expect(originalProject?.name).toBe("Activity Project");
    await core.db.transaction(async (tx) => {
      await tx.update(core.projects).set({ name: "Committed activity" }).where(eq(core.projects.id, project.projectId));
      await repo.recordActivity({ userId: project.userId, projectId: project.projectId, kind: "project_edit" }, tx);
    });
    const rows = await sql<{ user_id: string; project_id: string; kind: string }[]>`
      SELECT user_id, project_id, kind FROM account_activity_events WHERE user_id = ${project.userId}
    `;
    expect(rows).toEqual([{ user_id: project.userId, project_id: project.projectId, kind: "project_edit" }]);
  });

  it("P01 preserves account-scoped uniqueness for arbitrary original visit identities", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    const other = await seedActivityUser(sql);
    await fc.assert(fc.asyncProperty(fc.uuid(), async (visitId) => {
      await sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
        VALUES (${project.userId}, ${project.projectId}, 'project_access', ${visitId}, now()),
               (${other.userId}, ${project.projectId}, 'project_access', ${visitId}, now())`;
      await expect(sql`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
        VALUES (${project.userId}, ${project.projectId}, 'project_access', ${visitId}, now())`).rejects.toMatchObject({ code: "23505" });
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM account_activity_events WHERE visit_id = ${visitId}`;
      expect(count?.count).toBe(2);
    }), { numRuns: 8, seed: 1893 });
  });

  it("P22 starts with no coverage intervals after migrations", async () => {
    const [row] = await sql<{ name: string | null }[]>`SELECT to_regclass('public.account_activity_coverage')::text AS name`;
    expect(row?.name).toBe("account_activity_coverage");
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM account_activity_coverage`;
    expect(rows[0]?.count).toBe(0);
  });

  it("P22 opens, closes and reopens coverage without bridging the closed gap", async () => {
    const repo = coverageRepo();
    const version = 301;
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-10-02T00:00:00Z");
    const restart = new Date("2026-10-03T00:00:00Z");
    const first = await repo.openActivityCoverage(version, start);
    expect(first).toMatchObject({ version, startedAt: start, endedAt: null });
    const closed = await repo.closeActivityCoverage(version, end);
    expect(closed).toMatchObject({ id: first.id, version, startedAt: start, endedAt: end });
    const second = await repo.openActivityCoverage(version, restart);
    expect(second).toMatchObject({ version, startedAt: restart, endedAt: null });
    expect(second.id).not.toBe(first.id);
    const rows = await sql<{ id: string; start: string; end: string | null }[]>`
      SELECT id, started_at::text AS start, ended_at::text AS end
      FROM account_activity_coverage WHERE version = ${version} ORDER BY started_at
    `;
    expect(rows.map((row) => ({ id: row.id, start: new Date(row.start).toISOString(), end: row.end ? new Date(row.end).toISOString() : null }))).toEqual([
      { id: first.id, start: start.toISOString(), end: end.toISOString() },
      { id: second.id, start: restart.toISOString(), end: null },
    ]);
  });

  it("P22 rejects a second open interval in the same version", async () => {
    const repo = coverageRepo();
    const first = await repo.openActivityCoverage(302, new Date("2026-10-01T00:00:00Z"));
    await expect(repo.openActivityCoverage(302, new Date("2026-10-02T00:00:00Z"))).rejects.toThrow();
    const rows = await sql<{ id: string }[]>`SELECT id FROM account_activity_coverage WHERE version = 302 AND ended_at IS NULL`;
    expect(rows.map((row) => row.id)).toEqual([first.id]);
  });

  it.each(["2026-10-01T00:00:00Z", "2026-09-30T23:59:59Z"])("P22 rejects a close instant at or before its start: %s", async (end) => {
    const repo = coverageRepo();
    const version = end.startsWith("2026-10") ? 303 : 304;
    const first = await repo.openActivityCoverage(version, new Date("2026-10-01T00:00:00Z"));
    await expect(repo.closeActivityCoverage(version, new Date(end))).rejects.toThrow();
    const rows = await sql<{ id: string; ended_at: Date | null }[]>`SELECT id, ended_at FROM account_activity_coverage WHERE version = ${version}`;
    expect(rows).toEqual([{ id: first.id, ended_at: null }]);
  });

  it("P22 refuses an open interval overlapping a previously closed interval", async () => {
    const repo = coverageRepo();
    const start = new Date("2026-10-01T00:00:00Z");
    const first = await repo.openActivityCoverage(305, start);
    await repo.closeActivityCoverage(305, new Date("2026-10-02T00:00:00Z"));
    await expect(repo.openActivityCoverage(305, new Date("2026-10-01T12:00:00Z"))).rejects.toThrow();
    const rows = await sql<{ id: string }[]>`SELECT id FROM account_activity_coverage WHERE version=305`;
    expect(rows).toEqual([{ id: first.id }]);
  });

  it("P22 permits independent versions and adjacent same-version intervals", async () => {
    const repo = coverageRepo();
    const start = new Date("2026-10-01T00:00:00Z");
    const boundary = new Date("2026-10-02T00:00:00Z");
    await repo.openActivityCoverage(306, start);
    await repo.closeActivityCoverage(306, boundary);
    await expect(repo.openActivityCoverage(306, boundary)).resolves.toMatchObject({ version: 306, startedAt: boundary });
    await expect(repo.openActivityCoverage(307, start)).resolves.toMatchObject({ version: 307, startedAt: start });
  });

  it("P22 enforces concurrent open exclusion in real PG even outside the repository", async () => {
    const [table] = await sql<{ name: string | null }[]>`SELECT to_regclass('public.account_activity_coverage')::text AS name`;
    expect(table?.name).toBe("account_activity_coverage");
    let release = (): void => {};
    let inserted = (): void => {};
    let failed = (_error: unknown): void => {};
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const ready = new Promise<void>((resolveReady, rejectReady) => { inserted = resolveReady; failed = rejectReady; });
    const holder = sql.begin(async (tx) => {
      await tx`INSERT INTO account_activity_coverage(version,started_at) VALUES(308,'2026-10-01T00:00:00Z')`;
      inserted();
      await gate;
    });
    void holder.catch(failed);
    await ready;
    // `execute()` begins both real statements; the lock probe proves the overlap.
    const requests = [1, 2].map(() => sql`INSERT INTO account_activity_coverage(version,started_at) VALUES(308,'2026-10-02T00:00:00Z')`.execute());
    // Attach rejection handlers before releasing the winning transaction.
    const outcomes = Promise.allSettled(requests);
    try { await waitUntilBlockedOn(sql, ["account_activity_coverage", "insert"], 2); }
    finally { release(); await holder; }
    const results = await outcomes;
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const rows = await sql`SELECT id FROM account_activity_coverage WHERE version=308 AND ended_at IS NULL`;
    expect(rows).toHaveLength(1);
  });

  it("P23 keeps a trusted offset timestamp as its original UTC instant", async () => {
    await requireEvents();
    const project = await seedActivityProject(sql);
    const repo = (core as unknown as { accountActivityRepo?: ActivityRepo }).accountActivityRepo;
    expect(typeof repo?.recordActivity).toBe("function");
    if (!repo) throw new Error("accountActivityRepo is absent");
    const at = new Date("2026-11-01T00:00:00.123+08:00");
    await repo.recordActivity({ userId: project.userId, projectId: project.projectId, kind: "project_edit", occurredAt: at });
    const [row] = await sql<{ at: string }[]>`SELECT occurred_at::text AS at FROM account_activity_events WHERE user_id=${project.userId}`;
    expect(new Date(row!.at).toISOString()).toBe("2026-10-31T16:00:00.123Z");
  });

});
