// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web-animation execution record (inner#1711 design §3.4, §5.3; #1490 design §4.3, §13.1).
 *
 * `timelineExecutionRepo.transition` is the one writer of `status`. These tests drive it against the real database:
 * every state crossed with every event, the attempt fence, the invariants that hold for any event sequence, and the
 * `billed_at` gate that lets an execution be charged at most once. New code inserts rows `queued`; a row still
 * `awaiting_landing` was stored before #1490, and only the deadline or a cancel moves it.
 */

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, db, initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import type { TimelineExecutionEvent } from "@breatic/core";
import type { TimelineExecution, TimelineExecutionStatus } from "@breatic/shared";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

let sql: ReturnType<typeof createPgClient>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], executions: [] as string[] };

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-execution-test-driver", max: 6, prepare: false });
});

afterEach(async () => {
  try {
    if (owned.executions.length > 0) await sql`UPDATE timeline_executions SET deleted_at = now() WHERE id = ANY(${owned.executions}::uuid[])`;
    if (owned.projects.length > 0) await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    if (owned.studios.length > 0) await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const list of Object.values(owned)) list.length = 0;
  }
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Insert an owner, a Studio and a Project.
 * @returns The Project id and its owner.
 * @throws {Error} When a fixture write fails.
 */
async function seedProject(): Promise<{ projectId: string; ownerId: string }> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${ownerId}, ${`timeline-exec-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline execution studio')`;
  owned.studios.push(studioId);
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug) VALUES (${projectId}, ${studioId}, ${ownerId}, 'Timeline execution test', ${`exec-${projectId}`})`;
  owned.projects.push(projectId);
  return { projectId, ownerId };
}

/**
 * Accept one execution for a fresh Project.
 * @param overrides - Fields to replace in the insert.
 * @returns The inserted row.
 * @throws {Error} When the insert conflicts or fails.
 */
async function accept(overrides: Partial<{ projectId: string; ownerId: string; spaceId: string; actionId: string }> = {}): Promise<TimelineExecution> {
  const fixture = overrides.projectId !== undefined && overrides.ownerId !== undefined
    ? { projectId: overrides.projectId, ownerId: overrides.ownerId }
    : await seedProject();
  const row = await timelineExecutionRepo.insert({
    projectId: fixture.projectId,
    spaceId: overrides.spaceId ?? randomUUID(),
    actorUserId: fixture.ownerId,
    kind: "web_animation_create",
    engine: "deepseek",
    actionId: overrides.actionId ?? randomUUID(),
    input: { prompt: "A red square", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } },
    inputHash: "sha256:input",
    deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    origin: "web_animation_space",
  });
  if (row === null) throw new Error("Fixture execution conflicted");
  owned.executions.push(row.id);
  return row;
}

/**
 * Insert a row as one stored before #1490 is: made in a Timeline and still waiting for its landing receipt.
 * @returns The row as the repository reads it.
 * @throws {Error} When the insert fails.
 */
async function acceptBefore1490(): Promise<TimelineExecution> {
  const { projectId, ownerId } = await seedProject();
  const [inserted] = await sql<{ id: string }[]>`INSERT INTO timeline_executions
      (project_id, space_id, actor_user_id, kind, engine, action_id, input, input_hash, deadline_at, status, origin)
    VALUES (${projectId}, ${randomUUID()}, ${ownerId}, 'web_animation_create', 'deepseek', ${randomUUID()},
      ${sql.json({ prompt: "A red square", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } })},
      'sha256:input', now() + interval '2 hours', 'awaiting_landing', 'timeline')
    RETURNING id`;
  if (inserted === undefined) throw new Error("Fixture execution missing");
  owned.executions.push(inserted.id);
  return read(inserted.id);
}

/**
 * Move the original deadline into the past, as if the two-hour budget ran out.
 * @param id - The execution.
 * @throws {Error} When the fixture write fails.
 */
async function passDeadline(id: string): Promise<void> {
  await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 minute' WHERE id = ${id}`;
}

/**
 * Read the stored row.
 * @param id - The execution.
 * @returns The row.
 * @throws {Error} When the row is missing.
 */
async function read(id: string): Promise<TimelineExecution> {
  const row = await timelineExecutionRepo.findById(id);
  if (row === undefined) throw new Error("Execution missing");
  return row;
}

type Setup = "awaiting_landing" | "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "expired";
type EventName = "claim" | "retry" | "success" | "failure" | "cancel" | "cancelAck" | "deadline";

/**
 * Drive a fresh execution into a state through the writer itself.
 * @param state - The state to reach.
 * @returns The row in that state.
 * @throws {Error} When a setup step is refused.
 */
async function reach(state: Setup): Promise<TimelineExecution> {
  if (state === "awaiting_landing") return acceptBefore1490();
  const row = await accept();
  const step = async (event: TimelineExecutionEvent): Promise<TimelineExecution> => {
    const result = await timelineExecutionRepo.transition({ id: row.id, event });
    if (!result.applied) throw new Error(`Setup step ${event.type} refused`);
    return result.row;
  };
  if (state === "expired") { await passDeadline(row.id); return step({ type: "deadline" }); }
  if (state === "cancelled") return step({ type: "cancel" });
  if (state === "queued") return row;
  if (state === "failed") return step({ type: "failure", fence: null, reason: "enqueue_failed" });
  const current = await step({ type: "claim" });
  if (state === "running") return current;
  if (state === "succeeded") return step({ type: "success", fence: current.fence, resultSourceVersionId: randomUUID() });
  return step({ type: "cancel" });
}

/**
 * The event as the matrix sends it to a row, carrying the row's current fence where the event needs one.
 * @param name - The matrix column.
 * @param row - The row the event is sent to.
 * @returns The event.
 * @throws {never} Never.
 */
function eventFor(name: EventName, row: TimelineExecution): TimelineExecutionEvent {
  switch (name) {
    case "claim": return { type: "claim" };
    case "retry": return { type: "retry" };
    case "success": return { type: "success", fence: row.fence, resultSourceVersionId: randomUUID() };
    case "failure": return { type: "failure", fence: row.fence, reason: "validation_failed" };
    case "cancel": return { type: "cancel" };
    case "cancelAck": return { type: "cancelAck" };
    case "deadline": return { type: "deadline" };
  }
}

const S = {
  AL: "awaiting_landing", Q: "queued", R: "running", C: "cancelling",
  OK: "succeeded", F: "failed", X: "cancelled", E: "expired",
} as const satisfies Record<string, TimelineExecutionStatus>;

// Rows: current state. Columns: claim, retry, success, failure, cancel, cancelAck, deadline.
const MATRIX: Record<Setup, readonly TimelineExecutionStatus[]> = {
  awaiting_landing: [S.AL, S.AL, S.AL, S.AL, S.X, S.AL, S.E],
  queued: [S.R, S.Q, S.Q, S.F, S.X, S.Q, S.E],
  running: [S.R, S.R, S.OK, S.F, S.C, S.R, S.E],
  cancelling: [S.C, S.C, S.X, S.X, S.C, S.X, S.E],
  succeeded: [S.OK, S.OK, S.OK, S.OK, S.OK, S.OK, S.OK],
  failed: [S.F, S.F, S.F, S.F, S.F, S.F, S.F],
  cancelled: [S.X, S.X, S.X, S.X, S.X, S.X, S.X],
  expired: [S.E, S.E, S.E, S.E, S.E, S.E, S.E],
};
const EVENTS: readonly EventName[] = ["claim", "retry", "success", "failure", "cancel", "cancelAck", "deadline"];

describe("timeline_executions table", () => {
  it("stores every column the design lists, with soft delete", async () => {
    const rows = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'timeline_executions' ORDER BY column_name`;
    expect(rows.map((row) => row.column_name)).toEqual([
      "action_id", "actor_user_id", "attempt", "billed_at", "billed_credits", "created_at", "deadline_at", "deleted_at",
      "engine", "failure_reason", "fence", "id", "input", "input_hash", "kind", "origin", "phase", "project_id", "result_asset_id",
      "result_source_version_id", "space_id", "status", "steps", "updated_at",
    ]);
  });

  it("refuses a status outside the eight states", async () => {
    const row = await accept();
    await expect(sql`UPDATE timeline_executions SET status = 'paused' WHERE id = ${row.id}`).rejects.toThrow(/check/i);
  });
});

describe("timelineExecutionRepo.insert", () => {
  it("starts an accepted execution queued, with no attempt and no fence", async () => {
    const row = await accept();
    expect(row).toMatchObject({
      status: "queued", origin: "web_animation_space", attempt: 0, fence: null, phase: null, billedAt: null,
      resultSourceVersionId: null, resultAssetId: null,
    });
  });

  it("stores the origin the caller gives, queued", async () => {
    const { projectId, ownerId } = await seedProject();
    const row = await timelineExecutionRepo.insert({
      projectId, spaceId: randomUUID(), actorUserId: ownerId, kind: "web_animation_create", engine: "deepseek",
      actionId: randomUUID(), input: {}, inputHash: "sha256:legacy", deadlineAt: new Date(Date.now() + 60_000),
      origin: "timeline",
    });
    if (row === null) throw new Error("Fixture execution conflicted");
    owned.executions.push(row.id);
    expect(row).toMatchObject({ status: "queued", origin: "timeline" });
  });

  it("queues a row inserted without a status and refuses one without an origin", async () => {
    const { projectId, ownerId } = await seedProject();
    const insertWithout = (origin: string | null): Promise<{ id: string; status: string }[]> => sql<{ id: string; status: string }[]>`
      INSERT INTO timeline_executions (project_id, space_id, actor_user_id, kind, engine, action_id, input, input_hash, deadline_at, origin)
      VALUES (${projectId}, ${randomUUID()}, ${ownerId}, 'web_animation_create', 'deepseek', ${randomUUID()}, '{}'::jsonb, 'sha256:input',
        now() + interval '2 hours', ${origin})
      RETURNING id, status`;
    const [row] = await insertWithout("web_animation_space");
    owned.executions.push(row!.id);
    expect(row!.status).toBe("queued");
    await expect(insertWithout(null)).rejects.toMatchObject({ code: "23502" });
  });

  it("answers null for a second insert of the same action in the same Project and Space", async () => {
    const first = await accept();
    const again = await timelineExecutionRepo.insert({
      projectId: first.projectId, spaceId: first.spaceId, actorUserId: first.actorUserId, kind: "web_animation_create",
      engine: "deepseek", actionId: first.actionId, input: {}, inputHash: "sha256:other", deadlineAt: new Date(Date.now() + 60_000),
      origin: "web_animation_space",
    });
    expect(again).toBeNull();
    expect(await timelineExecutionRepo.findByAction({ projectId: first.projectId, spaceId: first.spaceId, actionId: first.actionId }))
      .toMatchObject({ id: first.id, inputHash: "sha256:input" });
  });

  it("keeps the same action id in another Project apart, as a duplicated Project's copy does", async () => {
    const first = await accept();
    const other = await seedProject();
    const second = await accept({ ...other, spaceId: first.spaceId, actionId: first.actionId });
    expect(second.id).not.toBe(first.id);
  });
});

describe("timelineExecutionRepo.transition — the state matrix", () => {
  for (const state of Object.keys(MATRIX) as Setup[]) {
    EVENTS.forEach((event, column) => {
      const expected = MATRIX[state][column];
      it(`${state} + ${event} → ${expected}`, async () => {
        const row = await reach(state);
        if (event === "deadline") await passDeadline(row.id);
        const result = await timelineExecutionRepo.transition({ id: row.id, event: eventFor(event, row) });
        expect(result.row.status).toBe(expected);
        expect((await read(row.id)).status).toBe(expected);
        expect(result.applied).toBe(expected !== state || (state === "running" && event === "retry"));
      });
    });
  }
});

describe("timelineExecutionRepo.transition — fence, deadline and payloads", () => {
  it("gives every claim and retry a new attempt and a new fence, keeping the original deadline", async () => {
    const running = await reach("running");
    expect(running.attempt).toBe(1);
    expect(running.fence).toMatch(/^[0-9a-f-]{36}$/);
    const retried = await timelineExecutionRepo.transition({ id: running.id, event: { type: "retry" } });
    expect(retried.row.attempt).toBe(2);
    expect(retried.row.fence).not.toBe(running.fence);
    expect(retried.row.deadlineAt).toBe(running.deadlineAt);
  });

  it("ignores a success from an attempt whose fence was replaced", async () => {
    const running = await reach("running");
    await timelineExecutionRepo.transition({ id: running.id, event: { type: "retry" } });
    const stale = await timelineExecutionRepo.transition({
      id: running.id, event: { type: "success", fence: running.fence, resultSourceVersionId: randomUUID() },
    });
    expect(stale.applied).toBe(false);
    expect((await read(running.id)).status).toBe("running");
  });

  it("ignores a failure from a replaced fence on a running row", async () => {
    const running = await reach("running");
    await timelineExecutionRepo.transition({ id: running.id, event: { type: "retry" } });
    const stale = await timelineExecutionRepo.transition({ id: running.id, event: { type: "failure", fence: running.fence, reason: "x" } });
    expect(stale.applied).toBe(false);
  });

  it("stores the source version on success and the reason on failure", async () => {
    const running = await reach("running");
    const sourceVersionId = randomUUID();
    await timelineExecutionRepo.transition({ id: running.id, event: { type: "success", fence: running.fence, resultSourceVersionId: sourceVersionId } });
    expect(await read(running.id)).toMatchObject({ status: "succeeded", resultSourceVersionId: sourceVersionId, fence: null });

    const other = await reach("running");
    await timelineExecutionRepo.transition({ id: other.id, event: { type: "failure", fence: other.fence, reason: "dsh_failed" } });
    expect(await read(other.id)).toMatchObject({ status: "failed", failureReason: "dsh_failed" });
  });

  it("ignores a deadline event before the original deadline", async () => {
    const running = await reach("running");
    const result = await timelineExecutionRepo.transition({ id: running.id, event: { type: "deadline" } });
    expect(result.applied).toBe(false);
    expect((await read(running.id)).status).toBe("running");
  });

  it("records the phase a running attempt reports, only for the current fence", async () => {
    const running = await reach("running");
    const reported = await timelineExecutionRepo.transition({ id: running.id, event: { type: "progress", fence: running.fence, phase: "validating" } });
    expect(reported).toMatchObject({ applied: true, row: { status: "running", phase: "validating" } });
    await timelineExecutionRepo.transition({ id: running.id, event: { type: "retry" } });
    const stale = await timelineExecutionRepo.transition({ id: running.id, event: { type: "progress", fence: running.fence, phase: "saving" } });
    expect(stale.applied).toBe(false);
    expect((await read(running.id)).phase).toBe("validating");
  });
});

describe("timelineExecutionRepo.transition — invariants over any event sequence", () => {
  const eventName = fc.constantFrom<EventName>(...EVENTS);

  it("reaches at most one terminal state, never leaves it, and never moves the deadline", async () => {
    await fc.assert(fc.asyncProperty(fc.array(eventName, { minLength: 1, maxLength: 12 }), async (names) => {
      const accepted = await accept();
      let previous = accepted;
      let terminal: TimelineExecutionStatus | null = null;
      for (const name of names) {
        if (name === "deadline") await passDeadline(accepted.id);
        const { row } = await timelineExecutionRepo.transition({ id: accepted.id, event: eventFor(name, previous) });
        if (terminal !== null) expect(row.status).toBe(terminal);
        if (["succeeded", "failed", "cancelled", "expired"].includes(row.status)) terminal ??= row.status;
        expect(row.attempt).toBeGreaterThanOrEqual(previous.attempt);
        if (name !== "deadline") expect(row.deadlineAt).toBe(previous.deadlineAt);
        if (row.attempt === previous.attempt && row.fence !== null && previous.fence !== null) expect(row.fence).toBe(previous.fence);
        previous = row;
      }
    }), { numRuns: 25 });
  });
});

describe("timelineExecutionRepo.markBilled — the billed_at gate", () => {
  it("marks an execution billed once and answers false afterwards", async () => {
    const row = await reach("succeeded");
    expect(await timelineExecutionRepo.markBilled(row.id, "1.25")).toBe(true);
    expect(await timelineExecutionRepo.markBilled(row.id, "9.99")).toBe(false);
    expect(await read(row.id)).toMatchObject({ billedCredits: "1.25" });
    expect((await read(row.id)).billedAt).not.toBeNull();
  });

  it("lets exactly one of two concurrent writers through", async () => {
    const row = await reach("succeeded");
    const gate = await sql.reserve();
    await gate`BEGIN`;
    await gate`SELECT id FROM timeline_executions WHERE id = ${row.id} FOR UPDATE`;
    const writers = [
      db.transaction((tx) => timelineExecutionRepo.markBilled(row.id, "1.00", tx)),
      db.transaction((tx) => timelineExecutionRepo.markBilled(row.id, "1.00", tx)),
    ];
    await waitUntilBlockedOn(sql, ["timeline_executions", "billed_at"], 2);
    await gate`COMMIT`;
    gate.release();
    expect((await Promise.all(writers)).sort()).toEqual([false, true]);
  });
});

describe("timelineExecutionRepo reads", () => {

  it("offers every non-terminal row to the worker sweep and no terminal one", async () => {
    const rows = await Promise.all((["awaiting_landing", "queued", "running", "cancelling", "succeeded", "failed", "cancelled", "expired"] as const).map(reach));
    const due = await timelineExecutionRepo.listForSweep({ limit: 1000 });
    const dueIds = new Set(due.map((row) => row.id));
    expect(rows.filter((row) => dueIds.has(row.id)).map((row) => row.status).sort())
      .toEqual(["awaiting_landing", "cancelling", "queued", "running"]);
  });
});
