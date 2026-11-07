// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Timeline execution HTTP surface (inner#1711 design §3.4, §4, §5.1; acceptance V1, V2, V4).
 *
 * `POST /timeline/executions` admits a web-animation execution: an action already accepted answers its own row (or
 * 409 when the input differs) and holds nothing; a new one holds its credits under the new execution id, then writes
 * the execution and this Project's grant in one transaction, and every failure after the hold releases it. The read
 * routes answer through the grant rows, so a duplicated Project can resolve and preview what its source made while
 * its execution list stays its own. Cancel ends a row nothing has started and releases its hold.
 *
 * Driven through the real app, database and Redis with payments on, so holds are real `credit_holds` rows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

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
import {
  env,
  getNodeTaskConfig,
  getRedis,
  getStreamRedis,
  getTimelineConfig,
  initCore,
  loadLocales,
  sessionCookieName,
  setSession,
  timelineExecutionRepo,
  type Redis,
} from "@breatic/core";
import { webAnimationSourceRepo } from "@breatic/domain";
import { ceilToCreditCent, extractPromptText, readSignedPayload, t } from "@breatic/shared";
import { decodePreviewToken } from "@breatic/shared/space-content";
import type { TimelineExecution } from "@breatic/shared";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import { seedDesignatedLot } from "@server/__tests__/integration/studio-credit-fixtures.js";

const PREVIEW_BASE_URL = "https://preview.timeline.test";
const SUITE_ENV = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  WEB_ANIMATION_PREVIEW_BASE_URL: PREVIEW_BASE_URL,
};
const APP = "timeline-routes-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;
let subscriber: Redis;
const signals: { channel: string; message: Record<string, unknown> }[] = [];

beforeAll(async () => {
  initCore(SUITE_ENV);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: APP } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    signals.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
});

beforeEach(() => {
  signals.length = 0;
});

afterAll(async () => {
  await subscriber?.quit();
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Member { userId: string; cookie: string }
interface ProjectFixture {
  owner: Member;
  editor: Member;
  viewer: Member;
  studioId: string;
  projectId: string;
  spaceId: string;
}

let seq = 0;

/**
 * A session cookie for a user.
 * @param userId - Who signs in.
 * @returns The cookie header value.
 */
async function sessionFor(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * A signed-in user with a personal studio they administer.
 * @returns The user, their cookie and their studio.
 */
async function seedUser(): Promise<Member & { studioId: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`tlx-${seq++}-${crypto.randomUUID()}@example.test`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`tlx-s-${crypto.randomBytes(8).toString("hex")}`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  return { userId: user!.id, studioId: studio!.id, cookie: await sessionFor(user!.id) };
}

/**
 * A Project owned by a studio admin, with an editor and a viewer, a Timeline Space id and designated credits.
 * @param credits - The credits designated to the owner's studio.
 * @returns Everyone, the Project and the Space.
 */
async function seedProject(credits = 10_000): Promise<ProjectFixture> {
  const owner = await seedUser();
  const slug = `tlx-p-${crypto.randomBytes(8).toString("hex")}`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, initial_space_type)
    VALUES (${owner.studioId}, ${owner.userId}, ${slug}, ${slug}, 'timeline') RETURNING id
  `;
  const projectId = project!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${owner.userId}, 'owner', null)`;
  const editor = await seedUser();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${editor.userId}, 'editor', ${owner.userId})`;
  const viewer = await seedUser();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${viewer.userId}, 'viewer', ${owner.userId})`;
  if (credits > 0) await seedDesignatedLot(sql, { userId: owner.userId, studioId: owner.studioId, projectId }, credits);
  return { owner, editor, viewer, studioId: owner.studioId, projectId, spaceId: crypto.randomUUID() };
}

/**
 * A create-execution body.
 * @param fx - The Project and Space.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function createBody(fx: ProjectFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: fx.projectId,
    spaceId: fx.spaceId,
    actionId: crypto.randomUUID(),
    prompt: "A red square slides in from the left",
    engine: "deepseek",
    aspect: "16:9",
    durationSeconds: 4,
    fps: { num: 24, den: 1 },
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
 * Accept an execution and read it back from the answer.
 * @param fx - The Project.
 * @param overrides - Body fields a case varies.
 * @returns The accepted row.
 */
async function accepted(fx: ProjectFixture, overrides: Record<string, unknown> = {}): Promise<TimelineExecution> {
  const res = await accept(fx.editor.cookie, createBody(fx, overrides));
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { data: TimelineExecution }).data;
}

/**
 * The credit holds of a studio.
 * @param studioId - The studio.
 * @returns Its rows, oldest first.
 */
async function holdsOf(studioId: string): Promise<{ reference_id: string; status: string; amount: number }[]> {
  const rows = await sql<{ reference_id: string; status: string; amount: string }[]>`
    SELECT reference_id, status, amount::text AS amount FROM credit_holds WHERE studio_id = ${studioId} ORDER BY created_at, id
  `;
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

/**
 * The live grants of an execution.
 * @param executionId - The execution.
 * @returns The Projects granted it, sorted.
 */
async function grantedProjects(executionId: string): Promise<string[]> {
  const rows = await sql<{ project_id: string }[]>`
    SELECT project_id FROM timeline_execution_grants WHERE execution_id = ${executionId} AND deleted_at IS NULL ORDER BY project_id
  `;
  return rows.map((row) => row.project_id);
}

/**
 * Insert an execution straight through the repository, with no hold or grant.
 * @param projectId - Its Project.
 * @param spaceId - Its Space.
 * @param actorUserId - Who accepted it.
 * @returns The row.
 */
async function insertExecution(projectId: string, spaceId: string, actorUserId: string): Promise<TimelineExecution> {
  const row = await timelineExecutionRepo.insert({
    projectId,
    spaceId,
    actorUserId,
    kind: "web_animation_create",
    engine: "deepseek",
    actionId: crypto.randomUUID(),
    input: { prompt: "A red square", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } },
    inputHash: `sha256:${crypto.randomUUID()}`,
    deadlineAt: new Date(Date.now() + getNodeTaskConfig().default_budget_ms),
  });
  if (row === null) throw new Error("Fixture execution conflicted");
  return row;
}

/**
 * Grant an execution to a Project, as acceptance or a Project copy does.
 * @param executionId - The execution.
 * @param projectId - The Project.
 */
async function grant(executionId: string, projectId: string): Promise<void> {
  await sql`INSERT INTO timeline_execution_grants (execution_id, project_id) VALUES (${executionId}, ${projectId})`;
}

/**
 * Move an execution through the writer.
 * @param id - The execution.
 * @param event - The event.
 * @returns The row after it.
 */
async function step(id: string, event: Parameters<typeof timelineExecutionRepo.transition>[0]["event"]): Promise<TimelineExecution> {
  const result = await timelineExecutionRepo.transition({ id, event });
  if (!result.applied) throw new Error(`Fixture step ${event.type} refused`);
  return result.row;
}

/**
 * Finish an execution with a source version, as the worker does.
 * @param execution - A running or awaiting row.
 * @returns The source version.
 */
async function succeed(execution: TimelineExecution): Promise<{ id: string }> {
  await step(execution.id, { type: "land", inputHash: execution.inputHash });
  const running = await step(execution.id, { type: "claim" });
  const source = await webAnimationSourceRepo.insert({
    executionId: execution.id,
    packageKey: `web-animation/${execution.projectId}/${execution.id}/index.html`,
    manifestKey: `web-animation/${execution.projectId}/${execution.id}/manifest.json`,
    packageSha256: "a".repeat(64),
    packageBytes: 600_000,
    manifestSha256: "b".repeat(64),
    runtimeVersion: "@hyperframes/core@0.8.186",
    fontSetVersion: 1,
    width: 1920,
    height: 1080,
    fpsNum: 24,
    fpsDen: 1,
    durationFrames: 96,
  });
  await step(execution.id, { type: "success", fence: running.fence, resultSourceVersionId: source.id });
  return source;
}

/**
 * The space-tasks signals one Space received, after giving late ones time to arrive.
 * @param projectId - The Project.
 * @param spaceId - The Space.
 * @returns Them.
 */
async function signalsFor(projectId: string, spaceId: string): Promise<Record<string, unknown>[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return signals.filter((s) => s.channel.includes(projectId) && s.message.spaceId === spaceId).map((s) => s.message);
}

/**
 * Assert the route itself answered "not found", which a request to a route that does not exist cannot.
 * @param res - The response.
 */
async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 404, message: t("server.error.not_found") } });
}

const RESERVE = (): number => ceilToCreditCent(getTimelineConfig().web_animation.reserve_credits);

describe("POST /timeline/executions", () => {
  it("accepts a new action: holds its credits under the execution id and writes the row and this Project's grant", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const before = Date.now();
    const res = await accept(fx.editor.cookie, body);
    expect(res.status, await res.clone().text()).toBe(201);
    const { data } = (await res.json()) as { data: TimelineExecution };
    expect(data).toMatchObject({
      projectId: fx.projectId,
      spaceId: fx.spaceId,
      actorUserId: fx.editor.userId,
      kind: "web_animation_create",
      engine: "deepseek",
      actionId: body.actionId,
      status: "awaiting_landing",
      attempt: 0,
      fence: null,
      resultSourceVersionId: null,
      billedAt: null,
    });
    expect(data.input).toMatchObject({ prompt: body.prompt, aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } });
    const budget = getNodeTaskConfig().default_budget_ms;
    expect(Date.parse(data.deadlineAt)).toBeGreaterThanOrEqual(before + budget - 1);
    expect(Date.parse(data.deadlineAt)).toBeLessThanOrEqual(Date.now() + budget + 1);
    expect(await timelineExecutionRepo.findById(data.id)).toEqual(data);
    expect(await grantedProjects(data.id)).toEqual([fx.projectId]);
    expect(await holdsOf(fx.studioId)).toEqual([{ reference_id: data.id, status: "held", amount: RESERVE() }]);
  });

  it("keeps the document's frame rate in the frozen input", async () => {
    const fx = await seedProject();
    const row = await accepted(fx, { fps: { num: 30_000, den: 1001 } });
    expect(row.input).toMatchObject({ fps: { num: 30_000, den: 1001 } });
  });

  it("freezes the prompt as extractPromptText leaves it", async () => {
    const fx = await seedProject();
    const raw = "<p>A <b>red</b> square<!-- hidden --></p>\u200b";
    expect(extractPromptText(raw)).not.toBe(raw);
    const row = await accepted(fx, { prompt: raw });
    expect(row.input).toMatchObject({ prompt: extractPromptText(raw) });
  });

  it("answers an action already accepted with the same input with its original row, holding nothing more", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const first = await accept(fx.editor.cookie, body);
    expect(first.status).toBe(201);
    const original = ((await first.json()) as { data: TimelineExecution }).data;
    const again = await accept(fx.editor.cookie, body);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(((await again.json()) as { data: TimelineExecution }).data).toEqual(original);
    expect(await holdsOf(fx.studioId)).toEqual([{ reference_id: original.id, status: "held", amount: RESERVE() }]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId} AND action_id = ${String(body.actionId)}
    `;
    expect(count).toBe(1);
  });

  it("refuses an action already accepted with a different input with 409, holding nothing more", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const original = ((await (await accept(fx.editor.cookie, body)).json()) as { data: TimelineExecution }).data;
    const changed = await accept(fx.editor.cookie, { ...body, prompt: "A blue circle" });
    expect(changed.status).toBe(409);
    expect(await holdsOf(fx.studioId)).toEqual([{ reference_id: original.id, status: "held", amount: RESERVE() }]);
    expect(await timelineExecutionRepo.findById(original.id)).toEqual(original);
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

  it("refuses a studio without credits with the readable 402 and leaves no row, grant or hold", async () => {
    const fx = await seedProject(0);
    const res = await accept(fx.editor.cookie, createBody(fx));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(t("server.credit.none"));
    expect(await holdsOf(fx.studioId)).toEqual([]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(count).toBe(0);
  });

  it("releases the hold and leaves no execution when the accepting transaction fails after the hold", async () => {
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
    const holds = await holdsOf(fx.studioId);
    expect(holds.map((hold) => hold.status)).toEqual(["released"]);
    const [{ count } = { count: -1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(count).toBe(0);
  });

  it("answers 409 and releases its own hold when a concurrent accept of the same action with another input commits first", async () => {
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
        INSERT INTO timeline_executions (id, project_id, space_id, actor_user_id, kind, action_id, input, input_hash, engine, deadline_at)
        VALUES (${competitorId}, ${fx.projectId}, ${fx.spaceId}, ${fx.owner.userId}, 'web_animation_create', ${String(body.actionId)},
                ${tx.json({ prompt: "Something else" })}, 'sha256:competitor', 'deepseek', now() + interval '2 hours')
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
    const holds = await holdsOf(fx.studioId);
    expect(holds.map((hold) => hold.status)).toEqual(["released"]);
    expect(holds[0]!.reference_id).not.toBe(competitorId);
    const rows = await sql<{ id: string }[]>`SELECT id FROM timeline_executions WHERE project_id = ${fx.projectId}`;
    expect(rows).toEqual([{ id: competitorId }]);
  });
});

describe("GET /timeline/executions", () => {
  it("lists only the requested Project's executions in the Space, newest first, with each one's usage credits", async () => {
    const fx = await seedProject(0);
    // Another Project with a Space of the same id, as a Project copy has; its executions are not this list's.
    const copy = await seedProject(0);
    const older = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    const newer = await insertExecution(fx.projectId, fx.spaceId, fx.owner.userId);
    await insertExecution(fx.projectId, crypto.randomUUID(), fx.owner.userId);
    const inCopy = await insertExecution(copy.projectId, fx.spaceId, copy.owner.userId);
    await grant(inCopy.id, fx.projectId);
    await sql`UPDATE timeline_executions SET created_at = now() - interval '2 minutes' WHERE id = ${older.id}`;
    await sql`UPDATE timeline_executions SET created_at = now() - interval '1 minute' WHERE id = ${newer.id}`;
    for (const credits of ["1.5", "2.25"]) {
      await sql`
        INSERT INTO agent_usage_records (operation_key, feature, source, actor_user_id, project_id, model, provider, cost_usd, cost_source, credits)
        VALUES (${`timeline:${older.id}`}, 'timeline_web_animation', 'model', ${fx.owner.userId}, ${fx.projectId},
                'deepseek/deepseek-v4.1-flash-1017', 'openrouter', 0.01, 'provider', ${credits})
      `;
    }
    const res = await app.request(`/api/v1/timeline/executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}`, {
      headers: { Cookie: fx.viewer.cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as { data: (TimelineExecution & { usageCredits: number })[] };
    expect(data.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(data.map((row) => row.usageCredits)).toEqual([0, 3.75]);
    expect(data[1]).toMatchObject({ id: older.id, projectId: fx.projectId, spaceId: fx.spaceId, status: "awaiting_landing", steps: [], phase: null });
  });

  it("answers an outsider with 404", async () => {
    const fx = await seedProject(0);
    const outsider = await seedUser();
    const res = await app.request(`/api/v1/timeline/executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}`, {
      headers: { Cookie: outsider.cookie },
    });
    await expectNotFound(res);
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
    await step(running.id, { type: "land", inputHash: running.inputHash });
    await step(running.id, { type: "claim" });
    const foreignSource = await succeed(foreign);

    const query = `projectId=${fx.projectId}&sourceIds=${source.id},${foreignSource.id}&executionIds=${done.id},${running.id},${foreign.id}`;
    const res = await app.request(`/api/v1/timeline/web-sources?${query}`, { headers: { Cookie: fx.viewer.cookie } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        sources: {
          [source.id]: { durationFrames: 96, fps: { num: 24, den: 1 }, viewport: { width: 1920, height: 1080 } },
        },
        executions: {
          [done.id]: { status: "succeeded", resultSourceVersionId: source.id, acceptedDurationFrames: 96, fps: { num: 24, den: 1 } },
          [running.id]: { status: "running", resultSourceVersionId: null, acceptedDurationFrames: 96, fps: { num: 24, den: 1 } },
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
        sources: { [source.id]: { durationFrames: 96, fps: { num: 24, den: 1 }, viewport: { width: 1920, height: 1080 } } },
        executions: { [done.id]: { status: "succeeded", resultSourceVersionId: source.id, acceptedDurationFrames: 96, fps: { num: 24, den: 1 } } },
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
   * @returns The response.
   */
  async function cancel(cookie: string, id: string): Promise<Response> {
    return app.request(`/api/v1/timeline/executions/${id}/cancel`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({}),
    });
  }

  it.each(["awaiting_landing", "queued"] as const)(
    "cancels a %s execution, releases its hold and signals the Space once",
    async (state) => {
      const fx = await seedProject();
      const row = await accepted(fx);
      if (state === "queued") await step(row.id, { type: "land", inputHash: row.inputHash });
      signals.length = 0;
      const res = await cancel(fx.editor.cookie, row.id);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { data: TimelineExecution }).data).toMatchObject({ id: row.id, status: "cancelled" });
      expect((await timelineExecutionRepo.findById(row.id))?.status).toBe("cancelled");
      expect(await holdsOf(fx.studioId)).toEqual([{ reference_id: row.id, status: "released", amount: RESERVE() }]);
      expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([
        { type: "project-space-tasks:changed", projectId: fx.projectId, spaceId: fx.spaceId, ts: expect.any(Number) },
      ]);
    },
  );

  it("moves a running execution to cancelling, keeping its attempt's fence and its hold", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    await step(row.id, { type: "land", inputHash: row.inputHash });
    const running = await step(row.id, { type: "claim" });
    const res = await cancel(fx.editor.cookie, row.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: TimelineExecution }).data).toMatchObject({ status: "cancelling", fence: running.fence, attempt: 1 });
    expect(await holdsOf(fx.studioId)).toEqual([{ reference_id: row.id, status: "held", amount: RESERVE() }]);
  });

  it("answers a terminal execution with its row unchanged and signals nothing", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    await cancel(fx.editor.cookie, row.id);
    const ended = await timelineExecutionRepo.findById(row.id);
    await signalsFor(fx.projectId, fx.spaceId);
    signals.length = 0;
    const again = await cancel(fx.editor.cookie, row.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: TimelineExecution }).data).toEqual(ended);
    expect(await timelineExecutionRepo.findById(row.id)).toEqual(ended);
    expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([]);
  });

  it("refuses a viewer with 403 and leaves the row and hold in place", async () => {
    const fx = await seedProject();
    const row = await accepted(fx);
    expect((await cancel(fx.viewer.cookie, row.id)).status).toBe(403);
    expect(await timelineExecutionRepo.findById(row.id)).toEqual(row);
    expect(await holdsOf(fx.studioId)).toEqual([{ reference_id: row.id, status: "held", amount: RESERVE() }]);
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
      { column_name: "execution_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "project_id", data_type: "uuid", is_nullable: "NO" },
    ]);
    await grant(row.id, fx.projectId);
    await expect(grant(row.id, fx.projectId)).rejects.toMatchObject({ code: "23505" });
  });
});
