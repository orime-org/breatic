// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web-animation execution HTTP surface (inner#1711 design §3.4, §4, §5.1; #1490 design §4.1, §4.4).
 *
 * `POST /timeline/executions` admits an execution as an Agent chat turn is admitted: a balance above zero is all it
 * needs, and no credits are held. A body names its `kind`; the row starts `queued`. An action already accepted
 * answers its own row (or 409 when the input differs); a new one writes the execution and this Project's grant in one
 * transaction. The read routes answer through the grant rows, so a duplicated Project resolves
 * and previews what its source made. Cancel ends a row nothing has started; there is nothing to release.
 */

import { describe, it, expect, beforeAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { env, getNodeTaskConfig, getTimelineConfig, timelineExecutionRepo } from "@breatic/core";
import { extractPromptText, readSignedPayload, t, timelineSpaceDocName } from "@breatic/shared";
import { decodePreviewToken } from "@breatic/shared/space-content";
import type { TimelineExecution } from "@breatic/shared";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import { useWebAnimationHarness, type ProjectFixture } from "@server/__tests__/integration/web-animation-harness.js";

const APP = "timeline-routes-test-driver";
const h = useWebAnimationHarness(APP);
let sql: ReturnType<typeof postgres>;
let app: Hono;
const { seedUser, seedProject, holdsOf, grantedProjects, grant, step, succeed, signalsFor, executionChangesFor, expectNotFound } = h;
const signals = h.signals;

beforeAll(() => {
  sql = h.sql;
  app = h.app;
});

/**
 * A create body.
 * @param fx - The Project and Space.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function createBody(fx: ProjectFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: fx.projectId,
    spaceId: fx.spaceId,
    actionId: crypto.randomUUID(),
    kind: "web_animation_create",
    prompt: "A red square slides in from the left",
    engine: "deepseek",
    aspect: "16:9",
    durationSeconds: 4,
    ...overrides,
  };
}

/**
 * Ask to accept an execution.
 * @param cookie - Who asks.
 * @param body - The body.
 * @returns The response.
 */
async function accept(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/v1/timeline/executions", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

/**
 * Accept an execution and read its row.
 * @param fx - The Project.
 * @param overrides - Body fields a case varies.
 * @returns The accepted row as stored.
 */
async function accepted(fx: ProjectFixture, overrides: Record<string, unknown> = {}): Promise<TimelineExecution> {
  const res = await accept(fx.editor.cookie, createBody(fx, overrides));
  expect(res.status, await res.clone().text()).toBe(201);
  const { id } = ((await res.json()) as { data: { id: string } }).data;
  const row = await timelineExecutionRepo.findById(id);
  if (row === undefined) throw new Error("Accepted execution missing");
  return row;
}

/**
 * Insert a create execution straight through the repository, with no grant.
 * @param projectId - Its Project.
 * @param spaceId - Its Space.
 * @param actorUserId - Who accepted it.
 * @returns The row.
 */
async function insertExecution(projectId: string, spaceId: string, actorUserId: string): Promise<TimelineExecution> {
  return h.insertExecution({ projectId, spaceId, actorUserId });
}

/**
 * Insert a row as one stored before #1490 is, made in a Timeline and still waiting for its landing receipt, and grant
 * it to its Project.
 * @param fx - The Project and Space.
 * @returns The row.
 */
async function insertBefore1490(fx: ProjectFixture): Promise<TimelineExecution> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO timeline_executions (project_id, space_id, actor_user_id, kind, action_id, input, input_hash, engine, deadline_at, status, origin)
    VALUES (${fx.projectId}, ${fx.spaceId}, ${fx.editor.userId}, 'web_animation_create', ${crypto.randomUUID()},
      ${sql.json({ prompt: "A", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } })},
      'sha256:before', 'deepseek', now() + interval '2 hours', 'awaiting_landing', 'timeline')
    RETURNING id
  `;
  await grant(row!.id, fx.projectId);
  const read = await timelineExecutionRepo.findById(row!.id);
  if (read === undefined) throw new Error("Fixture execution missing");
  return read;
}

describe("POST /timeline/executions", () => {
  it("accepts a create, queued, with this Project's grant and no hold", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const before = Date.now();
    const res = await accept(fx.editor.cookie, body);
    expect(res.status, await res.clone().text()).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data).toMatchObject({
      spaceId: fx.spaceId,
      kind: "web_animation_create",
      status: "queued",
      request: body.prompt,
      ownProject: true,
      resultSourceVersionId: null,
    });
    const row = await timelineExecutionRepo.findById(data.id);
    expect(row).toMatchObject({
      projectId: fx.projectId,
      spaceId: fx.spaceId,
      actorUserId: fx.editor.userId,
      kind: "web_animation_create",
      engine: "deepseek",
      actionId: body.actionId,
      origin: "web_animation_space",
      status: "queued",
      attempt: 0,
      fence: null,
      resultSourceVersionId: null,
      billedAt: null,
    });
    expect(row?.input).toEqual({ prompt: body.prompt, engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: getTimelineConfig().web_animation.fps });
    const budget = getNodeTaskConfig().default_budget_ms;
    expect(Date.parse(row!.deadlineAt)).toBeGreaterThanOrEqual(before + budget - 1);
    expect(Date.parse(row!.deadlineAt)).toBeLessThanOrEqual(Date.now() + budget + 1);
    expect(await grantedProjects(data.id)).toEqual([fx.projectId]);
    expect(await holdsOf(fx.studioId)).toEqual([]);
  });

  it("accepts with any balance above zero, however little of a run it would cover, holding nothing", async () => {
    const fx = await seedProject(1);
    const row = await accepted(fx);
    expect(row.status).toBe("queued");
    expect(await holdsOf(fx.studioId)).toEqual([]);
  });

  it("refuses a body without a kind with 422 and writes nothing", async () => {
    const fx = await seedProject();
    const { kind: _kind, ...kindless } = createBody(fx);
    expect((await accept(fx.editor.cookie, kindless)).status).toBe(422);
    expect((await accept(fx.editor.cookie, { ...kindless, fps: { num: 24, den: 1 } })).status).toBe(422);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(count).toBe(0);
  });

  it("freezes the prompt as extractPromptText leaves it", async () => {
    const fx = await seedProject();
    const raw = "<p>A <b>red</b> square<!-- hidden --></p>\u200b";
    expect(extractPromptText(raw)).not.toBe(raw);
    const row = await accepted(fx, { prompt: raw });
    expect(row.input).toMatchObject({ prompt: extractPromptText(raw) });
  });

  it("answers an action already accepted with the same input with its original row, holding nothing", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const first = await accept(fx.editor.cookie, body);
    expect(first.status).toBe(201);
    const original = ((await first.json()) as { data: unknown }).data;
    const again = await accept(fx.editor.cookie, body);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(((await again.json()) as { data: unknown }).data).toEqual(original);
    expect(await holdsOf(fx.studioId)).toEqual([]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId} AND action_id = ${String(body.actionId)}
    `;
    expect(count).toBe(1);
  });

  it("refuses an action already accepted with a different input with 409, holding nothing", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const { id } = ((await (await accept(fx.editor.cookie, body)).json()) as { data: { id: string } }).data;
    const original = await timelineExecutionRepo.findById(id);
    const changed = await accept(fx.editor.cookie, { ...body, prompt: "A blue circle" });
    expect(changed.status).toBe(409);
    expect(await holdsOf(fx.studioId)).toEqual([]);
    expect(await timelineExecutionRepo.findById(id)).toEqual(original);
  });

  it("refuses a viewer with 403 and an outsider with 404, writing and holding nothing", async () => {
    const fx = await seedProject();
    const outsider = await seedUser();
    const viewerBody = createBody(fx);
    expect((await accept(fx.viewer.cookie, viewerBody)).status).toBe(403);
    await expectNotFound(await accept(outsider.cookie, createBody(fx)));
    expect(await holdsOf(fx.studioId)).toEqual([]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(count).toBe(0);
  });

  it("refuses a studio with a zero balance with the readable 402 and leaves no row, grant or hold", async () => {
    const fx = await seedProject(0);
    const res = await accept(fx.editor.cookie, createBody(fx));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(t("server.credit.none"));
    expect(await holdsOf(fx.studioId)).toEqual([]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(count).toBe(0);
  });

  it("leaves no execution and no hold when the accepting transaction fails", async () => {
    const fx = await seedProject();
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION timeline_grant_refused_for_test() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'grant refused by test'; END $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
      CREATE TRIGGER timeline_grant_refused_for_test BEFORE INSERT ON timeline_execution_grants
      FOR EACH ROW WHEN (NEW.project_id = '${fx.projectId}') EXECUTE FUNCTION timeline_grant_refused_for_test()
    `);
    try {
      const res = await accept(fx.editor.cookie, createBody(fx));
      expect(res.status).toBe(500);
    } finally {
      await sql.unsafe("DROP TRIGGER IF EXISTS timeline_grant_refused_for_test ON timeline_execution_grants");
      await sql.unsafe("DROP FUNCTION IF EXISTS timeline_grant_refused_for_test()");
    }
    expect(await holdsOf(fx.studioId)).toEqual([]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(count).toBe(0);
  });

  it("answers 409 and holds nothing when a concurrent accept of the same action with another input commits first", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: `${APP}-gate` } });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let inserted: () => void = () => {};
    const rowWritten = new Promise<void>((resolve) => { inserted = resolve; });
    const competitorId = crypto.randomUUID();
    const competitor = gate.begin(async (tx) => {
      await tx`
        INSERT INTO timeline_executions (id, project_id, space_id, actor_user_id, kind, action_id, input, input_hash, engine, deadline_at, origin)
        VALUES (${competitorId}, ${fx.projectId}, ${fx.spaceId}, ${fx.owner.userId}, 'web_animation_create', ${String(body.actionId)},
                ${tx.json({ prompt: "Something else" })}, 'sha256:competitor', 'deepseek', now() + interval '2 hours', 'web_animation_space')
      `;
      inserted();
      await held;
    });
    await rowWritten;
    try {
      const pending = accept(fx.editor.cookie, body);
      await waitUntilBlockedOn(sql, ["timeline_executions", "insert"], 1);
      release();
      await competitor;
      const res = await pending;
      expect(res.status).toBe(409);
    } finally {
      release();
      await gate.end({ timeout: 1 });
    }
    expect(await holdsOf(fx.studioId)).toEqual([]);
    const rows = await sql<{ id: string }[]>`SELECT id FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(rows).toEqual([{ id: competitorId }]);
  });
});


describe("GET /timeline/web-sources", () => {
  it("resolves only the sources and executions this Project holds a grant for", async () => {
    const fx = await seedProject(0);
    const other = await seedProject(0);
    const done = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    const running = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    const foreign = await insertExecution(other.projectId, other.spaceId, other.owner.userId);
    await grant(done.id, fx.projectId);
    await grant(running.id, fx.projectId);
    await grant(foreign.id, other.projectId);
    const source = await succeed(done);
    await step(running.id, { type: "claim" });
    await step(running.id, { type: "progress", fence: (await timelineExecutionRepo.findById(running.id))!.fence, phase: "validating" });
    const foreignSource = await succeed(foreign);

    const query = `projectId=${fx.projectId}&sourceIds=${source.id},${foreignSource.id}&executionIds=${done.id},${running.id},${foreign.id}`;
    const res = await app.request(`/api/v1/timeline/web-sources?${query}`, { headers: { Cookie: fx.viewer.cookie } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        sources: {
          [source.id]: {
            durationFrames: 96, fps: { num: 24, den: 1 }, viewport: { width: 1920, height: 1080 },
            executionId: done.id, spaceId: fx.spaceId, origin: "web_animation_space", kind: "web_animation_create", request: "A red square",
          },
        },
        executions: {
          [done.id]: {
            status: "succeeded", resultSourceVersionId: source.id, acceptedDurationFrames: 96, fps: { num: 24, den: 1 },
            executionId: done.id, spaceId: fx.spaceId, origin: "web_animation_space", kind: "web_animation_create", request: "A red square", phase: null, failureReason: null,
          },
          [running.id]: {
            status: "running", resultSourceVersionId: null, acceptedDurationFrames: 96, fps: { num: 24, den: 1 },
            executionId: running.id, spaceId: fx.spaceId, origin: "web_animation_space", kind: "web_animation_create", request: "A red square", phase: "validating", failureReason: null,
          },
        },
      },
    });
  });

  it("resolves another Project's execution and source through a copied grant", async () => {
    const fx = await seedProject(0);
    const copy = await seedProject(0);
    const done = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(done.id, fx.projectId);
    await grant(done.id, copy.projectId);
    const source = await succeed(done);
    const res = await app.request(
      `/api/v1/timeline/web-sources?projectId=${copy.projectId}&sourceIds=${source.id}&executionIds=${done.id}`,
      { headers: { Cookie: copy.viewer.cookie } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        sources: {
          [source.id]: {
            durationFrames: 96, fps: { num: 24, den: 1 }, viewport: { width: 1920, height: 1080 },
            executionId: done.id, spaceId: fx.spaceId, origin: "web_animation_space", kind: "web_animation_create", request: "A red square",
          },
        },
        executions: {
          [done.id]: {
            status: "succeeded", resultSourceVersionId: source.id, acceptedDurationFrames: 96, fps: { num: 24, den: 1 },
            executionId: done.id, spaceId: fx.spaceId, origin: "web_animation_space", kind: "web_animation_create", request: "A red square", phase: null, failureReason: null,
          },
        },
      },
    });
  });

  it("does not resolve through a soft-deleted grant", async () => {
    const fx = await seedProject(0);
    const done = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(done.id, fx.projectId);
    const source = await succeed(done);
    await sql`UPDATE timeline_execution_grants SET deleted_at = now() WHERE execution_id = ${done.id}`;
    const res = await app.request(
      `/api/v1/timeline/web-sources?projectId=${fx.projectId}&sourceIds=${source.id}&executionIds=${done.id}`,
      { headers: { Cookie: fx.viewer.cookie } },
    );
    expect(await res.json()).toEqual({ data: { sources: {}, executions: {} } });
  });
});

describe("POST /timeline/executions/:id/cancel", () => {
  /**
   * Ask to cancel an execution.
   * @param cookie - Who asks.
   * @param id - The execution.
   * @param body - The body: the Project asking.
   * @returns The response.
   */
  async function cancelWith(cookie: string, id: string, body: Record<string, unknown>): Promise<Response> {
    return app.request(`/api/v1/timeline/executions/${id}/cancel`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  /**
   * Ask to cancel an execution from a Project.
   * @param cookie - Who asks.
   * @param fx - The Project asking.
   * @param id - The execution.
   * @returns The response.
   */
  async function cancel(cookie: string, fx: ProjectFixture, id: string): Promise<Response> {
    return cancelWith(cookie, id, { projectId: fx.projectId });
  }

  it("refuses a cancel that names no Project with 422 and leaves the row in place", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    expect((await cancelWith(fx.editor.cookie, row.id, {})).status).toBe(422);
    expect((await timelineExecutionRepo.findById(row.id))?.status).toBe("queued");
  });

  it.each(["awaiting_landing", "queued"] as const)(
    "cancels a %s execution, with no hold to release, and tells its Timeline Space's document once",
    async (state) => {
      const fx = await seedProject();
      const row = state === "queued" ? await accepted(fx) : await insertBefore1490(fx);
      signals.length = 0;
      const before = await executionChangesFor(fx.projectId, fx.spaceId, timelineSpaceDocName);
      const res = await cancel(fx.editor.cookie, fx, row.id);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { data: TimelineExecution }).data).toMatchObject({ id: row.id, status: "cancelled" });
      expect((await timelineExecutionRepo.findById(row.id))?.status).toBe("cancelled");
      expect(await holdsOf(fx.studioId)).toEqual([]);
      expect(await executionChangesFor(fx.projectId, fx.spaceId, timelineSpaceDocName)).toEqual([
        ...before, { type: "space-tasks-version", docName: timelineSpaceDocName(fx.projectId, fx.spaceId) },
      ]);
      expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([]);
    },
  );

  it("moves a running execution to cancelling, keeping its attempt's fence", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    const running = await step(row.id, { type: "claim" });
    const res = await cancel(fx.editor.cookie, fx, row.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: TimelineExecution }).data).toMatchObject({ status: "cancelling", fence: running.fence, attempt: 1 });
    expect(await holdsOf(fx.studioId)).toEqual([]);
  });

  it("answers a terminal execution with its row unchanged and signals nothing", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    await cancel(fx.editor.cookie, fx, row.id);
    const ended = await timelineExecutionRepo.findById(row.id);
    const told = (await executionChangesFor(fx.projectId, fx.spaceId, timelineSpaceDocName)).length;
    const again = await cancel(fx.editor.cookie, fx, row.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: TimelineExecution }).data).toEqual(ended);
    expect(await timelineExecutionRepo.findById(row.id)).toEqual(ended);
    expect(await executionChangesFor(fx.projectId, fx.spaceId, timelineSpaceDocName)).toHaveLength(told);
    expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([]);
  });

  it("refuses a viewer with 403 and leaves the row in place", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    expect((await cancel(fx.viewer.cookie, fx, row.id)).status).toBe(403);
    expect(row).toMatchObject(await timelineExecutionRepo.findById(row.id) ?? {});
    expect(await holdsOf(fx.studioId)).toEqual([]);
  });
});

describe("GET /timeline/sources/:id/preview", () => {
  /**
   * Ask for a preview address.
   * @param cookie - Who asks.
   * @param sourceId - The source version.
   * @param projectId - The Project the request is made from.
   * @returns The response.
   */
  async function preview(cookie: string, sourceId: string, projectId: string): Promise<Response> {
    return app.request(`/api/v1/timeline/sources/${sourceId}/preview?projectId=${projectId}`, { headers: { Cookie: cookie } });
  }

  it("signs the source's package key into a token in the preview path for a viewer of a granted Project", async () => {
    const fx = await seedProject(0);
    const done = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(done.id, fx.projectId);
    const source = await succeed(done);
    const ttl = getTimelineConfig().web_animation.preview_token_ttl_ms;
    const before = Date.now();
    const res = await preview(fx.viewer.cookie, source.id, fx.projectId);
    const after = Date.now();
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as { data: { url: string } };
    const match = /^https:\/\/preview\.timeline\.test\/web-animation\/([A-Za-z0-9_-]+)\/index\.html$/.exec(data.url);
    expect(match).not.toBeNull();
    const signed = decodePreviewToken(match![1]!);
    expect(signed).not.toBeNull();
    const reading = await readSignedPayload<{ sourceVersionId: string; packageKey: string; exp: number }>(signed!, env.INGEST_SHARED_SECRET);
    expect(reading).toEqual({
      ok: true,
      payload: {
        sourceVersionId: source.id,
        packageKey: `web-animation/${fx.projectId}/${done.id}/index.html`,
        exp: expect.any(Number),
      },
    });
    const { exp } = (reading as { payload: { exp: number } }).payload;
    expect(exp).toBeGreaterThanOrEqual(before + ttl);
    expect(exp).toBeLessThanOrEqual(after + ttl);
  });

  it("signs for a Project that holds a copied grant", async () => {
    const fx = await seedProject(0);
    const copy = await seedProject(0);
    const done = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(done.id, fx.projectId);
    await grant(done.id, copy.projectId);
    const source = await succeed(done);
    expect((await preview(copy.viewer.cookie, source.id, copy.projectId)).status).toBe(200);
  });

  it("refuses a Project without a grant and a non-member with 404", async () => {
    const fx = await seedProject(0);
    const other = await seedProject(0);
    const done = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(done.id, fx.projectId);
    const source = await succeed(done);
    await expectNotFound(await preview(other.owner.cookie, source.id, other.projectId));
    await expectNotFound(await preview(other.owner.cookie, source.id, fx.projectId));
    await expectNotFound(await preview(fx.viewer.cookie, crypto.randomUUID(), fx.projectId));
  });
});

describe("POST /projects/:id/duplicate", () => {
  /**
   * Duplicate a Project as its owner.
   * @param fx - The Project.
   * @returns The response.
   */
  async function duplicate(fx: ProjectFixture): Promise<Response> {
    return app.request(`/api/v1/projects/${fx.projectId}/duplicate`, {
      method: "POST",
      headers: { Cookie: fx.owner.cookie, "Content-Type": "application/json" },
    });
  }

  it("copies every live grant of the source Project to the copy", async () => {
    const fx = await seedProject(0);
    const other = await seedProject(0);
    const own = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    const inherited = await insertExecution(other.projectId, other.spaceId, other.owner.userId);
    const revoked = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(own.id, fx.projectId);
    await grant(inherited.id, fx.projectId);
    await grant(revoked.id, fx.projectId);
    await sql`UPDATE timeline_execution_grants SET deleted_at = now() WHERE execution_id = ${revoked.id}`;
    const res = await duplicate(fx);
    expect(res.status, await res.clone().text()).toBe(201);
    const copyId = ((await res.json()) as { data: { id: string } }).data.id;
    const rows = await sql<{ execution_id: string }[]>`
      SELECT execution_id FROM timeline_execution_grants WHERE project_id = ${copyId} AND deleted_at IS NULL ORDER BY execution_id
    `;
    expect(rows.map((row) => row.execution_id)).toEqual([own.id, inherited.id].sort());
    expect(await grantedProjects(own.id)).toEqual([fx.projectId, copyId].sort());
  });

  it("copies the grants in the copy's own transaction: a refused grant leaves no copy behind", async () => {
    const fx = await seedProject(0);
    const own = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await grant(own.id, fx.projectId);
    const projectsBefore = await sql<{ id: string }[]>`SELECT id FROM projects WHERE studio_id = ${fx.studioId} ORDER BY id`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION timeline_grant_copy_refused_for_test() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'grant copy refused by test'; END $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
      CREATE TRIGGER timeline_grant_copy_refused_for_test BEFORE INSERT ON timeline_execution_grants
      FOR EACH ROW WHEN (NEW.execution_id = '${own.id}' AND NEW.project_id <> '${fx.projectId}')
      EXECUTE FUNCTION timeline_grant_copy_refused_for_test()
    `);
    try {
      expect((await duplicate(fx)).status).toBe(500);
    } finally {
      await sql.unsafe("DROP TRIGGER IF EXISTS timeline_grant_copy_refused_for_test ON timeline_execution_grants");
      await sql.unsafe("DROP FUNCTION IF EXISTS timeline_grant_copy_refused_for_test()");
    }
    expect(await sql<{ id: string }[]>`SELECT id FROM projects WHERE studio_id = ${fx.studioId} ORDER BY id`).toEqual(projectsBefore);
    expect(await grantedProjects(own.id)).toEqual([fx.projectId]);
  });
});

describe("timeline_execution_grants", () => {
  it("has a uuid id, a deleted_at and one live row per execution and Project", async () => {
    const fx = await seedProject(0);
    const row = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'timeline_execution_grants' ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "deleted_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "execution_created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "execution_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "execution_origin", data_type: "text", is_nullable: "NO" },
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "project_id", data_type: "uuid", is_nullable: "NO" },
    ]);
    await grant(row.id, fx.projectId);
    await expect(grant(row.id, fx.projectId)).rejects.toMatchObject({ code: "23505" });
  });
});
