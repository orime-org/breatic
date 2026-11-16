// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Cancelling a task that waits for a free slot (inner#1968, test spec area G:
 * G-25 to G-29, G-36; invariant K5; 5.1 resolution #14). Real Postgres and
 * Redis through the real Hono app, payments on.
 *
 * `POST /api/v1/canvas/tasks/:taskId/cancel` is allowed to whoever may
 * `DELETE /canvas/node-tasks/:taskId` (a project editor, the project read from
 * the task row). Under the person's `running-tasks:<user_id>` lock it moves the
 * task `pending → cancelled` and, in the same transaction, releases the credit
 * hold and the ledger row and ends the node task row with the failure reason
 * `cancelled`; it answers `200 { data: { cancelled: true, counts } }`, `counts`
 * being the node's `NodeTaskCounts` (null for a 3D Space's own row). A task
 * that already started answers 409 and goes on. A Timeline execution's cancel
 * runs through `timelineSettlement.transition` and releases its ledger row and
 * `operation:` hold the same way.
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
import { env, getNodeTaskConfig, getStreamRedis, initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import { spaceTasksChangedChannel, TASK_FAILURE_REASONS } from "@breatic/shared";
import * as timelineExecutionService from "@server/modules/timeline/timeline-execution.service.js";
import { PAYMENTS_ON, request, seedAccount, seedMember, type Account, type Actor } from "./operation-counting-fixtures.js";

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
 * @returns The task id and its node.
 */
async function generate(a: Account, who: Actor = a): Promise<{ taskId: string; nodeId: string }> {
  const nodeId = crypto.randomUUID();
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
 * Where a task, its hold, its ledger row and its node task row stand.
 * @param taskId - The task.
 * @returns Each one's status.
 */
async function standing(taskId: string): Promise<{ task?: string; hold?: string; ledger?: string; node?: { status: string; error_message: string | null } }> {
  const [task] = await sql<{ status: string }[]>`select status from tasks where id = ${taskId}`;
  const [hold] = await sql<{ status: string }[]>`select status from credit_holds where reference_id = ${taskId}`;
  const [ledger] = await sql<{ status: string }[]>`select status from operation_ledger where operation_key = ${`task:${taskId}`}`;
  const [node] = await sql<{ status: string; error_message: string | null }[]>`select status, error_message from node_tasks where task_id = ${taskId}`;
  return { task: task?.status, hold: hold?.status, ledger: ledger?.status, node };
}

describe("G-25 cancelling a task that has not started", () => {
  it("cancels it, releases its hold and ledger row, ends its node row as cancelled and answers the node's counts", async () => {
    const a = await seedAccount(sql);
    const { taskId } = await generate(a);
    expect(await standing(taskId)).toMatchObject({ task: "pending", hold: "held", ledger: "reserved", node: { status: "running" } });
    const res = await cancel(a, taskId);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { cancelled: boolean; counts: Record<string, number> | null } };
    expect(body.data.cancelled).toBe(true);
    expect(body.data.counts).toMatchObject({ running: 0, waiting: 0, failed: 1 });
    expect(await standing(taskId)).toEqual({ task: "cancelled", hold: "released", ledger: "released", node: { status: "failed", error_message: "cancelled" } });
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
    expect(await standing(taskId)).toMatchObject({ task: "running", hold: "held", ledger: "reserved", node: { status: "running" } });
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
    expect(await standing(taskId)).toMatchObject({ task: "cancelled", hold: "released", ledger: "released", node: { status: "failed", error_message: "cancelled" } });
  });
});

describe("G-29 cancelling a Timeline execution that has not started", () => {
  it.each(["queued", "awaiting_landing"] as const)("cancels a %s execution and releases its ledger row and overage hold", async (state) => {
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
    const key = `timeline:${row.id}`;
    const until = new Date(Date.now() + budget + 60_000);
    await sql`insert into credit_holds(studio_id, actor_user_id, reference_id, amount, status, expires_at) values (${a.studioId}, ${a.userId}, ${`operation:${key}`}, 0.5, 'held', ${until})`;
    await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, overage_hold, expires_at)
      values (${key}, 'timeline', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'reserved', 'held', ${`operation:${key}`}, ${until})`;
    await timelineExecutionService.cancel(a.userId, row.id);
    const [execution] = await sql<{ status: string }[]>`select status from timeline_executions where id = ${row.id}`;
    expect(execution!.status).toBe("cancelled");
    const [ledger] = await sql<{ status: string }[]>`select status from operation_ledger where operation_key = ${key}`;
    expect(ledger!.status).toBe("released");
    const [hold] = await sql<{ status: string }[]>`select status from credit_holds where reference_id = ${`operation:${key}`}`;
    expect(hold!.status).toBe("released");
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

