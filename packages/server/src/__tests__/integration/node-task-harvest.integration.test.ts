// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Judging a task dead happens when somebody reads the node's task list, and
 * nowhere else (task #186, design §4.6).
 *
 * There is no resident timer. A task that ran past its budget stays `running`
 * in the table until the next read of that node's list, and that read is what
 * moves it — which is why the three things one such request does have a fixed
 * order: harvest, then read the rows, then recount. Reversed, the same answer
 * would carry a row that says `running` beside a count that says `expired`.
 *
 * The cost of judging only on a read is a stated boundary (design §4.6.4):
 * nobody reads, nothing moves, and the four numbers on the node stay stale.
 * The way out is the same action — open the list.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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

import postgres from "postgres";
import { initCore } from "@breatic/core";
import { nodeTaskService } from "@breatic/domain";

// `integration-setup.ts` sets the env vars and deliberately stops there, so
// that importing it pulls in no part of core. A suite that reaches real core
// — this one goes through the `db` Proxy — calls initCore itself.
initCore(process.env);

const PG_DRIVER_LOCAL = "node-task-harvest-test-driver";
const BUDGET_MS = 600_000;

let sql: ReturnType<typeof postgres>;
let projectId: string;
let userId: string;

// Suites share one database and run in parallel, so the seed's unique columns
// carry a random suffix rather than a per-file prefix and a counter — two
// files that pick the same prefix would collide on the first row each.
const RUN = crypto.randomUUID().slice(0, 8);

/** A user, their personal studio and one project — the suite seeds its own. */
async function seedProject(): Promise<{ userId: string; projectId: string }> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`harvest-${RUN}@example.com`}, true) RETURNING id
  `;
  const uid = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${uid}, ${`harvest-s-${RUN}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${uid}, 'admin')
  `;
  const slug = `harvest-proj-${RUN}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${uid}, ${`P ${slug}`}, ${slug}, 'private')
    RETURNING id
  `;
  const pid = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${pid}, ${uid}, 'owner', null)
  `;
  return { userId: uid, projectId: pid };
}

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  ({ userId, projectId } = await seedProject());
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Open one running task on `nodeId`.
 * @param nodeId - The node it hangs on.
 * @param label - What the row shows, so failures name the right row.
 * @returns The new task's id.
 */
async function openOn(nodeId: string, label: string): Promise<string> {
  const opened = await nodeTaskService.open({
    projectId,
    spaceId: crypto.randomUUID(),
    nodeId,
    kind: "upload",
    startedByUserId: userId,
    budgetMs: BUDGET_MS,
    label,
  });
  return opened.id;
}

/**
 * Push one task's start back far enough that its budget has run out.
 *
 * Writing the moment rather than waiting for it keeps the rule under test the
 * only thing being tested — the wait itself is not the behaviour.
 * @param taskId - The task to age.
 */
async function ageOut(taskId: string): Promise<void> {
  await sql`
    UPDATE node_tasks
    SET started_at = now() - ((budget_ms + 1000) * interval '1 millisecond')
    WHERE id = ${taskId}
  `;
}

/**
 * Read one row's status straight from the table, bypassing the service.
 * @param taskId - Which task.
 * @returns Its status and the reason recorded on it.
 */
async function readRow(
  taskId: string,
): Promise<{ status: string; error_message: string | null } | undefined> {
  const rows = await sql<{ status: string; error_message: string | null }[]>`
    SELECT status, error_message FROM node_tasks WHERE id = ${taskId}
  `;
  return rows[0];
}

describe("reading a node's task list", () => {
  it("expires a row whose budget has run out", async () => {
    const nodeId = crypto.randomUUID();
    const taskId = await openOn(nodeId, "over-budget.mp4");
    await ageOut(taskId);

    const { tasks, counts } = await nodeTaskService.harvestAndList({
      projectId,
      nodeId,
    });

    expect(await readRow(taskId)).toMatchObject({ status: "expired" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: taskId, status: "expired" });
    expect(counts).toEqual({ running: 0, done: 0, failed: 0, expired: 1 });
  });

  it("leaves a row still inside its budget alone", async () => {
    const nodeId = crypto.randomUUID();
    const taskId = await openOn(nodeId, "in-budget.mp4");

    const { tasks, counts } = await nodeTaskService.harvestAndList({
      projectId,
      nodeId,
    });

    expect(await readRow(taskId)).toMatchObject({ status: "running" });
    expect(tasks[0]).toMatchObject({ id: taskId, status: "running" });
    expect(counts).toEqual({ running: 1, done: 0, failed: 0, expired: 0 });
  });

  it("leaves a row that already settled alone, however old it is", async () => {
    const nodeId = crypto.randomUUID();
    const taskId = await openOn(nodeId, "already-done.jpg");
    await nodeTaskService.settle({ taskId, outcome: "done" });
    await ageOut(taskId);

    const { counts } = await nodeTaskService.harvestAndList({
      projectId,
      nodeId,
    });

    // A terminal row is a fact that already happened; the budget has nothing
    // left to say about it.
    expect(await readRow(taskId)).toMatchObject({ status: "done" });
    expect(counts).toEqual({ running: 0, done: 1, failed: 0, expired: 0 });
  });

  it("judges only the row that ran out when both are on one node", async () => {
    const nodeId = crypto.randomUUID();
    const stale = await openOn(nodeId, "stale.mp4");
    const fresh = await openOn(nodeId, "fresh.mp4");
    await ageOut(stale);

    const { counts } = await nodeTaskService.harvestAndList({
      projectId,
      nodeId,
    });

    expect(await readRow(stale)).toMatchObject({ status: "expired" });
    expect(await readRow(fresh)).toMatchObject({ status: "running" });
    expect(counts).toEqual({ running: 1, done: 0, failed: 0, expired: 1 });
  });

  it("touches no other node's rows", async () => {
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    const myTask = await openOn(mine, "mine.mp4");
    const theirTask = await openOn(theirs, "theirs.mp4");
    await ageOut(myTask);
    await ageOut(theirTask);

    await nodeTaskService.harvestAndList({ projectId, nodeId: mine });

    expect(await readRow(myTask)).toMatchObject({ status: "expired" });
    expect(await readRow(theirTask)).toMatchObject({ status: "running" });
  });

  it("records why the row left running", async () => {
    const nodeId = crypto.randomUUID();
    const taskId = await openOn(nodeId, "reason.mp4");
    await ageOut(taskId);

    await nodeTaskService.harvestAndList({ projectId, nodeId });

    // The list shows the user a reason on every terminal row, and this row
    // reached its terminal state without anyone reporting anything.
    expect(await readRow(taskId)).toMatchObject({ error_message: "expired" });
  });

  it("answers with rows and counts that agree", async () => {
    const nodeId = crypto.randomUUID();
    const taskId = await openOn(nodeId, "order.mp4");
    await ageOut(taskId);

    const { tasks, counts } = await nodeTaskService.harvestAndList({
      projectId,
      nodeId,
    });

    // This is the fixed order made observable: harvest, then read, then
    // recount. Reading before the harvest would hand back a `running` row
    // beside an `expired` count, in one answer.
    const running = tasks.filter((t) => t.status === "running").length;
    const expired = tasks.filter((t) => t.status === "expired").length;
    expect(running).toBe(counts.running);
    expect(expired).toBe(counts.expired);
    expect(tasks[0]).toMatchObject({ id: taskId, status: "expired" });
  });
});
