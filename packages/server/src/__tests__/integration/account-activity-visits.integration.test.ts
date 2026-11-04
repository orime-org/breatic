// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import type { Hono } from "hono";
import { initCore, initLogger, loadLocales, logger } from "@breatic/core";
import { projectVisitOpenedSchema, projectVisitLookupSchema } from "@breatic/shared";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { activityRows, rejectActivityWrites, seedActivityProject, seedActivityUser } from "./helpers/account-activity-fixture.js";
import type { ActivityProject } from "./helpers/account-activity-fixture.js";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: () => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

initCore(process.env);
loadLocales();
initLogger("activity-visits-test", { logsRoot: resolve(tmpdir(), "breatic-test-logs"), debug: false, console: "none" });

interface Receipt {
  ok: true;
  account_id: string;
  project_id: string;
  visit_id: string;
  occurred_at: string;
}

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Submit a real authenticated opened request.
 * @param project - The requesting account and Project.
 * @param visitId - Stable identity, or omitted for the published legacy caller.
 * @returns The actual Hono response.
 * @throws {Error} When the app request cannot run.
 */
async function postOpen(project: ActivityProject, visitId?: string): Promise<Response> {
  return app.request(`/api/v1/projects/${project.projectId}/opened`, {
    method: "POST",
    headers: { Cookie: project.cookie, ...(visitId ? { "Content-Type": "application/json" } : {}) },
    ...(visitId ? { body: JSON.stringify({ visit_id: visitId }) } : {}),
  });
}

/**
 * Read the exact timestamp that determines the account's recent ordering.
 * @param project - The account and Project.
 * @returns Full precision database timestamp text, or null.
 * @throws {Error} When the database read fails.
 */
async function recentAt(project: ActivityProject): Promise<string | null> {
  const [row] = await sql<{ at: string }[]>`
    SELECT last_opened_at::text AS at FROM project_last_opened
    WHERE user_id = ${project.userId} AND project_id = ${project.projectId}
  `;
  return row?.at ?? null;
}

describe("account activity visit receipts (inner#1893)", () => {
  it("P03 returns the server-confirmed receipt and appends one authenticated access", async () => {
    const project = await seedActivityProject(sql);
    const visitId = randomUUID();
    const before = Date.now();
    const response = await postOpen(project, visitId);
    const after = Date.now();
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: Receipt };
    expect(projectVisitOpenedSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({ ok: true, account_id: project.userId, project_id: project.projectId, visit_id: visitId });
    expect(Number.isFinite(Date.parse(data.occurred_at))).toBe(true);
    expect(Date.parse(data.occurred_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(data.occurred_at)).toBeLessThanOrEqual(after);
    const rows = await activityRows(sql, project.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: project.userId, project_id: project.projectId, visit_id: visitId, kind: "project_access" });
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe(new Date(data.occurred_at).toISOString());
  });

  it("P03 admits a viewer and derives the actor from that viewer's session", async () => {
    const project = await seedActivityProject(sql);
    const viewer = await seedActivityUser(sql);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${project.studioId}, ${viewer.userId}, 'guest')`;
    await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${project.projectId}, ${viewer.userId}, 'viewer')`;
    const response = await postOpen({ ...project, ...viewer }, randomUUID());
    expect(response.status).toBe(200);
    expect((await response.json() as { data: Receipt }).data.account_id).toBe(viewer.userId);
    expect((await activityRows(sql, viewer.userId)).map((row) => row.kind)).toEqual(["project_access"]);
    expect(await activityRows(sql, project.userId)).toEqual([]);
  });

  it("P03 keeps the unauthenticated boundary at 401", async () => {
    const project = await seedActivityProject(sql);
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(await recentAt(project)).toBe(null);
  });

  it("P03 refuses an inaccessible Project with 404 and leaves its recent ordering alone", async () => {
    const project = await seedActivityProject(sql);
    const stranger = await seedActivityUser(sql);
    const response = await postOpen({ ...project, ...stranger }, randomUUID());
    expect(response.status).toBe(404);
    expect(await recentAt({ ...project, ...stranger })).toBe(null);
  });

  it.each(["not-a-uuid", "00000000-0000-0000-0000-000000000000"])("P03 refuses unavailable Project %s", async (projectId) => {
    const project = await seedActivityProject(sql);
    const response = await postOpen({ ...project, projectId }, randomUUID());
    expect(response.status).toBe(404);
  });

  it("P04 preserves the original event and recent timestamp when its visit is replayed", async () => {
    const project = await seedActivityProject(sql);
    const visitId = randomUUID();
    expect((await postOpen(project, visitId)).status).toBe(200);
    await sql`UPDATE account_activity_events SET occurred_at = '2026-10-31T15:59:59.123456Z' WHERE user_id = ${project.userId}`;
    await sql`UPDATE project_last_opened SET last_opened_at = '2026-10-31T15:59:59.123456Z' WHERE user_id = ${project.userId}`;
    const priorRows = await activityRows(sql, project.userId);
    const priorRecent = await recentAt(project);
    const response = await postOpen(project, visitId);
    expect(response.status).toBe(200);
    const receipt = (await response.json() as { data: Receipt }).data;
    expect(receipt.visit_id).toBe(visitId);
    expect(receipt.occurred_at).toMatch(/\.123456(?:Z|\+00(?::00)?)$/);
    expect(await activityRows(sql, project.userId)).toEqual(priorRows);
    expect(await recentAt(project)).toBe(priorRecent);
  });

  it("P04 records a genuinely new visit separately", async () => {
    const project = await seedActivityProject(sql);
    const visits = [randomUUID(), randomUUID()];
    for (const visit of visits) expect((await postOpen(project, visit)).status).toBe(200);
    expect((await activityRows(sql, project.userId)).map((row) => row.visit_id).sort()).toEqual(visits.sort());
  });

  it("P06 rejects a confirmed visit reused for another Project with 422", async () => {
    const first = await seedActivityProject(sql);
    const second = await seedActivityProject(sql);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${second.studioId}, ${first.userId}, 'guest')`;
    await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${second.projectId}, ${first.userId}, 'viewer')`;
    const visitId = randomUUID();
    expect((await postOpen(first, visitId)).status).toBe(200);
    const response = await postOpen({ ...second, userId: first.userId, cookie: first.cookie }, visitId);
    expect(response.status).toBe(422);
    expect((await activityRows(sql, first.userId)).map((row) => row.project_id)).toEqual([first.projectId]);
    expect(await recentAt({ ...second, userId: first.userId })).toBe(null);
  });

  it("P07 returns unconfirmed for the caller's unknown original identity", async () => {
    const project = await seedActivityProject(sql);
    const visitId = randomUUID();
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened/${visitId}`, { headers: { Cookie: project.cookie } });
    expect(response.status).toBe(200);
    const data = (await response.json() as { data: unknown }).data;
    expect(projectVisitLookupSchema.safeParse(data).success).toBe(true);
    expect(data).toEqual({ status: "unconfirmed", account_id: project.userId, project_id: project.projectId, visit_id: visitId });
    expect(await recentAt(project)).toBe(null);
  });

  it("P07 looks up the original recorded receipt without appending another event", async () => {
    const project = await seedActivityProject(sql);
    const visitId = randomUUID();
    const original = (await (await postOpen(project, visitId)).json() as { data: Receipt }).data;
    const before = await activityRows(sql, project.userId);
    const at = await recentAt(project);
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened/${visitId}`, { headers: { Cookie: project.cookie } });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown }).data).toMatchObject({ status: "recorded", account_id: project.userId, project_id: project.projectId, visit_id: visitId, occurred_at: original.occurred_at });
    expect(await activityRows(sql, project.userId)).toEqual(before);
    expect(await recentAt(project)).toBe(at);
  });

  it("P07 keeps another account's receipt private", async () => {
    const project = await seedActivityProject(sql);
    const other = await seedActivityUser(sql);
    const visitId = randomUUID();
    expect((await postOpen(project, visitId)).status).toBe(200);
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened/${visitId}`, { headers: { Cookie: other.cookie } });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown }).data).toEqual({ status: "unconfirmed", account_id: other.userId, project_id: project.projectId, visit_id: visitId });
  });

  it("P07 lets an account read its own minimal historical receipt after membership ends", async () => {
    const project = await seedActivityProject(sql);
    const member = await seedActivityUser(sql);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${project.studioId}, ${member.userId}, 'guest')`;
    await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${project.projectId}, ${member.userId}, 'viewer')`;
    const visitId = randomUUID();
    expect((await postOpen({ ...project, ...member }, visitId)).status).toBe(200);
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${project.projectId} AND user_id = ${member.userId}`;
    await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ${project.studioId} AND user_id = ${member.userId}`;
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened/${visitId}`, { headers: { Cookie: member.cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ status: "recorded", account_id: member.userId, project_id: project.projectId, visit_id: visitId });
    expect(Object.keys(body.data).sort()).toEqual(["account_id", "occurred_at", "project_id", "status", "visit_id"]);
  });

  it("P08 supports the published empty-body opened request", async () => {
    const project = await seedActivityProject(sql);
    const response = await postOpen(project);
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: Receipt };
    expect(projectVisitOpenedSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({ ok: true, account_id: project.userId, project_id: project.projectId });
    expect(data.visit_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await activityRows(sql, project.userId)).map((row) => row.visit_id)).toEqual([data.visit_id]);
  });

  it("P09 leaves access history unchanged during passive GET refreshes", async () => {
    const project = await seedActivityProject(sql);
    expect((await postOpen(project, randomUUID())).status).toBe(200);
    const before = await activityRows(sql, project.userId);
    for (let i = 0; i < 3; i += 1) {
      const response = await app.request(`/api/v1/projects/${project.projectId}`, { headers: { Cookie: project.cookie } });
      expect(response.status).toBe(200);
    }
    expect(await activityRows(sql, project.userId)).toEqual(before);
  });

  it("P05 rolls back both activity and recent writes when activity append fails", async () => {
    const project = await seedActivityProject(sql);
    const restore = await rejectActivityWrites(sql, project.userId);
    const errors = vi.spyOn(logger, "error");
    try {
      const response = await postOpen(project, randomUUID());
      expect(response.status).toBe(500);
      expect(await recentAt(project)).toBe(null);
      expect(await activityRows(sql, project.userId)).toEqual([]);
      expect(errors.mock.calls.some(([fields]) => (fields as { err?: Error }).err?.message.includes("activity fixture append rejected"))).toBe(true);
    } finally {
      errors.mockRestore();
      await restore();
    }
  });

  it("P05 observes two concurrent visit claims waiting on the same unique key", async () => {
    const project = await seedActivityProject(sql);
    const visitId = randomUUID();
    let release = (): void => {};
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let inserted = (): void => {};
    let failed = (_error: unknown): void => {};
    const ready = new Promise<void>((resolveReady, rejectReady) => { inserted = resolveReady; failed = rejectReady; });
    const holder = sql.begin(async (tx) => {
      await tx`INSERT INTO account_activity_events (user_id, project_id, kind, visit_id, occurred_at)
        VALUES (${project.userId}, ${project.projectId}, 'project_access', ${visitId}, '2026-10-31T12:00:00Z')`;
      inserted();
      await gate;
    });
    void holder.catch(failed);
    await ready;
    const first = postOpen(project, visitId);
    const second = postOpen(project, visitId);
    try {
      await waitUntilBlockedOn(sql, ["account_activity_events", "insert"], 2);
    } finally {
      release();
      await holder;
    }
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(responses.map((response) => response.json() as Promise<{ data: Receipt }>));
    expect(receipts[0]!.data).toEqual(receipts[1]!.data);
    expect((await activityRows(sql, project.userId)).map((row) => row.visit_id)).toEqual([visitId]);
    expect(await recentAt(project)).toBe(null);
  });

  it("P07 returns unconfirmed for the same account's wrong Project identity", async () => {
    const project = await seedActivityProject(sql);
    const other = await seedActivityProject(sql);
    const visitId = randomUUID();
    expect((await postOpen(project, visitId)).status).toBe(200);
    const response = await app.request(`/api/v1/projects/${other.projectId}/opened/${visitId}`, { headers: { Cookie: project.cookie } });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ status: "unconfirmed", account_id: project.userId, project_id: other.projectId, visit_id: visitId });
  });

  it("P07 requires a real session when looking up a historical receipt", async () => {
    const project = await seedActivityProject(sql);
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened/${randomUUID()}`);
    expect(response.status).toBe(401);
  });

  it("P03 rejects malformed visit identities before recording or sorting", async () => {
    const project = await seedActivityProject(sql);
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened`, {
      method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ visit_id: "not-a-uuid" }),
    });
    expect(response.status).toBe(422);
    expect(await recentAt(project)).toBe(null);
    expect(await activityRows(sql, project.userId)).toEqual([]);
  });

  it("P23 ignores a browser-supplied confirmation time", async () => {
    const project = await seedActivityProject(sql);
    const before = Date.now();
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened`, {
      method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ visit_id: randomUUID(), occurred_at: "2000-01-01T00:00:00-12:00", account_id: randomUUID() }),
    });
    expect(response.status).toBe(200);
    const receipt = (await response.json() as { data: Receipt }).data;
    expect(receipt.account_id).toBe(project.userId);
    expect(Date.parse(receipt.occurred_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(receipt.occurred_at)).toBeLessThanOrEqual(Date.now());
  });

  for (const outcome of ["commit", "rollback", "mismatch"] as const) {
    it(`P05/P06 observes competing first claims through the winner's recent ${outcome}`, async () => {
      const project = await seedActivityProject(sql);
      // A missing production migration is not evidence of a concurrency failure.
      expect(await activityRows(sql, project.userId)).toEqual([]);
      const secondProject = outcome === "mismatch" ? await seedActivityProject(sql) : project;
      if (outcome === "mismatch") {
        await sql`INSERT INTO studio_members(studio_id,user_id,role) VALUES(${secondProject.studioId},${project.userId},'guest')`;
        await sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${secondProject.projectId},${project.userId},'viewer')`;
      }
      const tag = randomUUID().replaceAll("-", "");
      const fn = `visit_gate_${tag}`;
      const sequence = `visit_sequence_${tag}`;
      const lockKey = Math.floor(Math.random() * 1_000_000_000);
      await sql.unsafe(`CREATE SEQUENCE ${sequence}`);
      await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE nth bigint; BEGIN
        IF NEW.user_id='${project.userId}'::uuid THEN
          nth := nextval('${sequence}');
          IF nth=1 THEN PERFORM pg_advisory_xact_lock(1893,${lockKey});
            ${outcome === "rollback" ? "RAISE EXCEPTION 'recent fixture rejects winner';" : ""}
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
      await sql.unsafe(`CREATE TRIGGER ${fn}_t BEFORE INSERT ON project_last_opened FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      let release = (): void => {};
      let acquired = (): void => {};
      let failed = (_error: unknown): void => {};
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      const ready = new Promise<void>((resolveReady, rejectReady) => { acquired = resolveReady; failed = rejectReady; });
      const holder = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(1893,${lockKey})`;
        acquired();
        await gate;
      });
      void holder.catch(failed);
      const visitId = randomUUID();
      let first: Promise<Response> | undefined;
      let second: Promise<Response> | undefined;
      try {
        await ready;
        first = postOpen(project, visitId);
        await waitUntilBlockedOn(sql, ["project_last_opened", "insert"], 1);
        second = postOpen({ ...secondProject, userId: project.userId, cookie: project.cookie }, visitId);
        await waitUntilBlockedOn(sql, ["account_activity_events", "insert"], 1);
        release();
        await holder;
        const responses = await Promise.all([first, second]);
        expect(responses.map((response) => response.status)).toEqual(outcome === "rollback" ? [500, 200] : outcome === "mismatch" ? [200, 422] : [200, 200]);
        const rows = await activityRows(sql, project.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ project_id: project.projectId, visit_id: visitId });
        const confirmed = (await responses[outcome === "rollback" ? 1 : 0].json() as { data: Receipt }).data;
        expect(new Date((await recentAt(project))!).toISOString()).toBe(new Date(confirmed.occurred_at).toISOString());
        if (outcome === "commit") expect((await responses[1].json() as { data: Receipt }).data).toEqual(confirmed);
        if (outcome === "mismatch") expect(await recentAt({ ...secondProject, userId: project.userId })).toBe(null);
      } finally {
        release();
        await holder;
        await Promise.allSettled([first, second].filter((request): request is Promise<Response> => request !== undefined));
        await sql.unsafe(`DROP TRIGGER ${fn}_t ON project_last_opened`);
        await sql.unsafe(`DROP FUNCTION ${fn}()`);
        await sql.unsafe(`DROP SEQUENCE ${sequence}`);
      }
    });
  }

});
