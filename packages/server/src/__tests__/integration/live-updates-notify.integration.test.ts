// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test: committed writes to the tables behind the bell, the
 * project transfer and the credits figure reach the live-updates listener
 * (#1580, test spec area A).
 *
 * The notifications come from triggers, so they do not depend on which code
 * path wrote the row. Each case writes the table directly and waits for a
 * sentinel change before asserting that something did not arrive.
 *
 * @see packages/core/src/infra/member-change-listener.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, it, expect, beforeAll, afterAll, vi, inject } from "vitest";
import {
  initCore,
  loadLocales,
  createTestDb,
  listenLiveUpdates,
  listenProjectMemberChanges,
  LIVE_UPDATES_CHANNEL,
  type LiveUpdate,
  type LiveUpdatesListener,
  type MemberChange,
  type MemberChangeListener,
} from "@breatic/core";

initCore(process.env);
loadLocales();

import { chargeNow, seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";

let pgClient: ReturnType<typeof createTestDb>["client"];
let listener: LiveUpdatesListener;
let members: MemberChangeListener;
const updates: LiveUpdate[] = [];
const invalid: string[] = [];
const memberChanges: MemberChange[] = [];
let listening = 0;

let fx: StudioFixture;
let other: StudioFixture;
let sentinelUser: string;
let recipient: string;
let bystander: string;

/**
 * Insert a notification and return its id.
 * @param userId - Whose bell.
 * @param type - A type the table's CHECK accepts.
 * @returns The new row's id.
 */
async function insertNotification(userId: string, type = "membership.ended"): Promise<string> {
  const [row] = await pgClient<{ id: string }[]>`
    insert into notifications (user_id, type, payload) values (${userId}, ${type}, '{}'::jsonb) returning id
  `;
  return row!.id;
}

/**
 * Write a sentinel change and wait until it arrives. Notifications from one
 * session are delivered in commit order, so once the sentinel is in, anything
 * committed before it that was going to arrive has arrived.
 * @returns Once the sentinel is in.
 */
async function drain(): Promise<void> {
  const before = updates.length;
  await insertNotification(sentinelUser);
  await vi.waitFor(() => {
    expect(updates.slice(before).some((u) => u.k === "notifications" && u.u === sentinelUser)).toBe(true);
  });
}

/**
 * Run a write and return what arrived for it, sentinel excluded.
 * @param write - The write to observe.
 * @returns The updates that arrived between the write and the sentinel.
 */
async function observe(write: () => Promise<unknown>): Promise<LiveUpdate[]> {
  const before = updates.length;
  await write();
  await drain();
  return updates.slice(before).filter((u) => !(u.k === "notifications" && u.u === sentinelUser));
}

/**
 * Open a pending project transfer on the fixture's project.
 * @param projectId - The project.
 * @param from - The current owner.
 * @param to - The member offered ownership.
 * @returns The transfer id.
 */
async function insertTransfer(projectId: string, from: string, to: string): Promise<string> {
  const [row] = await pgClient<{ id: string }[]>`
    insert into project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token)
    values (${projectId}, ${from}, ${to}, 'pending', now() + interval '1 day', ${randomUUID()})
    returning id
  `;
  return row!.id;
}

/**
 * Insert a user.
 * @param label - Part of the email.
 * @returns The user id.
 */
async function insertUser(label: string): Promise<string> {
  const [row] = await pgClient<{ id: string }[]>`
    insert into users (email, email_verified) values (${`${label}-${randomUUID()}@example.test`}, true) returning id
  `;
  return row!.id;
}

beforeAll(async () => {
  const t = createTestDb(inject("DATABASE_URL"));
  pgClient = t.client;
  fx = await seedStudioFixture(pgClient, "lu-a");
  other = await seedStudioFixture(pgClient, "lu-a-other");
  sentinelUser = await insertUser("lu-sentinel");
  recipient = await insertUser("lu-recipient");
  bystander = await insertUser("lu-bystander");
  await pgClient`insert into project_members (project_id, user_id, role) values (${fx.projectId}, ${recipient}, 'editor')`;

  listener = await listenLiveUpdates({
    onUpdate: (update) => {
      updates.push(update);
    },
    onListening: () => {
      listening += 1;
    },
    onInvalid: (raw) => {
      invalid.push(raw);
    },
  });
  members = await listenProjectMemberChanges({
    onChange: (change) => {
      memberChanges.push(change);
    },
    onListening: () => {},
    onInvalid: () => {},
  });
});

afterAll(async () => {
  await listener?.stop();
  await members?.stop();
  await pgClient.end();
});

describe("listening", () => {
  it("reports that it is listening once it starts, on the connection the member probe checks", async () => {
    expect(listening).toBe(1);
    expect(await members.probe(1000)).toBe(true);
  });

  it("A-32 listens again after the connection is dropped", async () => {
    const before = listening;
    await pgClient`
      select pg_terminate_backend(pid) from pg_stat_activity
      where pid <> pg_backend_pid() and query ilike 'listen %'
    `;
    await vi.waitFor(() => expect(listening).toBeGreaterThan(before), { timeout: 15_000 });
    const got = await observe(() => insertNotification(recipient));
    expect(got).toContainEqual({ k: "notifications", u: recipient });
    expect(await members.probe(1000)).toBe(true);
  });

  it("A-33 sends unreadable payloads to onInvalid and leaves the member channel alone", async () => {
    const before = invalid.length;
    const bad = ["not json", JSON.stringify({ k: "nope", u: recipient }), JSON.stringify({ k: "notifications", u: "x" })];
    for (const raw of bad) await pgClient`select pg_notify(${LIVE_UPDATES_CHANNEL}, ${raw})`;
    await drain();
    expect(invalid.slice(before)).toEqual(bad);
  });

  it("A-34 still delivers membership changes on the same connection", async () => {
    const before = memberChanges.length;
    await pgClient`update project_members set role = 'viewer' where project_id = ${fx.projectId} and user_id = ${recipient}`;
    await vi.waitFor(() => expect(memberChanges.length).toBeGreaterThan(before));
    expect(memberChanges.at(-1)).toEqual({ projectId: fx.projectId, userId: recipient });
  });
});

describe("notifications", () => {
  it("A-01 announces an inserted notification to its recipient only", async () => {
    const got = await observe(() => insertNotification(recipient));
    expect(got).toEqual([{ k: "notifications", u: recipient }]);
  });

  it("A-02 and A-03 announce read_at and deleted_at changes", async () => {
    const id = await insertNotification(recipient);
    await drain();
    expect(await observe(() => pgClient`update notifications set read_at = now() where id = ${id}`)).toEqual([
      { k: "notifications", u: recipient },
    ]);
    expect(await observe(() => pgClient`update notifications set deleted_at = now() where id = ${id}`)).toEqual([
      { k: "notifications", u: recipient },
    ]);
  });

  it("A-04 stays quiet when read_at is written with the same value", async () => {
    const id = await insertNotification(recipient);
    await pgClient`update notifications set read_at = now() where id = ${id}`;
    await drain();
    expect(await observe(() => pgClient`update notifications set read_at = read_at where id = ${id}`)).toEqual([]);
  });

  it("A-05 stays quiet when only other columns change", async () => {
    const id = await insertNotification(recipient);
    await drain();
    const writes = [
      () => pgClient`update notifications set payload = '{"a":1}'::jsonb where id = ${id}`,
      () => pgClient`update notifications set type = 'membership.upgrade_incomplete' where id = ${id}`,
      () => pgClient`update notifications set expires_at = now() + interval '1 hour' where id = ${id}`,
      () => pgClient`update notifications set project_id = ${fx.projectId} where id = ${id}`,
      () => pgClient`update notifications set updated_at = now() where id = ${id}`,
    ];
    for (const write of writes) expect(await observe(write)).toEqual([]);
  });

  it("A-08 stays quiet when the insert rolls back", async () => {
    const got = await observe(async () => {
      await pgClient
        .begin(async (tx) => {
          await tx`insert into notifications (user_id, type, payload) values (${recipient}, 'membership.ended', '{}'::jsonb)`;
          throw new Error("rollback");
        })
        .catch(() => {});
    });
    expect(got).toEqual([]);
  });

  it("A-09 delivers at commit, not before", async () => {
    const before = updates.length;
    await pgClient.begin(async (tx) => {
      await tx`insert into notifications (user_id, type, payload) values (${recipient}, 'membership.ended', '{}'::jsonb)`;
      expect(await members.probe(1000)).toBe(true);
      expect(updates.slice(before).some((u) => u.k === "notifications" && u.u === recipient)).toBe(false);
    });
    await vi.waitFor(() => {
      expect(updates.slice(before).some((u) => u.k === "notifications" && u.u === recipient)).toBe(true);
    });
  });
});

describe("project transfers", () => {
  it("A-10 announces a new pending transfer on its project", async () => {
    const got = await observe(() => insertTransfer(fx.projectId, fx.userId, recipient));
    expect(got).toEqual([{ k: "project-transfer", p: fx.projectId }]);
    await pgClient`update project_transfers set status = 'cancelled' where project_id = ${fx.projectId} and status = 'pending'`;
  });

  it.each(["accepted", "declined", "cancelled", "failed"])("A-11 announces a status change to %s", async (status) => {
    const id = await insertTransfer(fx.projectId, fx.userId, recipient);
    await drain();
    const got = await observe(() =>
      status === "failed"
        ? pgClient`update project_transfers set status = 'failed', failed_reason = 'expired' where id = ${id}`
        : pgClient`update project_transfers set status = ${status}, decided_at = now() where id = ${id}`,
    );
    expect(got).toEqual([{ k: "project-transfer", p: fx.projectId }]);
  });

  it("A-12 stays quiet when status does not change", async () => {
    const id = await insertTransfer(fx.projectId, fx.userId, recipient);
    const note = await insertNotification(recipient, "project.transfer_request");
    await drain();
    const writes = [
      () => pgClient`update project_transfers set decided_at = now() where id = ${id}`,
      () => pgClient`update project_transfers set notification_id = ${note} where id = ${id}`,
      () => pgClient`update project_transfers set expires_at = now() + interval '2 days' where id = ${id}`,
      () => pgClient`update project_transfers set updated_at = now() where id = ${id}`,
    ];
    for (const write of writes) expect(await observe(write)).toEqual([]);
    await pgClient`update project_transfers set status = 'cancelled' where id = ${id}`;
  });

  it("A-13 stays quiet when the status change rolls back", async () => {
    const id = await insertTransfer(fx.projectId, fx.userId, recipient);
    await drain();
    const got = await observe(async () => {
      await pgClient
        .begin(async (tx) => {
          await tx`update project_transfers set status = 'cancelled' where id = ${id}`;
          throw new Error("rollback");
        })
        .catch(() => {});
    });
    expect(got).toEqual([]);
    await pgClient`update project_transfers set status = 'cancelled' where id = ${id}`;
  });
});

describe("credits", () => {
  it("A-14 announces a lot designated to a studio and not an undesignated one", async () => {
    let lot = "";
    const got = await observe(async () => {
      lot = await seedDesignatedLot(pgClient, fx, 10);
    });
    expect(got).toContainEqual({ k: "credits", s: fx.studioId });
    await pgClient`update credit_lots set designated_studio_id = null where id = ${lot}`;
    await drain();
    const quiet = await observe(() => pgClient`update credit_lots set remaining_credits = remaining_credits - 1 where id = ${lot}`);
    expect(quiet).toEqual([]);
  });

  it("A-15 to A-17 announce remaining_credits, lifecycle and deleted_at changes", async () => {
    const lot = await seedDesignatedLot(pgClient, fx, 10);
    await drain();
    const writes = [
      () => pgClient`update credit_lots set remaining_credits = 5 where id = ${lot}`,
      () => pgClient`update credit_lots set remaining_credits = 0, lifecycle = 'depleted' where id = ${lot}`,
      () => pgClient`update credit_lots set deleted_at = now() where id = ${lot}`,
    ];
    for (const write of writes) expect(await observe(write)).toEqual([{ k: "credits", s: fx.studioId }]);
  });

  it("A-18 announces both studios when the designation moves", async () => {
    const lot = await seedDesignatedLot(pgClient, fx, 10);
    await pgClient`update credit_lots set designated_studio_id = null where id = ${lot}`;
    await drain();
    expect(await observe(() => pgClient`update credit_lots set designated_studio_id = ${fx.studioId} where id = ${lot}`)).toEqual([
      { k: "credits", s: fx.studioId },
    ]);
    const moved = await observe(() => pgClient`update credit_lots set designated_studio_id = ${other.studioId} where id = ${lot}`);
    expect(moved).toHaveLength(2);
    expect(moved).toEqual(expect.arrayContaining([{ k: "credits", s: fx.studioId }, { k: "credits", s: other.studioId }]));
    expect(await observe(() => pgClient`update credit_lots set designated_studio_id = null where id = ${lot}`)).toEqual([
      { k: "credits", s: other.studioId },
    ]);
  });

  it("A-20 stays quiet for lot columns the figure does not read", async () => {
    const lot = await seedDesignatedLot(pgClient, fx, 10);
    await drain();
    const writes = [
      () => pgClient`update credit_lots set refund_attempts = refund_attempts + 1 where id = ${lot}`,
      () => pgClient`update credit_lots set refund_requested_at = now() where id = ${lot}`,
      () => pgClient`update credit_lots set updated_at = now() where id = ${lot}`,
    ];
    for (const write of writes) expect(await observe(write)).toEqual([]);
  });

  it("A-21 to A-24 announce holds by status, amount, expiry and studio", async () => {
    const reference = `lu-hold-${randomUUID()}`;
    const inserted = await observe(
      () => pgClient`insert into credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at)
        values (${fx.studioId}, ${fx.userId}, ${reference}, 3, now() + interval '1 hour')`,
    );
    expect(inserted).toEqual([{ k: "credits", s: fx.studioId }]);
    const announced = [
      () => pgClient`update credit_holds set amount = 4 where reference_id = ${reference}`,
      () => pgClient`update credit_holds set expires_at = now() + interval '2 hours' where reference_id = ${reference}`,
      () => pgClient`update credit_holds set status = 'released', released_at = now() where reference_id = ${reference}`,
    ];
    for (const write of announced) expect(await observe(write)).toEqual([{ k: "credits", s: fx.studioId }]);
    expect(await observe(() => pgClient`update credit_holds set updated_at = now() where reference_id = ${reference}`)).toEqual([]);
  });

  it("A-25 and A-26 announce debt rows by amount", async () => {
    const created = await observe(
      () => pgClient`insert into studio_credit_debts (studio_id, amount) values (${other.studioId}, 0) on conflict do nothing`,
    );
    expect(created).toEqual([{ k: "credits", s: other.studioId }]);
    expect(await observe(() => pgClient`update studio_credit_debts set amount = 1.5 where studio_id = ${other.studioId}`)).toEqual([
      { k: "credits", s: other.studioId },
    ]);
    expect(await observe(() => pgClient`update studio_credit_debts set updated_at = now() where studio_id = ${other.studioId}`)).toEqual([]);
  });

  it("A-27 announces a charge that only adds to the debt", async () => {
    const empty = await seedStudioFixture(pgClient, "lu-a-debt");
    // A deployment that charges no credits records usage and owes nothing, so the debt is written with payments on.
    initCore({ ...process.env, PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_unused_live_updates", STRIPE_WEBHOOK_SECRET: "whsec_unused_live_updates" });
    try {
      const got = await observe(() =>
        chargeNow({ projectId: empty.projectId, actorUserId: empty.userId, amount: 1 }),
      );
      expect(got).toContainEqual({ k: "credits", s: empty.studioId });
    } finally {
      initCore(process.env);
    }
  });

  it("A-28 stays quiet when credit writes roll back", async () => {
    const lot = await seedDesignatedLot(pgClient, fx, 10);
    await drain();
    const got = await observe(async () => {
      await pgClient
        .begin(async (tx) => {
          await tx`update credit_lots set remaining_credits = 1 where id = ${lot}`;
          await tx`insert into credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at)
            values (${fx.studioId}, ${fx.userId}, ${`lu-rb-${randomUUID()}`}, 1, now() + interval '1 hour')`;
          await tx`update studio_credit_debts set amount = amount + 1 where studio_id = ${other.studioId}`;
          throw new Error("rollback");
        })
        .catch(() => {});
    });
    expect(got).toEqual([]);
  });
});

// #1580 A-29: the credits figure (getCreditPosition) reads spendable lots,
// the debt and held holds; every column those reads use announces its Studio
// when it changes, and the list here is read back from the reads themselves,
// so a read that starts using another column fails this until a trigger
// covers it. studios.deleted_at is left out: a Studio is never deleted.
describe("A-29 the credit columns the figure reads", () => {
  const COVERED: Record<string, string[]> = {
    creditLots: ["deletedAt", "designatedStudioId", "lifecycle", "remainingCredits"],
    creditHolds: ["amount", "expiresAt", "status", "studioId"],
    studioCreditDebts: ["amount", "studioId"],
  };

  /** The columns of `table` a function of `source` names, by property. */
  function columnsRead(source: string, fn: string, table: string): string[] {
    const at = source.search(new RegExp(`(?:function|const)\\s+${fn}\\b`));
    if (at < 0) throw new Error(`no ${fn} in its repository`);
    const body = source.slice(at, source.indexOf("\n}\n", at));
    return [...body.matchAll(new RegExp(`\\b${table}\\.([a-zA-Z]+)`, "g"))].map((m) => m[1]!);
  }

  it("lists exactly the columns the three reads use", async () => {
    const lots = await readFile(new URL("../../../../domain/src/credit/creditLot.repo.ts", import.meta.url), "utf8");
    const holds = await readFile(new URL("../../../../domain/src/credit/creditHold.repo.ts", import.meta.url), "utf8");
    const read = {
      creditLots: [...columnsRead(lots, "spendableByStudio", "creditLots"), ...columnsRead(lots, "sumSpendableForStudio", "creditLots")],
      creditHolds: columnsRead(holds, "sumHeldForStudio", "creditHolds"),
      studioCreditDebts: columnsRead(lots, "readDebt", "studioCreditDebts"),
    };
    for (const [table, columns] of Object.entries(read)) expect([...new Set(columns)].sort(), table).toEqual(COVERED[table]);
  });

  it("announces the Studio when any one of those columns changes", async () => {
    const lot = await seedDesignatedLot(pgClient, fx, 10);
    const reference = `lu-a29-${randomUUID()}`;
    await pgClient`insert into credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at) values (${fx.studioId}, ${fx.userId}, ${reference}, 3, now() + interval '1 hour')`;
    await pgClient`insert into studio_credit_debts (studio_id, amount) values (${fx.studioId}, 0) on conflict do nothing`;
    await drain();
    const one = async (write: () => Promise<unknown>, studios: string[]): Promise<void> => {
      const got = await observe(write);
      expect([...new Set(got.map((u) => JSON.stringify(u)))].sort()).toEqual(studios.map((s) => JSON.stringify({ k: "credits", s })).sort());
    };
    await one(() => pgClient`update credit_lots set remaining_credits = 7 where id = ${lot}`, [fx.studioId]);
    await one(() => pgClient`update credit_lots set lifecycle = 'depleted' where id = ${lot}`, [fx.studioId]);
    await one(() => pgClient`update credit_lots set designated_studio_id = ${other.studioId} where id = ${lot}`, [fx.studioId, other.studioId]);
    await one(() => pgClient`update credit_lots set deleted_at = now() where id = ${lot}`, [other.studioId]);
    await one(() => pgClient`update credit_holds set amount = 5 where reference_id = ${reference}`, [fx.studioId]);
    await one(() => pgClient`update credit_holds set expires_at = now() + interval '3 hours' where reference_id = ${reference}`, [fx.studioId]);
    await one(() => pgClient`update credit_holds set studio_id = ${other.studioId} where reference_id = ${reference}`, [fx.studioId, other.studioId]);
    await one(() => pgClient`update credit_holds set status = 'released', released_at = now() where reference_id = ${reference}`, [other.studioId]);
    await one(() => pgClient`update studio_credit_debts set amount = amount + 2 where studio_id = ${fx.studioId}`, [fx.studioId]);
  });
});

describe("the payloads and the triggers themselves", () => {
  it("A-30 announces nothing for upload grants", async () => {
    const got = await observe(() => pgClient`update upload_grants set consumed_at = consumed_at where false`);
    expect(got).toEqual([]);
    const [row] = await pgClient<{ count: number }[]>`
      select count(*)::int as count from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = 'upload_grants' and not t.tgisinternal and t.tgname ilike '%live%'
    `;
    expect(row!.count).toBe(0);
  });

  it("A-31 carries only the kind and one canonical id", async () => {
    const got = await observe(() => insertNotification(bystander));
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!).sort()).toEqual(["k", "u"]);
    expect((got[0] as { u: string }).u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("A-35 installs one function and a trigger on each of the five tables, found by name", async () => {
    const directory = new URL("../../../../core/src/db/migrations/", import.meta.url);
    const migrations: string[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".sql")) continue;
      const source = await readFile(new URL(name, directory), "utf8");
      if (source.includes(`pg_notify('${LIVE_UPDATES_CHANNEL}'`) || source.includes(`pg_notify(\n      '${LIVE_UPDATES_CHANNEL}'`)) migrations.push(name);
    }
    expect(migrations, "one migration installs the live-updates triggers").toHaveLength(1);
    const rows = await pgClient<{ table: string; timing: string }[]>`
      select c.relname as table, pg_get_triggerdef(t.oid) as timing
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.prosrc ilike ${`%${LIVE_UPDATES_CHANNEL}%`}
    `;
    expect(rows.map((r) => r.table).sort()).toEqual(
      ["credit_holds", "credit_lots", "notifications", "project_transfers", "studio_credit_debts"],
    );
    for (const row of rows) expect(row.timing).toMatch(/AFTER INSERT OR UPDATE/);
  });
});

// #1580 PT-1: whatever columns a committed write changes, an update arrives
// exactly when a trigger column changed, and a rolled-back write sends nothing;
// a lot whose designation moves tells exactly the studios on either side.
describe("PT-1 trigger columns under random writes", () => {
  type Change = { column: string; same: boolean };
  const write = fc.record({
    table: fc.constantFrom("notifications", "project_transfers", "credit_holds", "credit_lots", "studio_credit_debts"),
    changes: fc.uniqueArray(fc.record({ column: fc.integer({ min: 0, max: 3 }).map(String), same: fc.boolean() }), {
      selector: (c) => c.column,
      maxLength: 4,
    }),
    commit: fc.boolean(),
    from: fc.constantFrom<"none" | "S" | "T">("none", "S", "T"),
    to: fc.constantFrom<"none" | "S" | "T">("none", "S", "T"),
  });

  it("announces a committed change to a trigger column, and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(write, async ({ table, changes, commit, from, to }) => {
        const studioOf = (side: "none" | "S" | "T"): string | null => (side === "S" ? fx.studioId : side === "T" ? other.studioId : null);
        const picked = (i: number): Change | undefined => changes.find((c) => c.column === String(i));
        let expected: LiveUpdate[] = [];
        let run: (tx: typeof pgClient) => Promise<unknown>;
        if (table === "notifications") {
          const id = await insertNotification(recipient);
          await drain();
          const cols: [string, string, boolean][] = [
            ["read_at", picked(0)?.same ? "read_at" : "now()", true],
            ["deleted_at", picked(1)?.same ? "deleted_at" : "now()", true],
            ["payload", picked(2)?.same ? "payload" : `'{"x":1}'::jsonb`, false],
            ["updated_at", "now()", false],
          ];
          const used = cols.filter((_c, i) => picked(i) !== undefined);
          if (used.some(([, v, trig]) => trig && v === "now()")) expected = [{ k: "notifications", u: recipient }];
          run = (tx) => (used.length === 0 ? Promise.resolve() : tx.unsafe(`update notifications set ${used.map(([c, v]) => `${c} = ${v}`).join(", ")} where id = '${id}'`));
        } else if (table === "project_transfers") {
          // A project holds one pending offer, so the last run's offer is closed before this one opens.
          await pgClient`update project_transfers set status = 'cancelled' where project_id = ${fx.projectId} and status = 'pending'`;
          const id = await insertTransfer(fx.projectId, fx.userId, recipient);
          await drain();
          const cols: [string, string][] = [
            ["status", picked(0)?.same ? "status" : "'declined'"],
            ["expires_at", picked(1)?.same ? "expires_at" : "now() + interval '2 days'"],
            ["deleted_at", picked(2)?.same ? "deleted_at" : "now()"],
            ["updated_at", "now()"],
          ];
          const used = cols.filter((_c, i) => picked(i) !== undefined);
          if (used.some(([c, v]) => c === "status" && v !== "status")) expected = [{ k: "project-transfer", p: fx.projectId }];
          run = (tx) => (used.length === 0 ? Promise.resolve() : tx.unsafe(`update project_transfers set ${used.map(([c, v]) => `${c} = ${v}`).join(", ")} where id = '${id}'`));
        } else if (table === "credit_holds") {
          const reference = `pt1-${randomUUID()}`;
          await pgClient`insert into credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at) values (${fx.studioId}, ${fx.userId}, ${reference}, 3, now() + interval '1 hour')`;
          await drain();
          const cols: [string, string, boolean][] = [
            ["amount", picked(0)?.same ? "amount" : "4", true],
            ["expires_at", picked(1)?.same ? "expires_at" : "now() + interval '3 hours'", true],
            ["status", picked(2)?.same ? "status" : "'released', released_at = now()", true],
            ["updated_at", "now()", false],
          ];
          const used = cols.filter((_c, i) => picked(i) !== undefined);
          if (used.some(([c, v, trig]) => trig && v !== c)) expected = [{ k: "credits", s: fx.studioId }];
          run = (tx) => (used.length === 0 ? Promise.resolve() : tx.unsafe(`update credit_holds set ${used.map(([c, v]) => `${c} = ${v}`).join(", ")} where reference_id = '${reference}'`));
        } else if (table === "credit_lots") {
          const lot = await seedDesignatedLot(pgClient, fx, 10);
          await pgClient`update credit_lots set designated_studio_id = ${studioOf(from)} where id = ${lot}`;
          await drain();
          const spend = picked(0) !== undefined && !picked(0)!.same;
          const sides = new Set([studioOf(from), studioOf(to)].filter((v): v is string => v !== null));
          if (from !== to) expected = [...sides].map((s) => ({ k: "credits", s }));
          else if (spend && studioOf(from) !== null) expected = [{ k: "credits", s: studioOf(from)! }];
          run = (tx) => tx`update credit_lots set designated_studio_id = ${studioOf(to)}, remaining_credits = remaining_credits - ${spend ? 1 : 0} where id = ${lot}`;
        } else {
          await pgClient`insert into studio_credit_debts (studio_id, amount) values (${other.studioId}, 0) on conflict do nothing`;
          await drain();
          const grow = picked(0) !== undefined && !picked(0)!.same;
          if (grow) expected = [{ k: "credits", s: other.studioId }];
          run = (tx) => tx`update studio_credit_debts set amount = amount + ${grow ? 0.5 : 0}, updated_at = now() where studio_id = ${other.studioId}`;
        }
        const got = await observe(() =>
          pgClient
            .begin(async (tx) => {
              await run(tx as unknown as typeof pgClient);
              if (!commit) throw new Error("rollback");
            })
            .catch(() => undefined),
        );
        const key = (u: LiveUpdate): string => JSON.stringify(u);
        expect([...new Set(got.map(key))].sort()).toEqual(commit ? expected.map(key).sort() : []);
      }),
      { numRuns: 100 },
    );
  });
});
