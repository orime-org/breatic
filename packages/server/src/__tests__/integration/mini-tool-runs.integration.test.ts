// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getRedis, initCore, initLogger, loadLocales, logger, revokeSession, sessionCookieName, setSession } from "@breatic/core";
import type { MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import { executionSnapshot, seedExecution, storeExecutionFixture, type ExecutionFixture } from "../../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";

let pg: ReturnType<typeof createPgClient>;
let app: Hono;
const tokens: string[] = [];
beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false" }); loadLocales(); initLogger("planned-get-fixture");
  pg = createPgClient(inject("DATABASE_URL"), { name: "planned-get-fixtures", max: 4 });
  const { createApp } = await import("@server/app.js"); app = createApp();
});
afterAll(async () => { for (const token of tokens) await revokeSession(getRedis(), token); await pg.end(); initCore(process.env); });

/** Create a real authenticated Redis session for this fixture user.
 * @throws {Error} On a session-store failure.
 */
async function cookie(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex"); await setSession(getRedis(), token, userId); tokens.push(token); return `${sessionCookieName()}=${token}`;
}
/** Exercise the production Hono HTTP route with current auth; no domain read or role answer is mocked.
 * @throws {Error} On a test-client failure.
 */
async function get(f: ExecutionFixture, userId: string | null = f.viewerId, projectId = f.projectId, runId = f.taskId): Promise<Response> {
  return app.request(`/api/v1/projects/${projectId}/mini-tool-runs/${runId}`, { headers: userId === null ? {} : { Cookie: await cookie(userId) } });
}
/** Seed an independently specified terminal tasks-only read model, not a provider or storage result.
 * @throws {Error} On a fixture SQL failure.
 */
async function terminal(f: ExecutionFixture, status: "completed" | "failed" = "completed"): Promise<MiniToolExecutionRecord> {
  const record: MiniToolExecutionRecord = { ...f.record, status, resultVersion: status === "failed" ? 2 : 1,
    error: status === "failed" ? { code: "original_registration_failure" } : null,
    outputs: [{ ...f.plan.outputs[0]!, result: status === "failed" ? { status: "failed", error: { code: "original_registration_failure" } } : f.registered }], billingState: "waiting",
    usage: [{ consumptionKey: "c".repeat(64), state: "pending", chargeTo: "user", costUsd: null, credits: null }] };
  await pg`UPDATE tasks SET status=${status},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
  await storeExecutionFixture(pg, f, record);
  await pg`UPDATE tasks SET result=result || ${pg.json({ settlement: { version: 1, state: "waiting", pendingConsumptionKeys: ["c".repeat(64)], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: false } })} WHERE id=${f.taskId}`;
  return record;
}

describe("GET project-scoped planned executions (independent Q/B oracle)", () => {
  it("Q01 permits a current real viewer who is not the task actor", async () => {
    const f = await seedExecution(pg); const before = await executionSnapshot(pg, f); const response = await get(f);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: f.record }); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["owner", "editor"] as const)("Q02 permits archived-project %s through the current read role", async (role) => {
    const f = await seedExecution(pg); await pg`UPDATE project_members SET role=${role} WHERE project_id=${f.projectId} AND user_id=${f.userId}`;
    await pg`UPDATE projects SET archived_at=clock_timestamp(),archived_by_user_id=${f.userId} WHERE id=${f.projectId}`;
    const response = await get(f, f.userId); expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: f.record });
  });
  it("Q03 returns the original protected-route 401 without auth", async () => {
    const f = await seedExecution(pg); const before = await executionSnapshot(pg, f); expect((await get(f, null)).status).toBe(401); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["missing run", "deleted task", "wrong project", "nonmember", "left project", "deleted project"])("Q04 hides %s as the same resource boundary", async (bad) => {
    const f = await seedExecution(pg); let projectId = f.projectId; let runId = f.taskId; let userId = f.viewerId;
    if (bad === "missing run") runId = randomUUID();
    else if (bad === "deleted task") await pg`UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=${f.taskId}`;
    else if (bad === "wrong project") projectId = randomUUID();
    else if (bad === "nonmember") { const other = await seedExecution(pg); userId = other.userId; }
    else if (bad === "left project") await pg`UPDATE project_members SET deleted_at=clock_timestamp() WHERE project_id=${f.projectId} AND user_id=${f.viewerId}`;
    else await pg`UPDATE projects SET deleted_at=clock_timestamp() WHERE id=${f.projectId}`;
    const response = await get(f, userId, projectId, runId); expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: 404 } });
  });
  it.each(["legacy", "analysis"] as const)("Q05 does not expose a %s task as a planned execution", async (lane) => {
    const f = await seedExecution(pg);
    await pg`UPDATE tasks SET params=${pg.json(lane === "legacy" ? { tool: "remove-bg" } : { analysis: { kind: "scene_cuts" } })},task_type=${lane === "analysis" ? "mini_tool_analysis" : "video"} WHERE id=${f.taskId}`;
    expect((await get(f)).status).toBe(404);
  });
  it("Q06/B01 projects complete active0 from accepted F without writing or opening steps", async () => {
    const f = await seedExecution(pg, "pending", false); const before = await executionSnapshot(pg, f); const response = await get(f);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: f.record }); expect(await executionSnapshot(pg, f)).toEqual(before);
    const [steps] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM task_upstream_steps WHERE task_id=${f.taskId}`; expect(steps).toEqual({ count: 0 });
  });
  it.each(["pending", "known"] as const)("Q07 reads completed canonical output while expense is %s and not billed", async (state) => {
    const f = await seedExecution(pg); const record = await terminal(f); record.usage = [{ consumptionKey: "c".repeat(64), state, chargeTo: "user", costUsd: state === "pending" ? null : 0.3, credits: null }]; await storeExecutionFixture(pg, f, record);
    const response = await get(f); expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: record }); expect((await executionSnapshot(pg, f)).billed_at).toBeNull();
  });
  it("Q08 retains a failed run's status, its error on every output and recorded expense", async () => {
    const f = await seedExecution(pg); const record = await terminal(f, "failed"); record.usage = [{ consumptionKey: "c".repeat(64), state: "recorded", chargeTo: "user", costUsd: 0.3, credits: 30 }]; await storeExecutionFixture(pg, f, record);
    const response = await get(f); expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: record });
  });
  it.each(["plan hash", "record identity", "registered mapping", "settlement"])("Q09 treats damaged persisted %s as an application data error with a log", async (bad) => {
    const f = await seedExecution(pg); const record = await terminal(f);
    if (bad === "plan hash") { const plan = { ...f.plan, planFingerprint: "e".repeat(64) }; await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: plan })} WHERE id=${f.taskId}`; }
    else if (bad === "record identity") { record.runId = randomUUID(); await storeExecutionFixture(pg, f, record); }
    else if (bad === "registered mapping") { record.outputs[0]!.nodeId = randomUUID(); await storeExecutionFixture(pg, f, record); }
    else await pg`UPDATE tasks SET result=result || ${pg.json({ settlement: { state: "broken" } })} WHERE id=${f.taskId}`;
    const error = vi.spyOn(logger, "error");
    try { const response = await get(f); expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ error: { code: 500 } }); expect(error).toHaveBeenCalled(); }
    finally { error.mockRestore(); }
  });
  it("M12/Q reads the original cancelled SQL status without inventing cancellation fees or a new execution", async () => {
    const f = await seedExecution(pg, "cancelled"); const before = await executionSnapshot(pg, f); const response = await get(f);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: f.record }); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("Q10 is a tasks-only projection even when the private steps table cannot be addressed", async () => {
    const f = await seedExecution(pg); const record = await terminal(f); await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.plan.binding.assetId}`;
    await pg`ALTER TABLE task_upstream_steps RENAME TO fixture_private_steps_unavailable`;
    try { const response = await get(f); expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: record }); }
    finally { await pg`ALTER TABLE fixture_private_steps_unavailable RENAME TO task_upstream_steps`; }
  });
  it("Q10 exposes neither private F nor arbitrary task/step/settlement siblings", async () => {
    const f = await seedExecution(pg); const record = await terminal(f);
    await pg`UPDATE tasks SET result=result || ${pg.json({ privateBill: { token: "private-credential", raw: 123 }, providerURL: "https://provider.example.test/private", sourceKey: "private/source.mp4" })} WHERE id=${f.taskId}`;
    const before = await executionSnapshot(pg, f); const response = await get(f); expect(response.status).toBe(200); const body: unknown = await response.json(); expect(body).toEqual({ data: record });
    for (const secret of ["private-credential", "private/source.mp4", "provider.example.test", "\"sourceKey\"", "preserve_audio", "\"raw\""]) expect(JSON.stringify(body)).not.toContain(secret);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("Q retains the original /tasks actor-only boundary for the same collaborator", async () => {
    const f = await seedExecution(pg); const response = await app.request(`/api/v1/tasks/${f.taskId}`, { headers: { Cookie: await cookie(f.viewerId) } });
    expect(response.status).toBe(403); expect((await get(f)).status).toBe(200);
  });
});
