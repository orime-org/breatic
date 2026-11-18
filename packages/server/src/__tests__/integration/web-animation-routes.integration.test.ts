// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space's execution routes (#1490 design §4.2, §4.4, §6.3, §6.4, §13.1).
 *
 * A Motion Space creates, modifies and exports; each accepted row starts `queued` with origin `web_animation_space`
 * and is answered as the shared row view. An export first looks for a live export of the same source in the same
 * Space that this Project holds a grant for, before the balance and storage checks, and the partial unique index
 * settles two exports racing. The list, result and single-row reads answer through the grants, so a duplicated
 * Project sees what its source made, and may preview, modify and export it but not cancel it.
 */

import { describe, it, expect, afterAll, beforeAll, inject, vi } from "vitest";

// Counts the source-version reads a row view makes; every call goes through to the real repository.
const versionReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const repo = actual.webAnimationSourceRepo;
  return {
    ...actual,
    webAnimationSourceRepo: {
      ...repo,
      findByIds: (...args: Parameters<typeof repo.findByIds>) => {
        versionReads.count += 1;
        return repo.findByIds(...args);
      },
    },
  };
});

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

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { TIMELINE_QUEUE, coverKeyFor, createQueue, getTimelineConfig, timelineExecutionRepo } from "@breatic/core";
import { extractPromptText, t, webAnimationSpaceDocName, type TimelineExecution } from "@breatic/shared";
import { WebAnimationRowViewSchema } from "@breatic/shared/space-content";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import { useWebAnimationHarness, type ProjectFixture } from "@server/__tests__/integration/web-animation-harness.js";

const APP = "web-animation-routes-test-driver";
const h = useWebAnimationHarness(APP);
let sql: ReturnType<typeof postgres>;
let app: Hono;
const { seedUser, seedProject, insertExecution, grant, step, succeed, signalsFor, executionChangesFor, expectNotFound, fillStorage, grantedProjects } = h;

let queue: ReturnType<typeof createQueue>;

beforeAll(() => {
  sql = h.sql;
  app = h.app;
  queue = createQueue(TIMELINE_QUEUE);
});

afterAll(async () => {
  await queue?.close();
});

/** A row as the routes answer it. */
type RowView = TimelineExecution & {
  origin: string;
  ownProject: boolean;
  request?: string;
  base?: { executionId: string; request: string };
  source?: { executionId: string; request: string; base?: { executionId: string; request: string } };
  export?: { executionId: string; status: string } | null;
  resultAssetId: string | null;
};

/** A list page. */
interface Page { rows: RowView[]; nextCursor: string | null; totals: { done: number; inProgress: number } }

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
 * Accept and read the row the answer carries, checking its status.
 * @param cookie - Who asks.
 * @param body - The body.
 * @param status - The status expected.
 * @returns The row view.
 */
async function acceptRow(cookie: string, body: Record<string, unknown>, status: number): Promise<RowView> {
  const res = await accept(cookie, body);
  expect(res.status, await res.clone().text()).toBe(status);
  const { data } = (await res.json()) as { data: RowView };
  expect(WebAnimationRowViewSchema.safeParse(data).success).toBe(true);
  return data;
}

/**
 * A create body sent from a Motion Space.
 * @param fx - The Project and Space.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function createBody(fx: ProjectFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: fx.projectId, spaceId: fx.spaceId, actionId: crypto.randomUUID(), kind: "web_animation_create",
    prompt: "A logo reveal", engine: "deepseek", aspect: "16:9", durationSeconds: 4, ...overrides,
  };
}

/**
 * A modify body.
 * @param fx - The Project and Space.
 * @param baseSourceVersionId - The result it starts from.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function modifyBody(fx: ProjectFixture, baseSourceVersionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: fx.projectId, spaceId: fx.spaceId, actionId: crypto.randomUUID(), kind: "web_animation_modify",
    baseSourceVersionId, instruction: "Make it slower", engine: "deepseek", aspect: "9:16", durationSeconds: 6, ...overrides,
  };
}

/**
 * An export body.
 * @param fx - The Project and Space.
 * @param sourceVersionId - The result to render.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function exportBody(fx: ProjectFixture, sourceVersionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectId: fx.projectId, spaceId: fx.spaceId, actionId: crypto.randomUUID(), kind: "web_animation_export", sourceVersionId, ...overrides };
}

/**
 * A finished create in a Project, granted to it.
 * @param fx - The Project.
 * @param spaceId - Its Space; the fixture's when omitted.
 * @param size - The result's frame and length.
 * @param size.width - Width.
 * @param size.height - Height.
 * @param size.durationFrames - Length in frames.
 * @returns The execution and its source version.
 */
async function finishedCreate(
  fx: ProjectFixture,
  spaceId = fx.spaceId,
  size = { width: 1920, height: 1080, durationFrames: 96 },
): Promise<{ execution: TimelineExecution; versionId: string }> {
  const execution = await insertExecution({ projectId: fx.projectId, spaceId, actorUserId: fx.editor.userId });
  await grant(execution.id, fx.projectId);
  const source = await succeed(execution, size);
  return { execution, versionId: source.id };
}

/**
 * Count a Project's executions of a kind.
 * @param projectId - The Project.
 * @param kind - The kind.
 * @returns The count.
 */
async function countOf(projectId: string, kind: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_executions WHERE project_id = ${projectId} AND kind = ${kind}`;
  return row!.count;
}

/**
 * Read a route as a member.
 * @param cookie - Who reads.
 * @param path - The path and query under /api/v1.
 * @returns The response.
 */
async function get(cookie: string, path: string): Promise<Response> {
  return app.request(`/api/v1${path}`, { headers: { Cookie: cookie } });
}

/**
 * Read a page of a list route.
 * @param cookie - Who reads.
 * @param path - The path and query under /api/v1.
 * @returns The page.
 */
async function page(cookie: string, path: string): Promise<Page> {
  const res = await get(cookie, path);
  expect(res.status, await res.clone().text()).toBe(200);
  const { data } = (await res.json()) as { data: Page };
  for (const row of data.rows) expect(WebAnimationRowViewSchema.safeParse(row).success, JSON.stringify(row)).toBe(true);
  return data;
}

/**
 * Set a row's creation time, so list order is fixed.
 * @param id - The execution.
 * @param minutesAgo - How long ago.
 */
async function createdAgo(id: string, minutesAgo: number): Promise<void> {
  await sql`UPDATE timeline_executions SET created_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${id}`;
  await sql`UPDATE timeline_execution_grants SET execution_created_at = now() - make_interval(mins => ${minutesAgo}) WHERE execution_id = ${id}`;
}

describe("POST /timeline/executions — create from a Motion Space", () => {
  it("starts the row queued with origin web_animation_space and the configured frame rate, and grants it", async () => {
    const fx = await seedProject();
    const body = createBody(fx);
    const data = await acceptRow(fx.editor.cookie, body, 201);
    expect(data).toMatchObject({
      kind: "web_animation_create", origin: "web_animation_space", status: "queued", engine: "deepseek",
      request: "A logo reveal", export: null, ownProject: true, resultAssetId: null,
    });
    expect(data.input).toEqual({ prompt: "A logo reveal", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: getTimelineConfig().web_animation.fps });
    expect(await grantedProjects(data.id)).toEqual([fx.projectId]);
    expect(await executionChangesFor(fx.projectId, fx.spaceId)).toEqual([{ type: "space-tasks-version", docName: webAnimationSpaceDocName(fx.projectId, fx.spaceId) }]);
    expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([]);
  });

  it("announces a cancel to the Motion Space's document and nowhere else", async () => {
    const fx = await seedProject();
    const data = await acceptRow(fx.editor.cookie, createBody(fx), 201);
    const before = (await executionChangesFor(fx.projectId, fx.spaceId)).length;
    const res = await app.request(`/api/v1/timeline/executions/${data.id}/cancel`, {
      method: "POST", headers: { Cookie: fx.editor.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: fx.projectId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await executionChangesFor(fx.projectId, fx.spaceId)).length).toBe(before + 1);
    expect(await signalsFor(fx.projectId, fx.spaceId)).toEqual([]);
  });

  it("adds the row's job to the timeline queue as soon as it is accepted, without waiting for the sweep", async () => {
    const fx = await seedProject();
    const data = await acceptRow(fx.editor.cookie, createBody(fx), 201);
    const job = await queue.getJob(data.id);
    expect(job?.data).toEqual({ executionId: data.id });
  });

  it.each([
    ["create", "prompt", "A logo fade"],
    ["create", "aspect", "9:16"],
    ["create", "durationSeconds", 5],
    ["modify", "instruction", "Make it faster"],
    ["modify", "aspect", "16:9"],
    ["modify", "durationSeconds", 4],
  ] as const)("answers a %s sent again as it was with its own row, and refuses it with another %s with 409", async (kind, field, value) => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const body = kind === "create" ? createBody(fx) : modifyBody(fx, versionId);
    const made = await acceptRow(fx.editor.cookie, body, 201);
    expect((await acceptRow(fx.editor.cookie, body, 200)).id).toBe(made.id);
    expect((await accept(fx.editor.cookie, { ...body, [field]: value })).status).toBe(409);
  });

  it("refuses the same action sent again as another kind with 409", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const body = createBody(fx);
    await acceptRow(fx.editor.cookie, body, 201);
    const res = await accept(fx.editor.cookie, exportBody(fx, versionId, { actionId: body.actionId }));
    expect(res.status).toBe(409);
  });
});

describe("POST /timeline/executions — modify", () => {
  it("freezes the base's frame rate, the new aspect and duration, and answers the base it started from", async () => {
    const fx = await seedProject();
    const { execution, versionId } = await finishedCreate(fx);
    const data = await acceptRow(fx.editor.cookie, modifyBody(fx, versionId), 201);
    expect(data).toMatchObject({
      kind: "web_animation_modify", origin: "web_animation_space", status: "queued", engine: "deepseek",
      request: "Make it slower", base: { executionId: execution.id, request: "A red square" }, export: null,
    });
    expect(data.input).toEqual({ baseSourceVersionId: versionId, instruction: "Make it slower", engine: "deepseek", aspect: "9:16", durationSeconds: 6, fps: { num: 24, den: 1 } });
  });

  it("freezes the instruction as extractPromptText leaves it", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const raw = "<p>Make it <b>slower</b><!-- x --></p>\u200B";
    const data = await acceptRow(fx.editor.cookie, modifyBody(fx, versionId, { instruction: raw }), 201);
    expect(data.input).toMatchObject({ instruction: extractPromptText(raw) });
  });

  it("refuses a base this Project holds no grant for with 404 and writes nothing", async () => {
    const fx = await seedProject();
    const other = await seedProject();
    const { versionId } = await finishedCreate(other);
    await expectNotFound(await accept(fx.editor.cookie, modifyBody(fx, versionId)));
    expect(await countOf(fx.projectId, "web_animation_modify")).toBe(0);
  });

  it("refuses a duration outside the configured range with 422 and writes nothing", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const { max } = getTimelineConfig().web_animation.duration_seconds;
    const res = await accept(fx.editor.cookie, modifyBody(fx, versionId, { durationSeconds: max + 1 }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 422, message: t("server.error.validation") } });
    expect(await countOf(fx.projectId, "web_animation_modify")).toBe(0);
  });
});

describe("POST /timeline/executions — export", () => {
  it("freezes the source's frame and length, opens the video upload its cover rides with, and answers its source", async () => {
    const fx = await seedProject();
    const { execution, versionId } = await finishedCreate(fx, fx.spaceId, { width: 1080, height: 1920, durationFrames: 144 });
    const data = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    expect(data).toMatchObject({
      kind: "web_animation_export", origin: "web_animation_space", status: "queued", engine: null,
      source: { executionId: execution.id, request: "A red square" }, resultAssetId: null,
    });
    expect(data).not.toHaveProperty("export");
    const input = data.input as { videoKey: string };
    expect(input).toEqual({ sourceVersionId: versionId, width: 1080, height: 1920, fps: { num: 24, den: 1 }, durationFrames: 144, videoKey: expect.stringMatching(/\.mp4$/) });
    // The cover is written beside the video at `coverKeyFor(videoKey)` and filed by the video's own report, as a
    // mini-tool's video output is (`container-outputs.service.ts`), so only the video holds a grant.
    const grants = await sql<{ storage_key: string; project_id: string; derived: boolean; asset_source: string; generation_task_id: string | null }[]>`
      SELECT storage_key, project_id, derived, asset_source, generation_task_id FROM upload_grants
      WHERE storage_key IN (${input.videoKey}, ${coverKeyFor(input.videoKey)})`;
    expect(grants).toEqual([{ storage_key: input.videoKey, project_id: fx.projectId, derived: true, asset_source: "ai", generation_task_id: null }]);
  });

  it("answers the live export of the same source in this Space instead of making a second", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const first = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    const again = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 200);
    expect(again.id).toBe(first.id);
    expect(await countOf(fx.projectId, "web_animation_export")).toBe(1);
  });

  it("answers the live export even with a zero balance and no storage left", async () => {
    const fx = await seedProject(1);
    const { versionId } = await finishedCreate(fx);
    const first = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    await sql`UPDATE credit_lots SET remaining_credits = 0 WHERE designated_studio_id = ${fx.studioId}`;
    await fillStorage(fx.studioId, fx.owner.userId);
    const again = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 200);
    expect(again.id).toBe(first.id);
  });

  it("makes a new export once the earlier one failed", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const first = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    await step(first.id, { type: "failure", fence: null, reason: "enqueue_failed" });
    const again = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    expect(again.id).not.toBe(first.id);
  });

  it("makes a separate export of the same source in another Motion Space", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const first = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    const elsewhere = await acceptRow(fx.editor.cookie, exportBody(fx, versionId, { spaceId: crypto.randomUUID() }), 201);
    expect(elsewhere.id).not.toBe(first.id);
  });

  it("refuses a new export with 507 when the studio has no storage left, writing nothing", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    await fillStorage(fx.studioId, fx.owner.userId);
    expect((await accept(fx.editor.cookie, exportBody(fx, versionId))).status).toBe(507);
    expect(await countOf(fx.projectId, "web_animation_export")).toBe(0);
  });

  it("refuses a new export with 402 on a zero balance, writing nothing", async () => {
    const fx = await seedProject(0);
    const { versionId } = await finishedCreate(fx);
    expect((await accept(fx.editor.cookie, exportBody(fx, versionId))).status).toBe(402);
    expect(await countOf(fx.projectId, "web_animation_export")).toBe(0);
  });

  it("answers the export that won a race of two, as the unique index decided", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: `${APP}-gate` } });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let written: () => void = () => {};
    const rowWritten = new Promise<void>((resolve) => { written = resolve; });
    const competitorId = crypto.randomUUID();
    const competitor = gate.begin(async (tx) => {
      await tx`
        INSERT INTO timeline_executions (id, project_id, space_id, actor_user_id, kind, action_id, input, input_hash, engine, status, origin, deadline_at)
        VALUES (${competitorId}, ${fx.projectId}, ${fx.spaceId}, ${fx.owner.userId}, 'web_animation_export', ${crypto.randomUUID()},
          ${tx.json({ sourceVersionId: versionId, width: 1920, height: 1080, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: "generated/race.mp4" })},
          'sha256:race', NULL, 'queued', 'web_animation_space', now() + interval '2 hours')
      `;
      await tx`INSERT INTO timeline_execution_grants (execution_id, project_id) VALUES (${competitorId}, ${fx.projectId})`;
      written();
      await held;
    });
    await Promise.race([rowWritten, competitor.then(() => { throw new Error("The competing export ended before writing its row"); })]);
    try {
      const pending = accept(fx.editor.cookie, exportBody(fx, versionId));
      let blocked = false;
      const answeredFirst = pending.then((res) => { if (!blocked) throw new Error(`Answered ${res.status} before waiting on the insert`); });
      await Promise.race([waitUntilBlockedOn(sql, ["timeline_executions", "insert"], 1).then(() => { blocked = true; }), answeredFirst]);
      release();
      await competitor;
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { data: RowView }).data.id).toBe(competitorId);
    } finally {
      release();
      await gate.end({ timeout: 1 });
    }
    expect(await countOf(fx.projectId, "web_animation_export")).toBe(1);
  });

  it("answers, in a duplicated Project, the export its source made in the same Space", async () => {
    const fx = await seedProject();
    const copy = await seedProject();
    const { execution, versionId } = await finishedCreate(fx);
    const made = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    await grant(execution.id, copy.projectId);
    await grant(made.id, copy.projectId);
    const again = await acceptRow(copy.editor.cookie, exportBody({ ...copy, spaceId: fx.spaceId }, versionId), 200);
    expect(again).toMatchObject({ id: made.id, ownProject: false });
  });
});

describe("GET /timeline/space-executions", () => {
  it("lists a Space's granted rows of every kind in a group, newest first, each with the export it already has", async () => {
    const fx = await seedProject();
    const { execution: created, versionId } = await finishedCreate(fx);
    const exported = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_export", input: { sourceVersionId: versionId, width: 1920, height: 1080, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: "generated/x.mp4" } });
    await grant(exported.id, fx.projectId);
    const running = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId });
    await grant(running.id, fx.projectId);
    const elsewhere = await insertExecution({ projectId: fx.projectId, spaceId: crypto.randomUUID(), actorUserId: fx.editor.userId });
    await grant(elsewhere.id, fx.projectId);
    const ungranted = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId });
    await createdAgo(created.id, 3);
    await createdAgo(exported.id, 2);
    await createdAgo(running.id, 1);
    await createdAgo(ungranted.id, 0);

    const inProgress = await page(fx.viewer.cookie, `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=space&group=running`);
    expect(inProgress.rows.map((row) => row.id)).toEqual([running.id, exported.id]);
    expect(inProgress.totals).toEqual({ done: 1, inProgress: 2 });
    const done = await page(fx.viewer.cookie, `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=space&group=done`);
    expect(done.rows.map((row) => row.id)).toEqual([created.id]);
    expect(done.rows[0]).toMatchObject({ request: "A red square", export: { executionId: exported.id, status: "queued" }, ownProject: true });
    expect(done.nextCursor).toBeNull();
  });

  it.each([
    ["an id of 36 dashes", ["2026-11-15T08:00:00.123456Z", "-".repeat(36)]],
    ["an id with hyphens out of place", ["2026-11-15T08:00:00.123456Z", "0123456789abcdef0123456789abcdef----"]],
    ["a bare year", ["2026", "00000000-0000-4000-8000-000000000001"]],
    ["a date in another form", ["1/2/3", "00000000-0000-4000-8000-000000000001"]],
    ["a day the month does not have", ["2026-02-30T08:00:00.123456Z", "00000000-0000-4000-8000-000000000001"]],
  ])("refuses a cursor with %s as a validation error, not a server error", async (_name, carried) => {
    const fx = await seedProject();
    const cursor = Buffer.from(JSON.stringify(carried), "utf8").toString("base64url");
    const res = await get(fx.viewer.cookie, `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=space&group=done&cursor=${cursor}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 422, message: t("server.error.validation") } });
  });

  it("counts in each total exactly the rows its pages hold, in every scope", async () => {
    const fx = await seedProject();
    const { versionId } = await finishedCreate(fx);
    const otherSpace = crypto.randomUUID();
    for (const origin of ["web_animation_space", "timeline"] as const) {
      const spaceId = origin === "timeline" ? otherSpace : fx.spaceId;
      const queued = await insertExecution({ projectId: fx.projectId, spaceId, actorUserId: fx.editor.userId, origin });
      const failed = await insertExecution({ projectId: fx.projectId, spaceId, actorUserId: fx.editor.userId, origin });
      await grant(queued.id, fx.projectId);
      await grant(failed.id, fx.projectId);
      await step(failed.id, { type: "failure", fence: null, reason: "enqueue_failed" });
      await finishedCreate(fx, spaceId);
    }
    await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    /**
     * Read every page of a list.
     * @param path - The list without a cursor.
     * @returns Its rows and the totals of its first page.
     */
    const readAll = async (path: string): Promise<{ ids: string[]; totals: Page["totals"] }> => {
      const first = await page(fx.viewer.cookie, `${path}&limit=1`);
      const ids = first.rows.map((row) => row.id);
      for (let cursor = first.nextCursor; cursor !== null;) {
        const next = await page(fx.viewer.cookie, `${path}&limit=1&cursor=${encodeURIComponent(cursor)}`);
        ids.push(...next.rows.map((row) => row.id));
        cursor = next.nextCursor;
      }
      return { ids, totals: first.totals };
    };
    for (const scope of ["space", "timeline"]) {
      const path = `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=${scope}`;
      const done = await readAll(`${path}&group=done`);
      const running = await readAll(`${path}&group=running`);
      expect(done.totals, scope).toEqual({ done: done.ids.length, inProgress: running.ids.length });
      expect(done.ids.length * running.ids.length, scope).toBeGreaterThan(0);
    }
    const results = await readAll(`/timeline/results?projectId=${fx.projectId}`);
    expect(results.totals.done + results.totals.inProgress).toBe(results.ids.length);
  });

  it("pages by creation time and id without skipping rows that share a microsecond", async () => {
    const fx = await seedProject();
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const row = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId });
      await grant(row.id, fx.projectId);
      rows.push(row);
    }
    await sql`UPDATE timeline_executions SET created_at = '2026-11-15 08:00:00.123456+00' WHERE id = ANY(${rows.map((row) => row.id)}::uuid[])`;
    const base = `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=space&group=running&limit=2`;
    const first = await page(fx.viewer.cookie, base);
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(fx.viewer.cookie, `${base}&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.rows, ...second.rows].map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it("lists, under scope=timeline, the Timeline-made creates this Project holds, whichever Space made them", async () => {
    const fx = await seedProject();
    const timelineSpace = crypto.randomUUID();
    const old = await insertExecution({ projectId: fx.projectId, spaceId: timelineSpace, actorUserId: fx.editor.userId, origin: "timeline" });
    await grant(old.id, fx.projectId);
    await succeed(old);
    const motion = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId });
    await grant(motion.id, fx.projectId);
    await succeed(motion);
    const listed = await page(fx.viewer.cookie, `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=timeline&group=done`);
    expect(listed.rows.map((row) => row.id)).toEqual([old.id]);
    expect(listed.rows[0]).toMatchObject({ origin: "timeline", spaceId: timelineSpace, export: null });
    expect(listed.totals).toEqual({ done: 1, inProgress: 0 });
  });

  it("shows a duplicated Project the rows its source made in the Space, not as its own", async () => {
    const fx = await seedProject();
    const copy = await seedProject();
    const { execution } = await finishedCreate(fx);
    await grant(execution.id, copy.projectId);
    const listed = await page(copy.viewer.cookie, `/timeline/space-executions?projectId=${copy.projectId}&spaceId=${fx.spaceId}&scope=space&group=done`);
    expect(listed.rows).toEqual([expect.objectContaining({ id: execution.id, ownProject: false })]);
  });

  it("answers an outsider with 404", async () => {
    const fx = await seedProject();
    const outsider = await seedUser();
    await expectNotFound(await get(outsider.cookie, `/timeline/space-executions?projectId=${fx.projectId}&spaceId=${fx.spaceId}&scope=space&group=done`));
  });
});

describe("GET /timeline/results", () => {
  it("lists the creates and modifications that are finished or still running, newest first, without exports or failures", async () => {
    const fx = await seedProject();
    const { execution: created, versionId } = await finishedCreate(fx);
    const modified = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_modify", input: { baseSourceVersionId: versionId, instruction: "Slower", engine: "deepseek", aspect: "9:16", durationSeconds: 6, fps: { num: 24, den: 1 } } });
    await grant(modified.id, fx.projectId);
    const failed = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId });
    await grant(failed.id, fx.projectId);
    await step(failed.id, { type: "failure", fence: null, reason: "enqueue_failed" });
    const exported = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_export", input: { sourceVersionId: versionId, width: 1920, height: 1080, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: "generated/y.mp4" } });
    await grant(exported.id, fx.projectId);
    await createdAgo(created.id, 2);
    await createdAgo(modified.id, 1);
    const listed = await page(fx.viewer.cookie, `/timeline/results?projectId=${fx.projectId}`);
    expect(listed.rows.map((row) => row.id)).toEqual([modified.id, created.id]);
    expect(listed.rows[0]).toMatchObject({ base: { executionId: created.id, request: "A red square" }, request: "Slower" });
    for (const row of listed.rows) expect(row).not.toHaveProperty("export");
  });
});

describe("GET /timeline/executions/:id", () => {
  it("answers one granted row with the export it has in the asking Space", async () => {
    const fx = await seedProject();
    const { execution, versionId } = await finishedCreate(fx);
    const made = await acceptRow(fx.editor.cookie, exportBody(fx, versionId), 201);
    const res = await get(fx.viewer.cookie, `/timeline/executions/${execution.id}?projectId=${fx.projectId}&spaceId=${fx.spaceId}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as { data: RowView };
    expect(data).toMatchObject({ id: execution.id, export: { executionId: made.id, status: "queued" } });
  });

  it("reads two generations of a long modification chain, whatever its length", async () => {
    const fx = await seedProject();
    const { versionId: first } = await finishedCreate(fx);
    let baseVersion = first;
    const chain: TimelineExecution[] = [];
    for (const instruction of ["Slower", "Bluer", "Bigger", "Louder"]) {
      const modified = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_modify", input: { baseSourceVersionId: baseVersion, instruction, engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } } });
      await grant(modified.id, fx.projectId);
      baseVersion = (await succeed(modified)).id;
      chain.push(modified);
    }
    const exported = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_export", input: { sourceVersionId: baseVersion, width: 1920, height: 1080, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: "generated/chain.mp4" } });
    await grant(exported.id, fx.projectId);
    versionReads.count = 0;
    const res = await get(fx.viewer.cookie, `/timeline/executions/${exported.id}?projectId=${fx.projectId}&spaceId=${fx.spaceId}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as { data: RowView };
    expect(data.source).toEqual({ executionId: chain[3]!.id, request: "Louder", base: { executionId: chain[2]!.id, request: "Bigger" } });
    expect(versionReads.count).toBe(2);
  });

  it("answers a row this Project holds no grant for with 404", async () => {
    const fx = await seedProject();
    const other = await seedProject();
    const { execution } = await finishedCreate(other);
    await expectNotFound(await get(fx.viewer.cookie, `/timeline/executions/${execution.id}?projectId=${fx.projectId}&spaceId=${fx.spaceId}`));
  });
});

describe("GET /timeline/web-sources — modifications and exports", () => {
  it("answers a modification's base and leaves an export out", async () => {
    const fx = await seedProject();
    const { execution: created, versionId } = await finishedCreate(fx);
    const modified = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_modify", input: { baseSourceVersionId: versionId, instruction: "Slower", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } } });
    await grant(modified.id, fx.projectId);
    const modifiedVersion = await succeed(modified);
    const exported = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId, kind: "web_animation_export", input: { sourceVersionId: versionId, width: 1920, height: 1080, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: "generated/z.mp4" } });
    await grant(exported.id, fx.projectId);
    const res = await get(fx.viewer.cookie, `/timeline/web-sources?projectId=${fx.projectId}&sourceIds=${modifiedVersion.id}&executionIds=${modified.id},${exported.id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { sources: Record<string, unknown>; executions: Record<string, unknown> } };
    expect(data.sources[modifiedVersion.id]).toMatchObject({ kind: "web_animation_modify", request: "Slower", base: { executionId: created.id, request: "A red square" } });
    expect(Object.keys(data.executions)).toEqual([modified.id]);
  });
});

describe("POST /timeline/executions/:id/cancel — a duplicated Project", () => {
  it("refuses to cancel a row its source Project owns with 403 and leaves it running", async () => {
    const fx = await seedProject();
    const copy = await seedProject();
    const row = await insertExecution({ projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.editor.userId });
    await grant(row.id, fx.projectId);
    await grant(row.id, copy.projectId);
    await step(row.id, { type: "claim" });
    const res = await app.request(`/api/v1/timeline/executions/${row.id}/cancel`, {
      method: "POST",
      headers: { Cookie: copy.editor.cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ projectId: copy.projectId }),
    });
    expect(res.status).toBe(403);
    expect((await timelineExecutionRepo.findById(row.id))?.status).toBe("running");
  });
});
