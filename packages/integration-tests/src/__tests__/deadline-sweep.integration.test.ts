// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The worker's deadline sweep (#1580 test spec area C; design §2.3).
 *
 * Notifications and holds expire without a write, and a project transfer
 * expires only when something reads it, so no trigger fires when their time
 * comes. Each round of `sweepDeadlines` looks at what came due in
 * `(watermark, now]`, announces it on the same `live_updates` channel the
 * triggers use, writes overdue pending transfers as failed / expired together
 * with retiring their bell entry, and advances the watermark only after the
 * round succeeds.
 *
 * Real database and Redis. The clock is the `now` each round is handed.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_count: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import {
  createPgClient,
  getNodeTaskConfig,
  getWorkerConfig,
  initCore,
  listenLiveUpdates,
  loadLocales,
  type LiveUpdate,
  type LiveUpdatesListener,
} from "@breatic/core";
import { readDeadlineWatermark, sweepDeadlines, writeDeadlineWatermark } from "@worker/handlers/deadline-sweep.js";
import { threeDSpaceDocName } from "@breatic/shared";
import { listenSpaceTaskSignals, spaceTasksVersion } from "@server/__tests__/integration/helpers/space-task-signals.js";

let sql: ReturnType<typeof createPgClient>;
let listener: LiveUpdatesListener;
const updates: LiveUpdate[] = [];
const MINUTE = 60_000;

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "deadline-sweep-driver", max: 4, prepare: false });
  listener = await listenLiveUpdates({
    onUpdate: (u) => {
      updates.push(u);
    },
    onListening: () => {},
    onInvalid: () => {},
  });
});

afterAll(async () => {
  await listener?.stop();
  await sql?.end({ timeout: 1 });
});

/** A user. */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, email_verified) values (${`ds-${randomUUID()}@example.test`}, true) returning id
  `;
  return row!.id;
}

/** A team studio administered by `admin`, with one project they own. */
async function studioWithProject(admin: string): Promise<{ studioId: string; projectId: string }> {
  const [studio] = await sql<{ id: string }[]>`
    insert into studios (created_by_user_id, slug, type, name) values (${admin}, ${`ds-${randomUUID()}`}, 'team', 'DS') returning id
  `;
  await sql`insert into studio_members (studio_id, user_id, role) values (${studio!.id}, ${admin}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    insert into projects (studio_id, created_by_user_id, slug, name) values (${studio!.id}, ${admin}, ${`ds-${randomUUID()}`}, 'DS') returning id
  `;
  await sql`insert into project_members (project_id, user_id, role) values (${project!.id}, ${admin}, 'owner')`;
  return { studioId: studio!.id, projectId: project!.id };
}

/** An actionable notification for `userId` that expires at `at`. */
async function notice(userId: string, at: Date | null, over: { read?: boolean; deleted?: boolean } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into notifications (user_id, type, payload, expires_at, read_at, deleted_at)
    values (${userId}, 'project.invite_request', '{}'::jsonb, ${at}, ${over.read === true ? new Date() : null}, ${over.deleted === true ? new Date() : null})
    returning id
  `;
  return row!.id;
}

/**
 * One round at `now` from watermark `from`, returning what it announced. The
 * round commits before it returns, so a probe afterwards has seen everything.
 */
async function round(from: Date | null, now: Date): Promise<LiveUpdate[]> {
  if (from !== null) await writeDeadlineWatermark(from);
  const before = updates.length;
  await sweepDeadlines({ now });
  expect(await listener.probe(2000)).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  return updates.slice(before);
}

/** Whether `got` holds a bell change for `userId`. */
function bellFor(got: LiveUpdate[], userId: string): boolean {
  return got.some((u) => u.k === "notifications" && u.u === userId);
}

describe("notifications that come due", () => {
  it("C-03 and C-04 announce each recipient with a notification due in the window, and no one else", async () => {
    const [u, v, w] = [await user(), await user(), await user()];
    const now = new Date();
    const w0 = new Date(now.getTime() - 10 * MINUTE);
    await notice(u, new Date(now.getTime() - 5 * MINUTE));
    await notice(u, new Date(now.getTime() - 4 * MINUTE));
    await notice(v, new Date(now.getTime() - 3 * MINUTE));
    await notice(w, new Date(now.getTime() + 10 * MINUTE));
    const got = await round(w0, now);
    expect(bellFor(got, u)).toBe(true);
    expect(bellFor(got, v)).toBe(true);
    expect(bellFor(got, w)).toBe(false);
  });

  it("C-05 and C-06 skip a deleted notification and one with no deadline", async () => {
    const [u, v] = [await user(), await user()];
    const now = new Date();
    await notice(u, new Date(now.getTime() - MINUTE), { deleted: true });
    await notice(v, null);
    const got = await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect(bellFor(got, u)).toBe(false);
    expect(bellFor(got, v)).toBe(false);
  });

  it("C-07 announces a notification in the round that crosses its deadline, not before", async () => {
    const u = await user();
    const now = new Date();
    const due = new Date(now.getTime() + 2 * MINUTE);
    await notice(u, due);
    expect(bellFor(await round(new Date(now.getTime() - MINUTE), now), u)).toBe(false);
    expect(bellFor(await round(null, new Date(due.getTime() + MINUTE)), u)).toBe(true);
  });

  it("C-08 treats the window as open below and closed above", async () => {
    const [atLower, atUpper] = [await user(), await user()];
    const now = new Date();
    const w0 = new Date(now.getTime() - 10 * MINUTE);
    await notice(atLower, w0);
    await notice(atUpper, now);
    const got = await round(w0, now);
    expect(bellFor(got, atLower)).toBe(false);
    expect(bellFor(got, atUpper)).toBe(true);
  });

  it("C-09 announces a read notification that comes due too", async () => {
    const u = await user();
    const now = new Date();
    await notice(u, new Date(now.getTime() - MINUTE), { read: true });
    expect(bellFor(await round(new Date(now.getTime() - 10 * MINUTE), now), u)).toBe(true);
  });
});

describe("holds that come due", () => {
  it("C-10 and C-11 announce the studio of a held hold due in the window, not of a released one", async () => {
    const admin = await user();
    const held = await studioWithProject(admin);
    const released = await studioWithProject(admin);
    const now = new Date();
    const due = new Date(now.getTime() - MINUTE);
    await sql`insert into credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at)
      values (${held.studioId}, ${admin}, ${`ds-${randomUUID()}`}, 1, ${due})`;
    await sql`insert into credit_holds (studio_id, actor_user_id, reference_id, amount, status, expires_at, released_at)
      values (${released.studioId}, ${admin}, ${`ds-${randomUUID()}`}, 1, 'released', ${due}, now())`;
    const got = await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect(got).toContainEqual({ k: "credits", s: held.studioId });
    expect(got).not.toContainEqual({ k: "credits", s: released.studioId });
  });
});

describe("project transfers that come due", () => {
  /** A pending transfer with a bell entry for its recipient. */
  async function transfer(due: Date, over: { status?: string; deleted?: boolean } = {}): Promise<{
    id: string; projectId: string; to: string; noteId: string;
  }> {
    const owner = await user();
    const to = await user();
    const { projectId } = await studioWithProject(owner);
    const noteId = await notice(to, due);
    const [row] = await sql<{ id: string }[]>`
      insert into project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token, notification_id, deleted_at)
      values (${projectId}, ${owner}, ${to}, ${over.status ?? "pending"}, ${due}, ${randomUUID()}, ${noteId}, ${over.deleted === true ? new Date() : null})
      returning id
    `;
    return { id: row!.id, projectId, to, noteId };
  }

  async function state(id: string): Promise<{ status: string; failed_reason: string | null; decided_at: Date | null }> {
    const [row] = await sql<{ status: string; failed_reason: string | null; decided_at: Date | null }[]>`
      select status, failed_reason, decided_at from project_transfers where id = ${id}
    `;
    return row!;
  }

  it("C-12 writes an overdue pending transfer as failed, expired, and retires its bell entry", async () => {
    const now = new Date();
    const t = await transfer(new Date(now.getTime() - MINUTE));
    const got = await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect(await state(t.id)).toEqual({ status: "failed", failed_reason: "expired", decided_at: null });
    const [note] = await sql<{ read_at: Date | null }[]>`select read_at from notifications where id = ${t.noteId}`;
    expect(note!.read_at).not.toBeNull();
    expect(got).toContainEqual({ k: "project-transfer", p: t.projectId });
    expect(bellFor(got, t.to)).toBe(true);
  });

  it("C-13 leaves a pending transfer that is not yet due", async () => {
    const now = new Date();
    const t = await transfer(new Date(now.getTime() + 10 * MINUTE));
    await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect((await state(t.id)).status).toBe("pending");
  });

  it.each(["accepted", "declined", "cancelled"])("C-14 leaves an ended %s transfer", async (status) => {
    const now = new Date();
    const t = await transfer(new Date(now.getTime() - MINUTE), { status });
    await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect((await state(t.id)).status).toBe(status);
  });

  it("C-15 leaves a deleted pending transfer", async () => {
    const now = new Date();
    const t = await transfer(new Date(now.getTime() - MINUTE), { deleted: true });
    await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect((await state(t.id)).status).toBe("pending");
  });

  it("C-16 expires a pending transfer that fell due before the watermark", async () => {
    const now = new Date();
    const t = await transfer(new Date(now.getTime() - 60 * MINUTE));
    await round(new Date(now.getTime() - 10 * MINUTE), now);
    expect(await state(t.id)).toMatchObject({ status: "failed", failed_reason: "expired" });
  });
});

/**
 * A 3D Space's own row (no node) that started at `startedAt`, running, or waiting for a running slot.
 * @returns The row id.
 */
async function sceneRow(projectId: string, spaceId: string, userId: string, startedAt: Date, waiting = false): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into node_tasks (project_id, space_id, node_id, kind, action, status, started_by_user_id, started_at, waiting_since, budget_ms, label, origin)
    values (${projectId}, ${spaceId}, null, 'generation', 'generate', 'running', ${userId}, ${startedAt}, ${waiting ? startedAt : null},
      ${getNodeTaskConfig().default_budget_ms}, 'tripo-h3.1-t23d', 'space')
    returning id
  `;
  return row!.id;
}

/** A node task row's status. */
async function rowStatus(id: string): Promise<{ status: string; error_message: string | null }> {
  const [row] = await sql<{ status: string; error_message: string | null }[]>`select status, error_message from node_tasks where id = ${id}`;
  return row!;
}

describe("3D Space rows that come due", () => {
  it("C-19 expires a running row past its budget and tells the 3D Space's document", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    const budget = getNodeTaskConfig().default_budget_ms;
    const admin = await user();
    const { projectId } = await studioWithProject(admin);
    const spaceId = randomUUID();
    const now = new Date();
    const id = await sceneRow(projectId, spaceId, admin, new Date(now.getTime() - budget - interval / 2));
    const docName = threeDSpaceDocName(projectId, spaceId);
    const signals = await listenSpaceTaskSignals();
    try {
      await signals.mark();
      await round(new Date(now.getTime() - interval), now);
      expect(await rowStatus(id)).toEqual({ status: "expired", error_message: "expired" });
      expect(await signals.read({ projectId, spaceId, docName })).toEqual({ doc: [spaceTasksVersion(docName)], meta: [] });
    } finally {
      await signals.stop();
    }
  });

  it("C-20 leaves a row waiting for a running slot, which has no deadline yet, and tells no one", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    const budget = getNodeTaskConfig().default_budget_ms;
    const admin = await user();
    const { projectId } = await studioWithProject(admin);
    const spaceId = randomUUID();
    const now = new Date();
    const id = await sceneRow(projectId, spaceId, admin, new Date(now.getTime() - budget - interval / 2), true);
    const docName = threeDSpaceDocName(projectId, spaceId);
    const signals = await listenSpaceTaskSignals();
    try {
      await signals.mark();
      await round(new Date(now.getTime() - interval), now);
      expect(await rowStatus(id)).toEqual({ status: "running", error_message: null });
      expect(await signals.read({ projectId, spaceId, docName })).toEqual({ doc: [], meta: [] });
    } finally {
      await signals.stop();
    }
  });
});

describe("the watermark", () => {
  it("C-21 and C-22 start one interval back when there is none, then move to the round's now", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    const [inside, outside] = [await user(), await user()];
    const now = new Date();
    await notice(inside, new Date(now.getTime() - interval / 2));
    await notice(outside, new Date(now.getTime() - 2 * interval));
    await writeDeadlineWatermark(null);
    const got = await round(null, now);
    expect(bellFor(got, inside)).toBe(true);
    expect(bellFor(got, outside)).toBe(false);
    expect((await readDeadlineWatermark())?.getTime()).toBe(now.getTime());
  });

  it("C-24 catches up on everything due while the worker was down", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    const users = [await user(), await user(), await user()];
    const w0 = new Date(Date.now() - 5 * interval);
    for (const [i, u] of users.entries()) await notice(u, new Date(w0.getTime() + (i + 1) * interval));
    const got = await round(w0, new Date(w0.getTime() + 5 * interval));
    for (const u of users) expect(bellFor(got, u)).toBe(true);
  });

  it("C-26 moves the watermark even when nothing came due", async () => {
    const now = new Date(Date.now() + 365 * 24 * 60 * MINUTE);
    await round(new Date(now.getTime() - MINUTE), now);
    expect((await readDeadlineWatermark())?.getTime()).toBe(now.getTime());
    await writeDeadlineWatermark(new Date());
  });
});
