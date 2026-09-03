// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two kinds of thing that reach a task row, and why they answer
 * differently (task #186, design §4.3 / §4.4).
 *
 * A machine reporting a fact — the ingest Worker's report, a finished job, a
 * timer that went off — is telling us about something that already happened.
 * Refusing it does not un-happen it, and refusing it here would throw away the
 * rest of the request: `/assets/ingest-report` also registers the asset,
 * writes node_history and counts storage. So a fact landing on a terminal row
 * is a no-op that still answers 200.
 *
 * A user asking for an action is different. "Finish this" on a row that is
 * still running is a request we can and should refuse, because refusing costs
 * nothing — nothing else rides on that request.
 *
 * The row that carries both halves is the one whose deadline passed before its
 * report arrived: it keeps `expired`, AND it takes the history id, because the
 * bytes really are in R2 and the user must be able to pull the result back.
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
import { nodeTaskService } from "@breatic/domain";

const PG_DRIVER_LOCAL = "node-task-state-test-driver";

let sql: ReturnType<typeof postgres>;
let projectId: string;
let userId: string;
let seq = 0;

/** A user, their personal studio and one project — the suite seeds its own. */
async function seedProject(): Promise<{ userId: string; projectId: string }> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`nt-${seq++}@example.com`}, true) RETURNING id
  `;
  const uid = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${uid}, ${`nt-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${uid}, 'admin')
  `;
  const slug = `nt-proj-${seq++}`;
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

/** Open one running upload task on a node nobody else is using. */
async function openTask(): Promise<{ taskId: string; nodeId: string }> {
  const nodeId = crypto.randomUUID();
  const opened = await nodeTaskService.open({
    projectId,
    spaceId: crypto.randomUUID(),
    nodeId,
    kind: "upload",
    startedByUserId: userId,
    budgetMs: 600_000,
    label: "sunset.jpg",
  });
  return { taskId: opened.id, nodeId };
}

/** Read the row straight from the table, bypassing the service. */
async function readRow(taskId: string) {
  const rows = await sql<
    { status: string; node_history_id: string | null; deleted_at: Date | null }[]
  >`
    SELECT status, node_history_id, deleted_at
    FROM node_tasks WHERE id = ${taskId}
  `;
  return rows[0];
}

describe("a machine reporting a fact", () => {
  it("moves a running row to done and shows up in the counts", async () => {
    const { taskId, nodeId } = await openTask();
    const before = await nodeTaskService.countsFor({ projectId, nodeId });
    expect(before).toEqual({ running: 1, done: 0, failed: 0, expired: 0 });

    const settled = await nodeTaskService.settle({ taskId, outcome: "done" });
    expect(settled.applied).toBe(true);
    expect(settled.counts).toEqual({
      running: 0,
      done: 1,
      failed: 0,
      expired: 0,
    });
  });

  it("takes a redelivered report on a done row without changing it", async () => {
    const { taskId } = await openTask();
    await nodeTaskService.settle({ taskId, outcome: "done" });
    const first = await readRow(taskId);

    const again = await nodeTaskService.settle({ taskId, outcome: "done" });
    expect(again.applied).toBe(false);

    const after = await readRow(taskId);
    expect(after?.status).toBe("done");
    expect(after?.node_history_id).toBe(first?.node_history_id ?? null);
  });

  it("keeps a failed row failed when a success report arrives late", async () => {
    const { taskId } = await openTask();
    await nodeTaskService.settle({
      taskId,
      outcome: "failed",
      errorMessage: "transcode failed",
    });

    const late = await nodeTaskService.settle({ taskId, outcome: "done" });
    expect(late.applied).toBe(false);
    expect((await readRow(taskId))?.status).toBe("failed");
  });

  it("fills the history id on an expired row — the bytes really landed", async () => {
    const { taskId } = await openTask();
    await nodeTaskService.settle({ taskId, outcome: "expired" });

    const nodeId = crypto.randomUUID();
    const history = await sql<{ id: string }[]>`
      INSERT INTO node_history
        (project_id, node_id, user_id, entry_type, status, content)
      VALUES
        (${projectId}, ${nodeId}, ${userId}, 'upload', 'success',
         'https://example.invalid/late.jpg')
      RETURNING id
    `;

    const late = await nodeTaskService.settle({
      taskId,
      outcome: "done",
      nodeHistoryId: history[0]!.id,
    });
    // The status does not move: the deadline passed and the user may have
    // retried. What changes is that the result becomes reachable.
    expect(late.applied).toBe(false);

    const row = await readRow(taskId);
    expect(row?.status).toBe("expired");
    expect(row?.node_history_id).toBe(history[0]!.id);
  });

  it("no-ops when the timer fires on a row that already settled", async () => {
    const { taskId } = await openTask();
    await nodeTaskService.settle({ taskId, outcome: "done" });

    const fired = await nodeTaskService.settle({ taskId, outcome: "expired" });
    expect(fired.applied).toBe(false);
    expect((await readRow(taskId))?.status).toBe("done");
  });
});

describe("a user asking for an action", () => {
  it("refuses to finish a row that is still running", async () => {
    const { taskId } = await openTask();
    await expect(nodeTaskService.dismiss({ taskId })).rejects.toThrow();
    expect((await readRow(taskId))?.deleted_at).toBeNull();
  });

  it("soft-deletes a settled row and drops it out of the counts", async () => {
    const { taskId, nodeId } = await openTask();
    await nodeTaskService.settle({ taskId, outcome: "done" });

    const gone = await nodeTaskService.dismiss({ taskId });
    expect(gone.removed).toBe(true);
    expect(gone.counts).toEqual({
      running: 0,
      done: 0,
      failed: 0,
      expired: 0,
    });

    const row = await readRow(taskId);
    // The row stays; only the user's view of it goes away.
    expect(row?.deleted_at).not.toBeNull();
    const stillThere = await nodeTaskService.countsFor({ projectId, nodeId });
    expect(stillThere).toEqual({ running: 0, done: 0, failed: 0, expired: 0 });
  });

  it("carries on when the row it names is not there", async () => {
    // The user is looking at a projection the server cannot see. Whatever is
    // on their screen, "clear this" means clear it — the counts get recounted
    // from what the table actually holds and the answer is not an error.
    const gone = await nodeTaskService.dismiss({ taskId: crypto.randomUUID() });
    expect(gone.removed).toBe(false);
  });
});
