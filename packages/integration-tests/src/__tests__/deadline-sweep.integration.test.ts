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
import fc from "fast-check";
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
  getStreamRedis,
  getWorkerConfig,
  taskEventsStreamKey,
  initCore,
  listenLiveUpdates,
  listenProjectMemberChanges,
  loadLocales,
  type LiveUpdate,
  type LiveUpdatesListener,
  type MemberChangeListener,
} from "@breatic/core";
import { readDeadlineWatermark, sweepDeadlines, writeDeadlineWatermark } from "@worker/handlers/deadline-sweep.js";
import { sceneTaskService } from "@breatic/domain";
import { canvasSpaceDocName, FOCUS_IMAGE_UPLOAD_EVENT_TYPE, threeDSpaceDocName } from "@breatic/shared";
import { confirmProjectTransfer, declineProjectTransfer, withdrawProjectTransfer } from "@server/modules/project/projectTransfer.service.js";
import { listenSpaceTaskSignals, spaceTasksVersion } from "@server/__tests__/integration/helpers/space-task-signals.js";

let sql: ReturnType<typeof createPgClient>;
let listener: LiveUpdatesListener;
/** Shares the live-updates listener's connection; its probe says that connection has caught up. */
let members: MemberChangeListener;
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
  members = await listenProjectMemberChanges({ onChange: () => {}, onListening: () => {}, onInvalid: () => {} });
});

afterAll(async () => {
  await listener?.stop();
  await members?.stop();
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
  expect(await members.probe(2000)).toBe(true);
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
  // A row waiting for a running slot always belongs to a task still pending in the queue.
  const [task] = waiting
    ? await sql<{ id: string }[]>`
        insert into tasks (user_id, project_id, space_id, task_type, mode, model, status, params, created_at)
        values (${userId}, ${projectId}, ${spaceId}, '3d', 'append', 'tripo-h3.1-t23d', 'pending', '{}'::jsonb, ${startedAt})
        returning id
      `
    : [undefined];
  const [row] = await sql<{ id: string }[]>`
    insert into node_tasks (project_id, space_id, node_id, task_id, kind, action, status, started_by_user_id, started_at, waiting_since, budget_ms, label, origin)
    values (${projectId}, ${spaceId}, null, ${task?.id ?? null}, 'generation', 'generate', 'running', ${userId}, ${startedAt}, ${waiting ? startedAt : null},
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
  it("C-19 tells the 3D Space's document when a running row passes its budget, and the list read it causes expires the row", async () => {
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
      expect(await signals.read({ projectId, spaceId, docName })).toEqual({ doc: [spaceTasksVersion(docName)], meta: [] });
      await sceneTaskService.harvestAndList(projectId, spaceId);
      expect(await rowStatus(id)).toEqual({ status: "expired", error_message: "expired" });
    } finally {
      await signals.stop();
    }
  });

  it("tells the 3D Space's document on the next round when the round that found it could not", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    const budget = getNodeTaskConfig().default_budget_ms;
    const admin = await user();
    const { projectId } = await studioWithProject(admin);
    const spaceId = randomUUID();
    const now = new Date();
    await sceneRow(projectId, spaceId, admin, new Date(now.getTime() - budget - interval / 2));
    const docName = threeDSpaceDocName(projectId, spaceId);
    const signals = await listenSpaceTaskSignals();
    try {
      await signals.mark();
      const from = new Date(now.getTime() - interval);
      await writeDeadlineWatermark(from);
      const spy = vi.spyOn(getStreamRedis(), "xadd").mockRejectedValueOnce(new Error("stream down"));
      try {
        await expect(sweepDeadlines({ now })).rejects.toThrow("stream down");
      } finally {
        spy.mockRestore();
      }
      expect((await readDeadlineWatermark())?.getTime()).toBe(from.getTime());
      await round(null, new Date(now.getTime() + 1000));
      expect((await signals.read({ projectId, spaceId, docName })).doc).toContainEqual(spaceTasksVersion(docName));
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

// #1580 PT-2 (invariant I7): for any due times and any round times, every item
// due after the first window opens is announced in some round, and never in a
// round whose now is before its deadline.
describe("PT-2 the sweep window under random rounds", () => {
  it("announces every item due inside the swept span, none early", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.integer({ min: 10, max: 600 }), { minLength: 1, maxLength: 4 }),
        async (dueTenths, gapTenths) => {
          run += 1;
          const w0 = new Date(Date.now() + (400 + run) * 24 * 60 * MINUTE);
          const items = await Promise.all(dueTenths.map(async (d) => {
            const u = await user();
            const due = new Date(w0.getTime() + (d * interval) / 10);
            await notice(u, due);
            return { u, due, seenAt: [] as Date[] };
          }));
          let now = w0;
          let first = true;
          for (const g of gapTenths) {
            now = new Date(now.getTime() + (g * interval) / 10);
            const got = await round(first ? w0 : null, now);
            first = false;
            for (const item of items) if (bellFor(got, item.u)) item.seenAt.push(now);
          }
          for (const item of items) {
            if (item.due.getTime() <= now.getTime()) expect(item.seenAt.length).toBeGreaterThanOrEqual(1);
            for (const at of item.seenAt) expect(at.getTime()).toBeGreaterThanOrEqual(item.due.getTime());
          }
        },
      ),
      { numRuns: 100 },
    );
    await writeDeadlineWatermark(new Date());
  });
});

// #1580 PT-7 (invariant I6): a sweep that finds a transfer due races a decision
// on it; the row leaves pending once, and a transfer no longer pending never
// points at a bell entry still unread.
describe("PT-7 a transfer coming due while it is decided", () => {
  it("ends once, and retires its bell entry whichever side wins", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("confirm", "decline", "withdraw"), fc.boolean(), async (action, sweepFirst) => {
        const owner = await user();
        const to = await user();
        const { projectId } = await studioWithProject(owner);
        await sql`insert into project_members (project_id, user_id, role, added_by) values (${projectId}, ${to}, 'editor', ${owner})`;
        const due = new Date(Date.now() + MINUTE);
        const [note] = await sql<{ id: string }[]>`
          insert into notifications (user_id, type, payload, expires_at) values (${to}, 'project.transfer_request', '{}'::jsonb, ${due}) returning id
        `;
        const [row] = await sql<{ id: string }[]>`
          insert into project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token, notification_id)
          values (${projectId}, ${owner}, ${to}, 'pending', ${due}, ${randomUUID()}, ${note!.id}) returning id
        `;
        const decide = (): Promise<unknown> =>
          action === "confirm" ? confirmProjectTransfer(row!.id, to)
            : action === "decline" ? declineProjectTransfer(row!.id, to)
              : withdrawProjectTransfer(row!.id, projectId, owner);
        await writeDeadlineWatermark(new Date(Date.now() - MINUTE));
        const sweep = (): Promise<unknown> => sweepDeadlines({ now: new Date(Date.now() + 10 * MINUTE) });
        const [a, b] = await Promise.allSettled(sweepFirst ? [sweep(), decide()] : [decide(), sweep()]);
        const decided = (sweepFirst ? b : a).status === "fulfilled";
        expect((sweepFirst ? a : b).status).toBe("fulfilled");
        const [after] = await sql<{ status: string; failed_reason: string | null }[]>`select status, failed_reason from project_transfers where id = ${row!.id}`;
        // It left pending; a decision that went through was not overwritten as expired (a refused one may have ended it
        // its own way, or left it to the sweep).
        expect(after!.status).not.toBe("pending");
        if (decided) expect(after!.status === "failed" && after!.failed_reason === "expired").toBe(false);
        const [bell] = await sql<{ read_at: Date | null; deleted_at: Date | null }[]>`select read_at, deleted_at from notifications where id = ${note!.id}`;
        expect(bell!.read_at !== null || bell!.deleted_at !== null).toBe(true);
      }),
      { numRuns: 100 },
    );
    await writeDeadlineWatermark(new Date());
  });
});

// #1580 C-18 and C-23: a round that fails keeps nothing of the transfer it was
// ending and leaves the watermark, so the next round does it all again.
describe("a round that fails", () => {
  it("rolls the transfer back with its bell entry, leaves the watermark, and the next round catches up", async () => {
    const owner = await user();
    const to = await user();
    const { projectId } = await studioWithProject(owner);
    const now = new Date();
    const noteId = await notice(to, new Date(now.getTime() - MINUTE));
    const [row] = await sql<{ id: string }[]>`
      insert into project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token, notification_id)
      values (${projectId}, ${owner}, ${to}, 'pending', ${new Date(now.getTime() - MINUTE)}, ${randomUUID()}, ${noteId}) returning id
    `;
    const w0 = new Date(now.getTime() - 10 * MINUTE);
    await sql.unsafe(`create or replace function pt_c18_refuse() returns trigger language plpgsql as $$
      begin if new.id = '${noteId}' and new.read_at is not null then raise exception 'c18 refuses'; end if; return new; end $$`);
    await sql.unsafe("create trigger pt_c18_refuse before update on notifications for each row execute function pt_c18_refuse()");
    try {
      await writeDeadlineWatermark(w0);
      await expect(sweepDeadlines({ now })).rejects.toThrow();
      const [still] = await sql<{ status: string }[]>`select status from project_transfers where id = ${row!.id}`;
      expect(still!.status).toBe("pending");
      expect((await readDeadlineWatermark())?.getTime()).toBe(w0.getTime());
    } finally {
      await sql.unsafe("drop trigger if exists pt_c18_refuse on notifications");
      await sql.unsafe("drop function if exists pt_c18_refuse()");
    }
    const got = await round(null, new Date(now.getTime() + 1000));
    const [ended] = await sql<{ status: string; failed_reason: string | null }[]>`select status, failed_reason from project_transfers where id = ${row!.id}`;
    expect(ended).toEqual({ status: "failed", failed_reason: "expired" });
    expect(bellFor(got, to)).toBe(true);
  });
});

describe("focus crops whose upload never ended", () => {
  /** A focus crop's grant opened at `openedAt` on a node of `spaceId`, consumed when asked. */
  async function focusGrant(
    owner: { userId: string; studioId: string; projectId: string },
    spaceId: string,
    openedAt: Date,
    consumed = false,
  ): Promise<{ id: string; nodeId: string }> {
    const focus = { spaceId, nodeId: randomUUID(), id: randomUUID(), name: "Crop", width: 64, height: 48 };
    await sql`
      insert into upload_grants (user_id, studio_id, storage_key, declared_size, expires_at, project_id, space_id, focus_image, created_at, consumed_at)
      values (${owner.userId}, ${owner.studioId}, ${`image/${randomUUID()}.png`}, 4096, ${new Date(openedAt.getTime() + MINUTE)},
        ${owner.projectId}, ${spaceId}, ${sql.json(focus)}, ${openedAt}, ${consumed ? openedAt : null})
    `;
    return { id: focus.id, nodeId: focus.nodeId };
  }

  /** The focus-crop steps on the stream for `docName`, oldest first. */
  async function focusSteps(docName: string): Promise<Record<string, unknown>[]> {
    const raw = (await getStreamRedis().xrange(taskEventsStreamKey(), "-", "+")) as [string, string[]][];
    return raw
      .map(([, fields]) => JSON.parse(fields[fields.indexOf("payload") + 1]!) as Record<string, unknown>)
      .filter((e) => e.type === FOCUS_IMAGE_UPLOAD_EVENT_TYPE && e.docName === docName);
  }

  it("ends as failed, at its two hours, a crop whose upload is still open, and leaves one that ended", async () => {
    const interval = getWorkerConfig().deadline_sweep.interval_ms;
    const budget = getNodeTaskConfig().default_budget_ms;
    const admin = await user();
    const { studioId, projectId } = await studioWithProject(admin);
    const spaceId = randomUUID();
    const now = new Date();
    const due = new Date(now.getTime() - budget - interval / 2);
    const open = await focusGrant({ userId: admin, studioId, projectId }, spaceId, due);
    await focusGrant({ userId: admin, studioId, projectId }, spaceId, due, true);
    await focusGrant({ userId: admin, studioId, projectId }, spaceId, new Date(now.getTime() - budget + interval));
    await round(new Date(now.getTime() - interval), now);
    expect(await focusSteps(canvasSpaceDocName(projectId, spaceId))).toEqual([
      { type: FOCUS_IMAGE_UPLOAD_EVENT_TYPE, docName: canvasSpaceDocName(projectId, spaceId), nodeId: open.nodeId, state: "failed", id: open.id },
    ]);
  });
});
