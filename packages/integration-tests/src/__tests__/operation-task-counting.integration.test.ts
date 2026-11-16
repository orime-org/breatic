// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How a generation, a server mini-tool, an understanding, a transcription and
 * a Timeline execution are counted, across the server that admits them and
 * the worker that ends them (inner#1968, test spec area B: B-01 to B-11,
 * B-34, B-35, B-40, B-45, B-47 to B-50).
 *
 * The server's real routes admit each run under `task:<taskId>`; the worker's
 * own success and failure calls end it (`taskService.markCompletedAndBill`,
 * `finishFailedRun`, the Timeline `move`). Counting happens in the commit
 * that records the success; a terminal failure releases the row. A run that
 * uses derived images (crops, drawn masks) claims their deferred rows when it
 * is admitted and uses them up when it is counted. Real Postgres, Redis and
 * BullMQ queues, payments on; only the ingest Worker's open is replaced.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("@server/__tests__/helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import { canvasSpaceDocName } from "@breatic/shared";
import postgres from "postgres";
import type { createApp } from "@server/app.js";
import { getStreamRedis, initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import { creditHoldService, taskService } from "@breatic/domain";
import { finishFailedRun } from "@worker/handlers/dispatch.js";
import { move } from "@worker/handlers/timeline/timeline-transition.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import * as memoryService from "@server/modules/memory/memory.service.js";
import {
  PAYMENTS_ON,
  captureLogs,
  derivedUpload,
  admit,
  ledgerRow,
  ledgerRows,
  request,
  seedAccount,
  seedAsset,
  seedMember,
  used,
  type Account,
  type Actor,
} from "@server/__tests__/integration/operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

/** An image model that takes up to 13 references in `images`. */
const EDIT_MODEL = "gpt-image-2.5-sunburst-edit";

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 5, prepare: false, connection: { application_name: "operation-task-counting-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * Send a run request and read the task id it answers with.
 * @param who - Who sends.
 * @param path - The path under /api/v1.
 * @param body - The request.
 * @returns The task id.
 */
async function start(who: Actor, path: string, body: Record<string, unknown>): Promise<string> {
  const res = await request(app, who.cookie, "POST", path, body);
  expect(res.status, await res.clone().text()).toBe(201);
  const data = ((await res.json()) as { data: Record<string, unknown> }).data;
  return String(data.task_id ?? data.taskId);
}

/**
 * Start a canvas generation.
 * @param a - Where.
 * @param images - Reference image URLs, when the run takes any.
 * @param who - Who starts it; the account by default.
 * @returns The task id.
 */
function generate(a: Account, images: string[] = [], who: Actor = a): Promise<string> {
  const at = { project_id: a.projectId, space_id: a.spaceId, source: "task", mode: "append" };
  return images.length === 0
    ? start(who, "/canvas/tasks", { ...at, task_type: "image", model: "flux-schnell", params: { prompt: "a cat" } })
    : start(who, "/canvas/tasks", { ...at, task_type: "image", model: EDIT_MODEL, params: { prompt: "a cat", images } });
}

/**
 * The worker's success: the attempt that wins marks the task completed.
 * @param taskId - The task.
 * @param credits - What the run cost.
 */
async function succeed(taskId: string, credits = 0): Promise<void> {
  await taskService.markCompletedAndBill(taskId, { url: "https://assets.example.test/out.png" }, credits, 1000, null);
}

/**
 * The worker's failure of one attempt.
 * @param a - The account.
 * @param taskId - The task.
 * @param settles - Whether no retry is left.
 */
async function fail(a: Account, taskId: string, settles: boolean): Promise<void> {
  await finishFailedRun({
    streamRedis: getStreamRedis(),
    taskId,
    projectId: a.projectId,
    spaceId: a.spaceId,
    canvasDocName: null,
    nodeIds: [],
    userId: a.userId,
    model: "flux-schnell",
    params: {},
    source: undefined,
    toolId: undefined,
    errorMessage: "upstream failed",
    settles,
  });
}

/** A grid run's request. */
function gridBody(a: Account, rows: number, cols: number, source: string): Record<string, unknown> {
  return {
    project_id: a.projectId,
    space_id: a.spaceId,
    tool: "image.grid",
    node_ids: Array.from({ length: rows * cols }, () => crypto.randomUUID()),
    source: { url: source },
    params: { rows, cols, skip: [] },
    slots: {},
  };
}

describe("B.1 a generation is one operation, counted when it succeeds", () => {
  it("B-01 a canvas generation's row is counted in the commit that completes it, into this period's allowance", async () => {
    const a = await seedAccount(sql);
    const taskId = await generate(a);
    expect(await ledgerRow(sql, `task:${taskId}`)).toMatchObject({ status: "reserved", kind: "generation" });
    await succeed(taskId);
    const row = await ledgerRow(sql, `task:${taskId}`);
    expect(row).toMatchObject({
      kind: "generation",
      account_user_id: a.userId,
      studio_id: a.studioId,
      project_id: a.projectId,
      actor_user_id: a.userId,
      status: "counted",
      admitted_as: "covered",
      slot: "allowance",
      charge_request_id: null,
    });
    expect(row!.period_start?.toISOString()).toBe(a.periodStart.toISOString());
    expect(row!.counted_at).not.toBeNull();
    expect(await used(a)).toBe(1);
  });

  it("B-02 a 3D generation is counted the same way", async () => {
    const a = await seedAccount(sql);
    const taskId = await start(a, `/projects/${a.projectId}/three-d/${a.spaceId}/generations`, {
      mode: "t23d", model: "tripo-h3.1-t23d", prompt: "a red barn lamp", params: { texture: true }, origin: "space",
    });
    await succeed(taskId);
    expect(await ledgerRow(sql, `task:${taskId}`)).toMatchObject({ kind: "generation", status: "counted" });
    expect(await used(a)).toBe(1);
  });

  it("B-03 a retried attempt that then succeeds still leaves one row, counted once", async () => {
    const a = await seedAccount(sql);
    const taskId = await generate(a);
    await fail(a, taskId, false);
    await taskService.markRunning(taskId, `job-${taskId}`, new Date());
    await succeed(taskId);
    await succeed(taskId);
    const rows = await sql`select status from operation_ledger where operation_key = ${`task:${taskId}`}`;
    expect(rows).toEqual([{ status: "counted" }]);
    expect(await used(a)).toBe(1);
  });

  it("B-04 a run that fails for good releases its row and asks for no overage", async () => {
    const a = await seedAccount(sql);
    const taskId = await generate(a);
    await fail(a, taskId, true);
    const row = await ledgerRow(sql, `task:${taskId}`);
    expect(row?.status).toBe("released");
    expect(row?.released_at).not.toBeNull();
    expect(row?.release_reason).not.toBeNull();
    expect(await used(a)).toBe(0);
    expect(await sql`select 1 from credit_charge_requests where reference_id = ${`task:${taskId}`} and kind = 'operation_overage'`).toEqual([]);
  });

  it("B-05 a run completed while waiting on its cost is counted in the same commit, and a failing count rolls the completion back", async () => {
    const a = await seedAccount(sql);
    const done = await generate(a);
    await taskService.markCompletedAndCount(done, { url: "https://assets.example.test/out.png" }, 1000);
    const [completed] = await sql<{ status: string }[]>`select status from tasks where id = ${done}`;
    expect(completed?.status).toBe("completed");
    expect((await ledgerRow(sql, `task:${done}`))?.status).toBe("counted");

    // The count fails: the task is not completed either.
    const broken = await generate(a);
    const fn = `fail_count_${broken.replace(/-/g, "")}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'injected count failure'; end $$`);
    await sql.unsafe(`create trigger ${fn} before update on operation_ledger for each row when (old.operation_key = 'task:${broken}') execute function ${fn}()`);
    try {
      await expect(taskService.markCompletedAndCount(broken, { url: "https://assets.example.test/out.png" }, 1000)).rejects.toThrow();
    } finally {
      await sql.unsafe(`drop trigger ${fn} on operation_ledger`);
      await sql.unsafe(`drop function ${fn}()`);
    }
    const [task] = await sql<{ status: string }[]>`select status from tasks where id = ${broken}`;
    expect(task?.status).not.toBe("completed");
    expect((await ledgerRow(sql, `task:${broken}`))?.status).toBe("reserved");
  });

  it("B-06 billing that run later leaves its counted row as it was", async () => {
    const a = await seedAccount(sql);
    const taskId = await generate(a);
    await taskService.markCompletedAndCount(taskId, { url: "https://assets.example.test/out.png" }, 1000);
    const before = await ledgerRow(sql, `task:${taskId}`);
    await taskService.markBilledAndCharge(taskId, 0.2, { actorUserId: a.userId, projectId: a.projectId, amount: 0.2 });
    expect(await ledgerRow(sql, `task:${taskId}`)).toEqual(before);
    expect(await used(a)).toBe(1);
  });
});

describe("B.1 server mini-tools, understanding and transcription", () => {
  it("B-07 one mini-tool run onto several result nodes is one operation", async () => {
    // No server tool has three outputs before the grid moves to the server;
    // the two-output separation stands in for "several result nodes".
    const a = await seedAccount(sql);
    const nodeIds = [crypto.randomUUID(), crypto.randomUUID()];
    const taskId = await start(a, "/mini-tools", {
      project_id: a.projectId, space_id: a.spaceId, tool: "audio.separate", node_ids: nodeIds,
      source: { url: "https://assets.example.test/song.m4a" }, params: {}, slots: {},
    });
    const rows = await sql<{ task_id: string }[]>`select task_id from node_tasks where node_id in ${sql(nodeIds)}`;
    expect(rows.map((r) => r.task_id)).toEqual([taskId, taskId]);
    await succeed(taskId);
    expect(await ledgerRow(sql, `task:${taskId}`)).toMatchObject({ kind: "tool_run", status: "counted" });
    expect(await used(a)).toBe(1);
  });

  it("B-08 an understanding and a transcription are one operation each", async () => {
    const a = await seedAccount(sql);
    const at = { project_id: a.projectId, space_id: a.spaceId };
    const read = await start(a, "/canvas/understand", { ...at, source_type: "image", source_url: "https://assets.example.test/a.png", node_ids: [crypto.randomUUID()] });
    const heard = await start(a, "/canvas/transcribe", { ...at, source_type: "audio", source_url: "https://assets.example.test/a.m4a", node_ids: [crypto.randomUUID()], keep_fillers: true });
    await succeed(read);
    await succeed(heard);
    for (const id of [read, heard]) expect(await ledgerRow(sql, `task:${id}`)).toMatchObject({ kind: "tool_run", status: "counted" });
    expect(await used(a)).toBe(2);
  });

  it("B-09 an 8x8 grid is one run on the server: one operation, 64 rows of one task, no uploads and nothing charged", async () => {
    const a = await seedAccount(sql);
    const body = gridBody(a, 8, 8, (await seedAsset(sql, a.studioId, a.userId)).url);
    const taskId = await start(a, "/mini-tools", body);
    const rows = await sql<{ task_id: string }[]>`select task_id from node_tasks where node_id in ${sql(body.node_ids as string[])}`;
    expect(rows).toHaveLength(64);
    expect(new Set(rows.map((r) => r.task_id))).toEqual(new Set([taskId]));
    await succeed(taskId);
    expect(await ledgerRow(sql, `task:${taskId}`)).toMatchObject({ kind: "tool_run", status: "counted" });
    expect(await used(a)).toBe(1);
    expect((await ledgerRows(sql, a)).filter((r) => r.kind === "upload")).toEqual([]);
    expect(await sql`select 1 from upload_grants where user_id = ${a.userId} and operation_key is not null`).toEqual([]);
    expect(await sql`select 1 from credit_charge_requests where reference_id = ${taskId}`).toEqual([]);
  });

  it("B-10 a grid runs with no credits at all, charges nothing and counts once", async () => {
    const a = await seedAccount(sql, { credits: 0 });
    const taskId = await start(a, "/mini-tools", gridBody(a, 2, 2, (await seedAsset(sql, a.studioId, a.userId)).url));
    await succeed(taskId);
    expect((await ledgerRow(sql, `task:${taskId}`))?.status).toBe("counted");
    expect(Number((await creditHoldService.getCreditPosition(a.studioId)).spendable)).toBe(0);
  });

  it("B-11 a grid runs in a studio that owes 3, which still owes 3 after", async () => {
    const a = await seedAccount(sql, { credits: 0, debt: 3 });
    const taskId = await start(a, "/mini-tools", gridBody(a, 2, 2, (await seedAsset(sql, a.studioId, a.userId)).url));
    await succeed(taskId);
    expect((await ledgerRow(sql, `task:${taskId}`))?.status).toBe("counted");
    expect(Number((await creditHoldService.getCreditPosition(a.studioId)).spendable)).toBeCloseTo(-3, 6);
  });
});

describe("B-34 a Timeline execution counts only when it succeeds", () => {
  /**
   * An accepted execution, admitted the way acceptance admits it, moved on to running.
   * @param a - The account.
   * @returns The execution and its ledger key.
   */
  async function running(a: Account): Promise<{ row: { id: string; projectId: string; spaceId: string; fence: string | null }; key: string }> {
    const inserted = await timelineExecutionRepo.insert({
      projectId: a.projectId, spaceId: a.spaceId, actorUserId: a.userId, kind: "web_animation_create", engine: "deepseek",
      actionId: crypto.randomUUID(), input: { prompt: "A red square slides in" }, inputHash: `sha256:${crypto.randomUUID()}`,
      deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    const key = `timeline:${inserted!.id}`;
    await admit(a, "timeline", [], key);
    await timelineExecutionRepo.transition({ id: inserted!.id, event: { type: "land", inputHash: inserted!.inputHash } });
    const claimed = await timelineExecutionRepo.transition({ id: inserted!.id, event: { type: "claim" } });
    return { row: claimed.row, key };
  }

  it("succeeded is counted; cancelled after a late success, failed and expired are released", async () => {
    const a = await seedAccount(sql);
    const ok = await running(a);
    await move(ok.row, { type: "success", fence: ok.row.fence, resultSourceVersionId: crypto.randomUUID() });

    const cancelling = await running(a);
    await move(cancelling.row, { type: "cancel" });
    await move(cancelling.row, { type: "success", fence: cancelling.row.fence, resultSourceVersionId: crypto.randomUUID() });

    const failed = await running(a);
    await move(failed.row, { type: "failure", fence: failed.row.fence, reason: "renderer failed" });

    const expired = await running(a);
    await sql`update timeline_executions set deadline_at = now() - interval '1 second' where id = ${expired.row.id}`;
    await move(expired.row, { type: "deadline" });

    expect((await ledgerRow(sql, ok.key))?.status).toBe("counted");
    for (const ended of [cancelling, failed, expired]) expect((await ledgerRow(sql, ended.key))?.status).toBe("released");
    expect(await used(a)).toBe(1);
  });
});

describe("B.2 what is never counted", () => {
  it("B-35 editing a Space's document writes no ledger row", async () => {
    const a = await seedAccount(sql);
    const Y = await import("yjs");
    const doc = new Y.Doc();
    doc.getMap("nodes").set(crypto.randomUUID(), new Y.Map());
    await yjsRepo.upsertDocData(canvasSpaceDocName(a.projectId, a.spaceId), Y.encodeStateAsUpdate(doc));
    doc.destroy();
    expect(await ledgerRows(sql, a)).toEqual([]);
  });

  it("B-40 a generation's own files and a memory fold add no row beside the generation's own", async () => {
    const a = await seedAccount(sql);
    const taskId = await generate(a);
    await succeed(taskId);
    const [chat] = await sql<{ id: string }[]>`insert into conversations(user_id, project_id) values (${a.userId}, ${a.projectId}) returning id`;
    await memoryService.commitConsolidation({
      userId: a.userId, projectId: a.projectId, conversationId: chat!.id, shown: [], watermarkBefore: 0, newWatermark: 2, progress: "folded",
      operations: [{ op: "add", scope: "project", title: "Folded", content: "automatic fold" }],
    });
    expect((await ledgerRows(sql, a)).map((r) => r.operation_key)).toEqual([`task:${taskId}`]);
    expect(await sql`select 1 from upload_grants where user_id = ${a.userId} and operation_key is not null`).toEqual([]);
  });
});

describe("B.3 derived images are used up by the run that takes them", () => {
  it("B-45 a generation with three crops counts once and uses all three up", async () => {
    const a = await seedAccount(sql);
    const logs = captureLogs("operation-task-b45");
    const crops = [await derivedUpload(app, sql, a), await derivedUpload(app, sql, a), await derivedUpload(app, sql, a)];
    const taskId = await generate(a, crops.map((c) => c.url));
    await succeed(taskId);
    const row = await ledgerRow(sql, `task:${taskId}`);
    expect(row?.status).toBe("counted");
    expect(row?.input_asset_ids).toEqual(expect.arrayContaining(crops.map((c) => c.assetId)));
    for (const crop of crops) expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    expect(await used(a)).toBe(1);
    expect(logs("operation_derived_absorbed").filter((line) => JSON.stringify(line).includes(`task:${taskId}`))).toHaveLength(3);
  });

  it("B-47 the expand inputs and a drawn mask are used up by their runs; the plain source upload is untouched", async () => {
    const a = await seedAccount(sql);
    const source = await seedAsset(sql, a.studioId, a.userId);
    const padded = await derivedUpload(app, sql, a);
    const expandMask = await derivedUpload(app, sql, a);
    const eraseMask = await derivedUpload(app, sql, a);
    const at = { project_id: a.projectId, space_id: a.spaceId, source: { url: source.url }, slots: {}, params: {} };
    const expand = await start(a, "/mini-tools", { ...at, tool: "image.expand", node_ids: [crypto.randomUUID()], prompt: "", expand: { image: padded.url, mask: expandMask.url } });
    const erase = await start(a, "/mini-tools", { ...at, tool: "image.erase", node_ids: [crypto.randomUUID()], drawing: { mask: eraseMask.url } });
    await succeed(expand);
    await succeed(erase);
    for (const d of [padded, expandMask, eraseMask]) expect(await ledgerRow(sql, d.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    expect(await sql`select 1 from operation_ledger where asset_id = ${source.id}`).toEqual([]);
    expect(await used(a)).toBe(2);
  });

  it("B-48 a crop one member made is used up by another member's generation in the same studio", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const crop = await derivedUpload(app, sql, a);
    const taskId = await generate(a, [crop.url], y);
    await succeed(taskId);
    expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    expect(await used(a)).toBe(1);
  });

  it("B-49 a claiming run that fails gives its crop back; the next run that succeeds uses it up", async () => {
    const a = await seedAccount(sql);
    const crop = await derivedUpload(app, sql, a);
    const g1 = await generate(a, [crop.url]);
    expect((await ledgerRow(sql, crop.key))?.absorbed_by).toBe(`task:${g1}`);
    await fail(a, g1, true);
    expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "deferred", absorbed_by: null });
    const g2 = await generate(a, [crop.url]);
    await succeed(g2);
    expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    expect(await used(a)).toBe(1);
  });

  it("B-50 a crop claimed by a run still going is used up by a second run that succeeds first, and the first leaves it alone", async () => {
    const a = await seedAccount(sql);
    const crop = await derivedUpload(app, sql, a);
    const g1 = await generate(a, [crop.url]);
    const g2 = await generate(a, [crop.url]);
    expect((await ledgerRow(sql, crop.key))?.absorbed_by).toBe(`task:${g1}`);
    expect((await ledgerRow(sql, `task:${g2}`))?.input_asset_ids).toContain(crop.assetId);
    await succeed(g2);
    const usedUp = await ledgerRow(sql, crop.key);
    expect(usedUp).toMatchObject({ status: "released", release_reason: "absorbed" });
    await succeed(g1);
    expect(await ledgerRow(sql, crop.key)).toEqual(usedUp);
    expect(await used(a)).toBe(2);
  });
});

