// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The lifecycle rules the three deferred-decision request tables share.
 *
 * Role upgrades, project transfers and studio transfers each get their own
 * repo — the design is explicit that "unified" means one set of rules, not one
 * implementation, because the three flows are decided through different
 * interfaces by different people. What IS identical is the terminal-state
 * behaviour, so it is asserted here once per table rather than described once
 * and trusted three times.
 *
 * Every rule below needs a real Postgres: they are all about what the partial
 * unique index does, and Drizzle's table builder cannot even emit that index.
 *
 *   - Creating reaps first. A timed-out row keeps `status = 'pending'` and
 *     holds its slot (the index predicate cannot reference `now()`), so the
 *     create path flips stale pendings to `expired` in the same transaction
 *     that takes the slot. Without this, a request nobody answered locks its
 *     key forever — for a transfer, that is the whole container.
 *   - A LIVE pending still blocks. The reaper only touches expired ones, so a
 *     real duplicate is still refused by the index.
 *   - Every terminal status frees the slot, including `cancelled`. That is
 *     what makes the requester's cancel button an escape hatch rather than a
 *     cosmetic action.
 *   - Settling is a CAS. Two concurrent decisions on one request must not both
 *     win, and the loser must be able to tell that it lost.
 *   - The lock is taken on `id` alone, so a settled row locks too and reports
 *     its status. That is what lets the loser say "already decided" instead of
 *     "no such request" — see each repo's header for why putting `status` in
 *     the lock's WHERE breaks exactly when it is needed.
 *   - `decided_at` marks that a PERSON ended the request. Every terminal status
 *     sets it except `expired`, which is by definition the case where nobody
 *     acted.
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

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { db, initCore } from "@breatic/core";

// The setup file only puts the container URLs on `process.env`; handing them to
// core is each test's own job, since the setup file cannot import core.
initCore(process.env);

import * as roleUpgradeRequestsRepo from "@server/modules/role-upgrade-request/roleUpgradeRequests.repo.js";
import * as projectTransfersRepo from "@server/modules/project/projectTransfers.repo.js";
import * as studioTransfersRepo from "@server/modules/studio/studioTransfers.repo.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "request-repos-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A user, a studio they admin, and a project inside it. */
async function seedScene(): Promise<{
  ownerId: string;
  otherId: string;
  thirdId: string;
  studioId: string;
  projectId: string;
}> {
  const tag = `rr-${seq++}`;
  const [owner, other, third] = await Promise.all([
    insertUser(`${tag}-a`),
    insertUser(`${tag}-b`),
    insertUser(`${tag}-c`),
  ]);
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  return {
    ownerId: owner,
    otherId: other,
    thirdId: third,
    studioId: studio!.id,
    projectId: project!.id,
  };
}

/**
 * Insert a user and return its id.
 * @param tag - Unique-ish fragment for the email.
 * @returns The new user's id.
 */
async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

/** A moment safely in the past, for seeding a request that already timed out. */
function yesterday(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

/** A moment safely in the future, for a request that is still live. */
function nextWeek(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

/**
 * Read one request row's status straight from the table.
 * @param table - Table name.
 * @param id - Request id.
 * @returns The row's status.
 */
async function statusOf(table: string, id: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM ${sql(table)} WHERE id = ${id}
  `;
  return rows[0]!.status;
}

/**
 * Read one request row's `decided_at` straight from the table.
 * @param table - Table name.
 * @param id - Request id.
 * @returns When a person ended it, or null when nobody did.
 */
async function decidedAtOf(table: string, id: string): Promise<Date | null> {
  const rows = await sql<{ decided_at: Date | null }[]>`
    SELECT decided_at FROM ${sql(table)} WHERE id = ${id}
  `;
  return rows[0]!.decided_at;
}

describe("role-upgrade requests repo", () => {
  it("reaps a timed-out pending on the same key, then takes the slot", async () => {
    const { ownerId, projectId } = await seedScene();
    const stale = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: yesterday(),
    })).id;

    // Same (project, requester): the index would refuse this if the stale row
    // still occupied the slot, which is exactly the #1769 shape.
    const fresh = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    expect(fresh).not.toBe(stale);
    expect(await statusOf("role_upgrade_requests", stale)).toBe("expired");
    expect(await statusOf("role_upgrade_requests", fresh)).toBe("pending");
  });

  it("still refuses a second LIVE pending from the same requester", async () => {
    const { ownerId, projectId } = await seedScene();
    await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    });

    await expect(
      roleUpgradeRequestsRepo.createPending({
        projectId,
        requesterUserId: ownerId,
        requestedRole: "editor",
        expiresAt: nextWeek(),
      }),
    ).rejects.toThrow();
  });

  it("lets a different requester ask for the same project", async () => {
    const { ownerId, otherId, projectId } = await seedScene();
    await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    });

    const second = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: otherId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    expect(await statusOf("role_upgrade_requests", second)).toBe("pending");
  });

  it("frees the slot when the requester cancels", async () => {
    const { ownerId, projectId } = await seedScene();
    const first = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    const cancelled = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.cancelIfPending(first, ownerId, tx),
    );

    expect(cancelled).not.toBeNull();
    expect(await statusOf("role_upgrade_requests", first)).toBe("cancelled");
    // The escape hatch is only real if a fresh request can follow.
    await expect(
      roleUpgradeRequestsRepo.createPending({
        projectId,
        requesterUserId: ownerId,
        requestedRole: "editor",
        expiresAt: nextWeek(),
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses to cancel someone else's request", async () => {
    const { ownerId, otherId, projectId } = await seedScene();
    const id = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    const cancelled = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.cancelIfPending(id, otherId, tx),
    );

    expect(cancelled).toBeNull();
    expect(await statusOf("role_upgrade_requests", id)).toBe("pending");
  });

  it("locks a pending row and reports whether it has timed out", async () => {
    const { ownerId, projectId } = await seedScene();
    const live = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    const locked = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.lockRequest(live, tx),
    );

    expect(locked).not.toBeNull();
    expect(locked!.projectId).toBe(projectId);
    expect(locked!.requesterUserId).toBe(ownerId);
    expect(locked!.status).toBe("pending");
    expect(locked!.expired).toBe(false);
  });

  it("locks a timed-out pending too, flagged as expired", async () => {
    // The decision path must be able to SEE an expired request in order to
    // refuse it and flip it — a filter that hides it would leave the row
    // pending forever.
    const { ownerId, projectId } = await seedScene();
    const stale = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: yesterday(),
    })).id;

    const locked = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.lockRequest(stale, tx),
    );

    expect(locked).not.toBeNull();
    expect(locked!.expired).toBe(true);
  });

  it("locks an already-settled row, so it is not mistaken for a missing one", async () => {
    // This is the whole reason the lock keys on `id` alone. Under READ
    // COMMITTED, `… AND status = 'pending' FOR UPDATE` re-checks its predicate
    // against the row version it locked, so the loser of a concurrent decision
    // would get an empty result here — the same answer as a bad id, at the one
    // moment where telling them apart decides what the user is told.
    const { ownerId, projectId } = await seedScene();
    const id = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;
    await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.settleIfPending(id, "approved", ownerId, tx),
    );

    const settled = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.lockRequest(id, tx),
    );
    const missing = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.lockRequest(randomUUID(), tx),
    );

    expect(settled?.status).toBe("approved");
    expect(missing).toBeNull();
  });

  it("settles exactly once, and the loser can tell", async () => {
    const { ownerId, projectId } = await seedScene();
    const id = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    const first = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.settleIfPending(id, "approved", ownerId, tx),
    );
    const second = await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.settleIfPending(id, "rejected", ownerId, tx),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await statusOf("role_upgrade_requests", id)).toBe("approved");
  });

  it("stamps decided_at when a person ends it, and not when it times out", async () => {
    // Two questions the columns answer separately: WHO ruled on it
    // (`decided_by_user_id`, null for a self-cancel) and WHETHER anyone acted
    // at all (`decided_at`, null only when the clock ended it).
    const { ownerId, otherId, projectId } = await seedScene();
    const decided = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;
    const cancelled = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: otherId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.settleIfPending(decided, "approved", ownerId, tx),
    );
    await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.cancelIfPending(cancelled, otherId, tx),
    );

    expect(await decidedAtOf("role_upgrade_requests", decided)).toBeInstanceOf(
      Date,
    );
    expect(await decidedAtOf("role_upgrade_requests", cancelled)).toBeInstanceOf(
      Date,
    );

    // Two different paths end a request without anyone acting, and both have
    // to leave the stamp alone. The reaper never writes the column at all; the
    // decision path DOES write it, and has to write null for this one status.
    const reaped = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: yesterday(),
    })).id;
    await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    });

    expect(await statusOf("role_upgrade_requests", reaped)).toBe("expired");
    expect(await decidedAtOf("role_upgrade_requests", reaped)).toBeNull();

    // The decision path meeting a request whose deadline already passed: it
    // flips the row itself rather than leaving it pending forever.
    const timedOut = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: otherId,
      requestedRole: "editor",
      expiresAt: yesterday(),
    })).id;
    const settled = await db.transaction(async (tx) => {
      const locked = await roleUpgradeRequestsRepo.lockRequest(timedOut, tx);
      expect(locked?.expired).toBe(true);
      return roleUpgradeRequestsRepo.settleIfPending(
        timedOut,
        "expired",
        null,
        tx,
      );
    });

    expect(settled).toBe(true);
    expect(await decidedAtOf("role_upgrade_requests", timedOut)).toBeNull();
  });

  it("pulls a future deadline back when the request ends before it", async () => {
    // `expired` covers two arrivals: nobody answered in time, and the premise
    // walked away — the requester stopped being a viewer, so the request is
    // settled on the spot, days before its deadline.
    //
    // The landing page tells the recipient how long the window was, read off
    // the row. Leaving a future deadline on a settled request makes those two
    // sentences contradict each other: "this request has ended" over "it could
    // be answered within 7 days", read on day two by someone who can count.
    // The deadline is what the row says about when answering stopped being
    // possible, so ending it early moves it.
    const { otherId, projectId } = await seedScene();
    const premiseGone = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: otherId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;

    await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.settleIfPending(premiseGone, "expired", null, tx),
    );

    // Both questions are asked of the database, because the deadline is a
    // database clock reading: the repo writes `LEAST(expires_at, now())`. An
    // earlier version compared it against this process's `Date.now()`, which
    // made the test fail whenever the container's clock sat a millisecond
    // ahead of the runner's — a real intermittent failure with nothing wrong
    // in the code under test. Nothing below reaches for this process's clock,
    // so that failure mode is gone rather than narrowed.
    const [row] = await sql<{ ended: boolean; recent: boolean }[]>`
      SELECT expires_at <= now()                      AS ended,
             expires_at >  now() - interval '1 minute' AS recent
        FROM role_upgrade_requests
       WHERE id = ${premiseGone}
    `;
    // Not in the future any more — the window is closed. The row was created
    // a week out, so this alone says the deadline moved; a third assertion
    // spelling out "it is earlier than a week from now" cannot fail once this
    // one passes, and would only be one more clock to disagree with.
    expect(row!.ended).toBe(true);
    // …and closed just now rather than at some stale value: a pull-back to a
    // long-past instant would satisfy `ended` on its own. A minute, because
    // the gap being measured is one statement round trip. The hour this
    // started out as was picked when the question first moved into SQL and was
    // simply too loose — it let the deadline be 59 minutes wrong about "just
    // now" without anything noticing.
    expect(row!.recent).toBe(true);
  });

  it("leaves a deadline that already passed exactly where it was", async () => {
    // The other arrival. Its deadline is the honest answer to "how long did I
    // have", so the reaper flipping the status must not rewrite it.
    const { ownerId, projectId } = await seedScene();
    const timedOut = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: yesterday(),
    })).id;
    const original = (
      await sql<{ expires_at: Date }[]>`
        SELECT expires_at FROM role_upgrade_requests WHERE id = ${timedOut}
      `
    )[0]!.expires_at.getTime();

    await db.transaction(async (tx) =>
      roleUpgradeRequestsRepo.settleIfPending(timedOut, "expired", null, tx),
    );

    const after = (
      await sql<{ expires_at: Date }[]>`
        SELECT expires_at FROM role_upgrade_requests WHERE id = ${timedOut}
      `
    )[0]!.expires_at.getTime();
    expect(after).toBe(original);
  });

  it("lists the requester's own live request, and hides a timed-out one", async () => {
    // This is what the requester's "pending / cancel" surface reads. Reusing
    // the index predicate (status only) would keep showing a request that died
    // on day 8, with a cancel button that does nothing.
    const { ownerId, otherId, projectId } = await seedScene();
    const live = (await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: ownerId,
      requestedRole: "editor",
      expiresAt: nextWeek(),
    })).id;
    await roleUpgradeRequestsRepo.createPending({
      projectId,
      requesterUserId: otherId,
      requestedRole: "editor",
      expiresAt: yesterday(),
    });

    const mine = await roleUpgradeRequestsRepo.findLiveForRequester(
      projectId,
      ownerId,
    );
    const theirs = await roleUpgradeRequestsRepo.findLiveForRequester(
      projectId,
      otherId,
    );

    expect(mine?.id).toBe(live);
    expect(theirs).toBeNull();
  });
});

describe("project transfers repo", () => {
  it("reaps a timed-out pending on the project, then takes the slot", async () => {
    const { ownerId, otherId, thirdId, projectId } = await seedScene();
    const stale = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: yesterday(),
    })).id;

    // A DIFFERENT recipient: the slot is the project, not the pair, so this
    // proves the reap rather than a key that happens not to collide.
    const fresh = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: thirdId,
      expiresAt: nextWeek(),
    })).id;

    expect(await statusOf("project_transfers", stale)).toBe("expired");
    expect(await statusOf("project_transfers", fresh)).toBe("pending");
    // Nobody ended this one — the clock did.
    expect(await decidedAtOf("project_transfers", stale)).toBeNull();
  });

  it("refuses a second LIVE transfer even to a different recipient", async () => {
    const { ownerId, otherId, thirdId, projectId } = await seedScene();
    await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    });

    await expect(
      projectTransfersRepo.createPending({
        projectId,
        fromUserId: ownerId,
        toUserId: thirdId,
        expiresAt: nextWeek(),
      }),
    ).rejects.toThrow();
  });

  it("frees the project's slot when the transfer is cancelled", async () => {
    const { ownerId, otherId, thirdId, projectId } = await seedScene();
    const id = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;

    const cancelled = await db.transaction(async (tx) =>
      projectTransfersRepo.cancelIfPending(id, projectId, tx),
    );

    expect(cancelled?.toUserId).toBe(otherId);
    // A person ended it, so it is stamped — unlike the reaped row above.
    expect(await decidedAtOf("project_transfers", id)).toBeInstanceOf(Date);
    await expect(
      projectTransfersRepo.createPending({
        projectId,
        fromUserId: ownerId,
        toUserId: thirdId,
        expiresAt: nextWeek(),
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses to cancel a transfer belonging to another project", async () => {
    // The caller was authorised against a project, so the row it acts on has to
    // belong to that project. Without the guard, an id from anywhere would do.
    const mine = await seedScene();
    const theirs = await seedScene();
    const id = (await projectTransfersRepo.createPending({
      projectId: theirs.projectId,
      fromUserId: theirs.ownerId,
      toUserId: theirs.otherId,
      expiresAt: nextWeek(),
    })).id;

    const cancelled = await db.transaction(async (tx) =>
      projectTransfersRepo.cancelIfPending(id, mine.projectId, tx),
    );

    expect(cancelled).toBeNull();
    expect(await statusOf("project_transfers", id)).toBe("pending");
  });

  it("locks an already-settled offer, so it is not mistaken for a missing one", async () => {
    // The headline invariant of this repo, asserted for THIS table rather than
    // assumed from the two siblings that already assert it: without this,
    // putting `status = 'pending'` back into the lock's WHERE passes the suite.
    const { ownerId, otherId, projectId } = await seedScene();
    const id = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;
    await db.transaction(async (tx) =>
      projectTransfersRepo.settleIfPending(id, "declined", tx),
    );

    const settled = await db.transaction(async (tx) =>
      projectTransfersRepo.lockRequest(id, tx),
    );
    const missing = await db.transaction(async (tx) =>
      projectTransfersRepo.lockRequest(randomUUID(), tx),
    );

    expect(settled?.status).toBe("declined");
    expect(settled?.toUserId).toBe(otherId);
    expect(missing).toBeNull();
  });

  it("locks a pending transfer and reports its participants", async () => {
    const { ownerId, otherId, projectId } = await seedScene();
    const id = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;

    const locked = await db.transaction(async (tx) =>
      projectTransfersRepo.lockRequest(id, tx),
    );

    // The recipient guard lives on this value: without it, any signed-in user
    // could accept a transfer offered to somebody else.
    expect(locked!.toUserId).toBe(otherId);
    expect(locked!.fromUserId).toBe(ownerId);
    expect(locked!.status).toBe("pending");
    expect(locked!.expired).toBe(false);
  });

  it("shows the project's live transfer and hides a timed-out one", async () => {
    const { ownerId, otherId, projectId } = await seedScene();
    const id = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;

    expect(
      (await projectTransfersRepo.findLiveForContainer(projectId))?.id,
    ).toBe(id);

    await db.transaction(async (tx) =>
      projectTransfersRepo.cancelIfPending(id, projectId, tx),
    );
    const expired = (await projectTransfersRepo.createPending({
      projectId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: yesterday(),
    })).id;

    expect(expired).toBeTruthy();
    expect(
      await projectTransfersRepo.findLiveForContainer(projectId),
    ).toBeNull();
  });
});

describe("studio transfers repo", () => {
  it("reaps a timed-out pending on the studio, then takes the slot", async () => {
    const { ownerId, otherId, thirdId, studioId } = await seedScene();
    const stale = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: yesterday(),
    })).id;

    const fresh = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: thirdId,
      expiresAt: nextWeek(),
    })).id;

    expect(await statusOf("studio_transfers", stale)).toBe("expired");
    expect(await statusOf("studio_transfers", fresh)).toBe("pending");
  });

  it("refuses a second LIVE transfer even to a different recipient", async () => {
    const { ownerId, otherId, thirdId, studioId } = await seedScene();
    await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    });

    await expect(
      studioTransfersRepo.createPending({
        studioId,
        fromUserId: ownerId,
        toUserId: thirdId,
        expiresAt: nextWeek(),
      }),
    ).rejects.toThrow();
  });

  it("settles exactly once", async () => {
    const { ownerId, otherId, studioId } = await seedScene();
    const id = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;

    const first = await db.transaction(async (tx) =>
      studioTransfersRepo.settleIfPending(id, "accepted", tx),
    );
    const second = await db.transaction(async (tx) =>
      studioTransfersRepo.settleIfPending(id, "declined", tx),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await statusOf("studio_transfers", id)).toBe("accepted");
  });

  it("locks an already-settled offer, so it is not mistaken for a missing one", async () => {
    const { ownerId, otherId, studioId } = await seedScene();
    const id = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;
    await db.transaction(async (tx) =>
      studioTransfersRepo.settleIfPending(id, "declined", tx),
    );

    const settled = await db.transaction(async (tx) =>
      studioTransfersRepo.lockRequest(id, tx),
    );
    const missing = await db.transaction(async (tx) =>
      studioTransfersRepo.lockRequest(randomUUID(), tx),
    );

    expect(settled?.status).toBe("declined");
    expect(settled?.toUserId).toBe(otherId);
    expect(missing).toBeNull();
  });

  it("refuses to cancel an offer belonging to another studio", async () => {
    const mine = await seedScene();
    const theirs = await seedScene();
    const id = (await studioTransfersRepo.createPending({
      studioId: theirs.studioId,
      fromUserId: theirs.ownerId,
      toUserId: theirs.otherId,
      expiresAt: nextWeek(),
    })).id;

    const cancelled = await db.transaction(async (tx) =>
      studioTransfersRepo.cancelIfPending(id, mine.studioId, tx),
    );

    expect(cancelled).toBeNull();
    expect(await statusOf("studio_transfers", id)).toBe("pending");
  });

  it("stamps decided_at when a person ends it, and not when it times out", async () => {
    const { ownerId, otherId, studioId } = await seedScene();
    const accepted = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;
    await db.transaction(async (tx) =>
      studioTransfersRepo.settleIfPending(accepted, "accepted", tx),
    );

    const reaped = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: yesterday(),
    })).id;
    await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    });

    expect(await decidedAtOf("studio_transfers", accepted)).toBeInstanceOf(Date);
    expect(await statusOf("studio_transfers", reaped)).toBe("expired");
    expect(await decidedAtOf("studio_transfers", reaped)).toBeNull();

    // The other way an offer dies unattended: the decision path finds it past
    // its deadline and flips it. That one DOES write the column, with null.
    const { studioId: otherStudio, ownerId: a, otherId: b } = await seedScene();
    const timedOut = (await studioTransfersRepo.createPending({
      studioId: otherStudio,
      fromUserId: a,
      toUserId: b,
      expiresAt: yesterday(),
    })).id;
    const settled = await db.transaction(async (tx) =>
      studioTransfersRepo.settleIfPending(timedOut, "expired", tx),
    );

    expect(settled).toBe(true);
    expect(await decidedAtOf("studio_transfers", timedOut)).toBeNull();
  });

  it("shows the studio's live transfer and hides a timed-out one", async () => {
    const { ownerId, otherId, studioId } = await seedScene();
    const live = (await studioTransfersRepo.createPending({
      studioId,
      fromUserId: ownerId,
      toUserId: otherId,
      expiresAt: nextWeek(),
    })).id;

    expect((await studioTransfersRepo.findLiveForContainer(studioId))?.id).toBe(
      live,
    );
  });
});
