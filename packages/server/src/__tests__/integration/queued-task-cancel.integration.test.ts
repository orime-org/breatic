// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Cancelling a task that waits for a free slot (inner#1968, test spec area G:
 * G-25 to G-29, G-36, and the F8 cancel cells G-40 to G-42; invariant K5;
 * 5.1 resolution #14). Real Postgres and
 * Redis through the real Hono app, payments on.
 *
 * `POST /api/v1/canvas/tasks/:taskId/cancel` is allowed to whoever may
 * `DELETE /canvas/node-tasks/:taskId` (a project editor, the project read from
 * the task row). Under the person's `running-tasks:<user_id>` lock it moves the
 * task `pending → cancelled` and, in the same transaction, releases the credit
 * hold; after that commit its node task rows end with the failure reason
 * `cancelled`; it
 * answers `200 { data: { cancelled: true, counts } }`, `counts` being the
 * `NodeTaskCounts` of the node whose row was named (null when the task's own
 * id was named, or for a 3D Space's own row). A task that already
 * started answers 409 and goes on. A Timeline execution's cancel runs through
 * `timelineExecutionRepo.transition` and holds no credits, so it touches no hold.
 *
 * The account is a pro admin of a team studio (five running tasks), so a fresh
 * task stays `pending` here: no worker runs in this suite.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { env, getNodeTaskConfig, getStreamRedis, initCore, loadLocales, reportGraceMs, taskEventsStreamKey, timelineExecutionRepo } from "@breatic/core";
import { nodeTaskService, runningSlotService } from "@breatic/domain";
import { canvasSpaceDocName, spaceTasksChangedChannel, TASK_FAILURE_REASONS } from "@breatic/shared";
import * as timelineExecutionService from "@server/modules/timeline/timeline-execution.service.js";
import { PAYMENTS_ON, request, seedAccount, seedMember, type Account, type Actor } from "./paid-account-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "queued-task-cancel-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * Start a canvas generation that writes over one node, so it opens a node task row.
 * @param a - Where.
 * @param who - Who starts it.
 * @param nodeId - The node it writes over.
 * @returns The task id and its node.
 */
async function generate(a: Account, who: Actor = a, nodeId: string = crypto.randomUUID()): Promise<{ taskId: string; nodeId: string }> {
  const res = await request(app, who.cookie, "POST", "/canvas/tasks", {
    project_id: a.projectId,
    space_id: a.spaceId,
    source: "task",
    mode: "overwrite",
    target_node_id: nodeId,
    task_type: "image",
    model: "flux-schnell",
    params: { prompt: "a cat" },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { taskId: ((await res.json()) as { data: { task_id: string } }).data.task_id, nodeId };
}

/**
 * Ask to cancel a task.
 * @param who - Who asks.
 * @param taskId - The task.
 * @returns The response.
 */
function cancel(who: Actor, taskId: string): Promise<Response> {
  return request(app, who.cookie, "POST", `/canvas/tasks/${taskId}/cancel`, {});
}

/**
 * Where a task, its hold and its node task row stand.
 * @param taskId - The task.
 * @returns Each one's status.
 */
async function standing(taskId: string): Promise<{ task?: string; hold?: string; node?: { status: string; error_message: string | null } }> {
  const [task] = await sql<{ status: string }[]>`select status from tasks where id = ${taskId}`;
  const [hold] = await sql<{ status: string }[]>`select status from credit_holds where reference_id = ${taskId}`;
  const [node] = await sql<{ status: string; error_message: string | null }[]>`select status, error_message from node_tasks where task_id = ${taskId}`;
  return { task: task?.status, hold: hold?.status, node };
}

/**
 * The id of a task's node task row on one node.
 * @param taskId - The task.
 * @param nodeId - The node.
 * @returns The row's id.
 */
async function rowOn(taskId: string, nodeId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from node_tasks where task_id = ${taskId} and node_id = ${nodeId}`;
  if (row === undefined) throw new Error(`task ${taskId} has no row on ${nodeId}`);
  return row.id;
}

describe("G-25 cancelling a task that has not started", () => {
  it("cancels it, releases its hold, ends its node row as cancelled and answers the node's counts", async () => {
    const a = await seedAccount(sql);
    const { taskId, nodeId } = await generate(a);
    expect(await standing(taskId)).toMatchObject({ task: "pending", hold: "held", node: { status: "running" } });
    const res = await cancel(a, await rowOn(taskId, nodeId));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { cancelled: boolean; counts: Record<string, number> | null } };
    expect(body.data.cancelled).toBe(true);
    expect(body.data.counts).toMatchObject({ running: 0, waiting: 0, failed: 1 });
    expect(await standing(taskId)).toEqual({ task: "cancelled", hold: "released", node: { status: "failed", error_message: "cancelled" } });
  });

  it("answers no node counts when the task's own id is named", async () => {
    const a = await seedAccount(sql);
    const { taskId } = await generate(a);
    const res = await cancel(a, taskId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ cancelled: true, counts: null });
    expect(await standing(taskId)).toMatchObject({ task: "cancelled", node: { status: "failed", error_message: "cancelled" } });
  });

  // One run can fill several nodes (a grid mini-tool), each with its own row,
  // and each node's task list closes on its own counts. Two cases, one per
  // node, so whichever row the task lists first, one of them names the other.
  it.each(["first", "second"] as const)("answers the counts of the node whose row was named (%s node of the run)", async (named) => {
    const a = await seedAccount(sql);
    const second = crypto.randomUUID();
    const other = await generate(a, a, second);
    const { taskId, nodeId: first } = await generate(a);
    await sql`
      insert into node_tasks
      select (jsonb_populate_record(null::node_tasks, to_jsonb(n) || jsonb_build_object('id', gen_random_uuid(), 'node_id', ${second}::text))).*
      from node_tasks n where task_id = ${taskId}`;
    const nodeId = named === "first" ? first : second;
    const res = await cancel(a, await rowOn(taskId, nodeId));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { counts: Record<string, number> } };
    expect(body.data.counts).toEqual(await nodeTaskService.countsFor({ projectId: a.projectId, nodeId }));
    expect(body.data.counts.running).toBe(named === "first" ? 0 : 1);
    expect((await standing(other.taskId)).task).toBe("pending");
  });

  // The node and 3D task lists hold only their rows' ids, which differ from
  // the task's when one run fills several nodes, so the route takes a row's
  // id for its task (inner#1968).
  it("takes the id of a row in a task list for the task that row runs", async () => {
    const a = await seedAccount(sql);
    const { taskId } = await generate(a);
    const [row] = await sql<{ id: string }[]>`select id from node_tasks where task_id = ${taskId}`;
    const res = await cancel(a, row!.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await standing(taskId)).toMatchObject({ task: "cancelled", node: { status: "failed", error_message: "cancelled" } });
  });

  it("names `cancelled` among the stored failure reasons", () => {
    expect(TASK_FAILURE_REASONS as readonly string[]).toContain("cancelled");
  });
});

describe("G-26 a task that already started", () => {
  it("answers 409 and leaves it running", async () => {
    const a = await seedAccount(sql);
    const { taskId } = await generate(a);
    await sql`update tasks set status = 'running', started_at = now() where id = ${taskId}`;
    const res = await cancel(a, taskId);
    expect(res.status).toBe(409);
    expect(await standing(taskId)).toMatchObject({ task: "running", hold: "held", node: { status: "running" } });
  });
});

describe("G-27 who may cancel", () => {
  it("refuses a viewer and an outsider exactly as clearing the node task does", async () => {
    const a = await seedAccount(sql);
    const { taskId, nodeId } = await generate(a);
    const viewer = await seedMember(sql, a);
    await sql`update project_members set role = 'viewer' where project_id = ${a.projectId} and user_id = ${viewer.userId}`;
    const outsider = await seedAccount(sql);
    for (const who of [viewer, outsider]) {
      const cancelled = await cancel(who, taskId);
      const cleared = await app.request(`/api/v1/canvas/node-tasks/${taskId}?project_id=${a.projectId}&space_id=${a.spaceId}&node_id=${nodeId}`, {
        method: "DELETE",
        headers: { Cookie: who.cookie },
      });
      expect(cleared.status).not.toBe(200);
      expect(cancelled.status).toBe(cleared.status);
      expect((await cancelled.json()) as unknown).toEqual((await cleared.json()) as unknown);
    }
    expect((await standing(taskId)).task).toBe("pending");
  });
});

describe("G-28 a 3D generation that has not started", () => {
  it("ends its Space row as cancelled and answers no node counts", async () => {
    const a = await seedAccount(sql);
    const res = await request(app, a.cookie, "POST", `/projects/${a.projectId}/three-d/${a.spaceId}/generations`, {
      mode: "t23d", model: "tripo-h3.1-t23d", prompt: "a red barn lamp", params: { texture: true }, origin: "space",
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    const taskId = String(data.task_id ?? data.taskId);
    const channel = spaceTasksChangedChannel(env.REDIS_KEY_PREFIX, a.projectId);
    const publish = vi.spyOn(getStreamRedis(), "publish");
    const answer = await cancel(a, taskId);
    const signals = publish.mock.calls.filter(([published]) => published === channel).length;
    publish.mockRestore();
    expect(answer.status, await answer.clone().text()).toBe(200);
    expect(((await answer.json()) as { data: unknown }).data).toEqual({ cancelled: true, counts: null });
    expect(signals).toBe(1);
    expect(await standing(taskId)).toMatchObject({ task: "cancelled", hold: "released", node: { status: "failed", error_message: "cancelled" } });
  });
});

describe("G-29 cancelling a Timeline execution that has not started", () => {
  it.each(["queued", "awaiting_landing"] as const)("cancels a %s execution and touches no credit hold", async (state) => {
    const a = await seedAccount(sql);
    const budget = getNodeTaskConfig().default_budget_ms;
    const row = await timelineExecutionRepo.insert({
      projectId: a.projectId,
      spaceId: a.spaceId,
      actorUserId: a.userId,
      kind: "web_animation_create",
      engine: "deepseek",
      actionId: crypto.randomUUID(),
      input: { prompt: "A red square slides in", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } },
      inputHash: `sha256:${crypto.randomUUID()}`,
      deadlineAt: new Date(Date.now() + budget),
    });
    if (row === null) throw new Error("fixture execution conflicted");
    if (state === "queued") await timelineExecutionRepo.transition({ id: row.id, event: { type: "land", inputHash: row.inputHash } });
    const holds = async (): Promise<unknown[]> => [...(await sql`select id, status, amount, released_at from credit_holds where studio_id = ${a.studioId} order by id`)];
    const before = await holds();
    await timelineExecutionService.cancel(a.userId, row.id);
    const [execution] = await sql<{ status: string }[]>`select status from timeline_executions where id = ${row.id}`;
    expect(execution!.status).toBe("cancelled");
    expect(await holds()).toEqual(before);
  });
});

/**
 * Every node-task-counts event the stream carries for one node.
 * @param a - Whose canvas.
 * @param nodeId - The node.
 * @returns Each event's counts, oldest first.
 */
async function countsEvents(a: Account, nodeId: string): Promise<Record<string, number>[]> {
  const raw = (await getStreamRedis().xrange(taskEventsStreamKey(), "-", "+")) as [string, string[]][];
  return raw
    .map(([, fields]) => JSON.parse(fields[fields.indexOf("payload") + 1]!) as Record<string, unknown>)
    .filter((e) => e.type === "node-task-counts" && e.docName === canvasSpaceDocName(a.projectId, a.spaceId) && e.nodeId === nodeId)
    .map((e) => e.counts as Record<string, number>);
}

/**
 * Every stored column of a task, its node task row and its credit hold.
 * @param taskId - The task.
 * @returns The three rows as read.
 */
async function rowsOf(taskId: string): Promise<unknown[]> {
  return [
    [...(await sql`select * from tasks where id = ${taskId}`)],
    [...(await sql`select * from node_tasks where task_id = ${taskId}`)],
    [...(await sql`select * from credit_holds where reference_id = ${taskId}`)],
  ];
}

describe("G-40 cancelling a task the gate has not judged yet (F8 fresh × T7)", () => {
  it("G-40 cancels it, releases its hold in the same commit, ends its node row as cancelled with a counts event, and a later pickup returns without starting it", async () => {
    const a = await seedAccount(sql);
    const { taskId, nodeId } = await generate(a);
    const [fresh] = await sql<{ slot_wait_since: Date | null }[]>`select slot_wait_since from tasks where id = ${taskId}`;
    expect(fresh!.slot_wait_since).toBeNull();
    const [node] = await sql<{ waiting_since: Date | null }[]>`select waiting_since from node_tasks where task_id = ${taskId}`;
    expect(node!.waiting_since).toBeNull();
    expect(await standing(taskId)).toMatchObject({ task: "pending", hold: "held", node: { status: "running" } });
    const runningBefore = (await nodeTaskService.countsFor({ projectId: a.projectId, nodeId })).running;
    const eventsBefore = (await countsEvents(a, nodeId)).length;

    const res = await cancel(a, await rowOn(taskId, nodeId));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { cancelled: boolean; counts: Record<string, number> } };
    expect(body.data.cancelled).toBe(true);
    expect(body.data.counts.running).toBe(runningBefore - 1);
    expect(await standing(taskId)).toEqual({ task: "cancelled", hold: "released", node: { status: "failed", error_message: "cancelled" } });
    const events = await countsEvents(a, nodeId);
    expect(events.length).toBeGreaterThan(eventsBefore);
    expect(events.at(-1)).toMatchObject({ running: runningBefore - 1 });

    // The worker's pickup reads an ended row and returns: no start, no wait recorded.
    const after = await rowsOf(taskId);
    const picked = await runningSlotService.startWithinLimit({ id: taskId, jobId: `job-${taskId}` });
    expect(picked.outcome).toBe("ended");
    expect(await rowsOf(taskId)).toEqual(after);
  });
});

describe("G-41 cancelling a running row past its deadline (F8 stale × T7)", () => {
  it("G-41 answers 409 and changes nothing: task, node row, hold and slot columns stay as they were, and no counts event is sent", async () => {
    const a = await seedAccount(sql);
    const { taskId, nodeId } = await generate(a);
    const B = getNodeTaskConfig().default_budget_ms;
    await sql`update tasks set status = 'running', started_at = now() - ${B + reportGraceMs() + 1} * interval '1 millisecond' where id = ${taskId}`;
    expect(await standing(taskId)).toMatchObject({ task: "running", hold: "held", node: { status: "running" } });
    const before = await rowsOf(taskId);
    const eventsBefore = (await countsEvents(a, nodeId)).length;
    const res = await cancel(a, taskId);
    expect(res.status).toBe(409);
    expect(await rowsOf(taskId)).toEqual(before);
    expect((await countsEvents(a, nodeId)).length).toBe(eventsBefore);
  });
});

describe("G-42 cancelling a task that already ended (F8 ended × T7)", () => {
  it.each(["completed", "failed", "cancelled"] as const)("G-42 answers 409 for a %s task and changes nothing, sending no counts event", async (end) => {
    const a = await seedAccount(sql);
    const { taskId, nodeId } = await generate(a);
    if (end === "cancelled") {
      expect((await cancel(a, taskId)).status).toBe(200);
    } else {
      await sql`update tasks set status = ${end}, completed_at = now() where id = ${taskId}`;
      await sql`update node_tasks set status = ${end === "completed" ? "done" : "failed"}, settled_at = now() where task_id = ${taskId}`;
      await sql`update credit_holds set status = 'released', released_at = now() where reference_id = ${taskId}`;
    }
    const before = await rowsOf(taskId);
    const eventsBefore = (await countsEvents(a, nodeId)).length;
    const res = await cancel(a, taskId);
    expect(res.status).toBe(409);
    expect(await rowsOf(taskId)).toEqual(before);
    expect((await countsEvents(a, nodeId)).length).toBe(eventsBefore);
  });
});

describe("G-36 the generation rate limit stays", () => {
  // Present before this work: `config/rate-limits.yaml` `generate` allows 30 a minute.
  it("answers the 31st submission in a minute with 429", async () => {
    const a = await seedAccount(sql);
    const body = { project_id: a.projectId, space_id: a.spaceId, source: "task", mode: "append", task_type: "image", model: "flux-schnell", params: { prompt: "a cat" } };
    for (let i = 0; i < 30; i += 1) expect((await request(app, a.cookie, "POST", "/canvas/tasks", body)).status).not.toBe(429);
    expect((await request(app, a.cookie, "POST", "/canvas/tasks", body)).status).toBe(429);
  });
});

