// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the account-level credits overlay needs, and what the endpoints did
 * not yet answer (task #12).
 *
 * All seven sections read the four endpoints #11 built. Two rounds of design
 * adversary walked the grid cell by cell and found seven the endpoints could
 * not supply; each is pinned here as an assertion that started red.
 *
 * The payments-off case lives in its own suite: it needs a different
 * PAYMENT_ENABLED.
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

import crypto from "node:crypto";
import type { Hono } from "hono";
import postgres from "postgres";
import {
  initCore,
  loadLocales,
  getRedis,
  setSession,
  sessionCookieName,
} from "@breatic/core";
import { creditLotService, creditLotRepo } from "@breatic/domain";

const PG_DRIVER_LOCAL = "credit-overlay-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

interface Fixture {
  userId: string;
  studioId: string;
  studioName: string;
  studioSlug: string;
  projectId: string;
  cookie: string;
}

/**
 * A signed-in account, a team studio it administers, and a project in it.
 * @returns Their ids and a session cookie.
 */
async function seedFixture(): Promise<Fixture> {
  const n = seq++;
  const stamp = Date.now();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`overlay-${n}-${stamp}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const studioSlug = `overlay-s-${n}-${stamp}`;
  const studioName = `Overlay team ${n}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${studioSlug}, 'team', ${studioName}) RETURNING id
  `;
  const studioId = studio!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`overlay-p-${n}-${stamp}`}, ${`Overlay project ${n}`})
    RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`overlay-me-${n}-${stamp}`}, 'personal', ${`Overlay owner ${n}`})
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId,
    studioName,
    studioSlug,
    projectId: project!.id,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * One purchase that has landed.
 * @param userId - The account that bought it.
 * @param credits - How many credits it bought.
 * @param amountCents - What was paid, in cents. Defaults to 1000.
 * @param designateTo - The studio to point it at. Defaults to none.
 * @returns The purchase's id.
 */
async function seedLot(
  userId: string,
  credits: number,
  amountCents = 1000,
  designateTo: string | null = null,
): Promise<string> {
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, status, credits_granted)
    VALUES (${userId}, ${amountCents}, 'completed', ${credits}) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId,
    purchasedCredits: credits,
  });
  if (designateTo !== null) {
    await sql`UPDATE credit_lots SET designated_studio_id = ${designateTo} WHERE id = ${lot.id}`;
  }
  return lot.id;
}

/**
 * A session cookie.
 * @param userId - Who is signed in.
 * @returns The cookie.
 */
async function loginAs(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Read the overview once.
 * @param cookie - The session cookie.
 * @returns The endpoint's `data`.
 */
async function readOverview(cookie: string): Promise<Record<string, unknown>> {
  const res = await app.request("/api/v1/credits/overview", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
}

/**
 * Read one page of purchases.
 * @param cookie - The session cookie.
 * @param query - Extra query string, such as `&lifecycle=active`.
 * @returns The page the endpoint returned.
 */
async function readLots(
  cookie: string,
  query = "",
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const res = await app.request(`/api/v1/credits/lots?limit=50${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { items: Record<string, unknown>[]; nextCursor: string | null };
  };
  return body.data;
}

describe("the overview names every studio it reports (plan §4.1)", () => {
  it("carries a name and a slug for each", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine).toBeDefined();
    // The client holds only uuids. `GET /studios/` returns the ones it is
    // still an active member of, while this read is not bound by membership
    // at all — a studio it was removed from is still reported — so that list
    // cannot supply the names. They have to come from here.
    expect(mine!['studioName']).toBe(fx.studioName);
    expect(mine!['studioSlug']).toBe(fx.studioSlug);
  });
});

describe("money spent in a deleted studio stays on the account (plan §4.2)", () => {
  it("keeps the row, keeps the name, and reads the balance as nothing", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);
    // Spend some of it while the studio is still there.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 120,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fx.studioId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const gone = studios.find((s) => s['studioId'] === fx.studioId);

    // AWS and Google Cloud both keep historical cost for terminated
    // resources: that money really was spent. A transfer is the same —
    // `payer_user_id` does not move when the studio changes hands.
    expect(gone).toBeDefined();
    expect(gone!['studioName']).toBe(fx.studioName);
    expect(Number(gone!['spent'])).toBe(120);
    // Nothing can be spent there any more, so the balance half still
    // excludes a deleted studio.
    expect(Number(gone!['spendable'])).toBe(0);
  });
});

describe("whether a studio is gone is read, not inferred", () => {
  it("does not call a studio deleted because its purchases ran out", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    // Spend the purchase to exactly zero: `planCharge` takes
    // min(remaining, owed), so `applyCharge`'s CASE marks it depleted. That
    // is where every purchase ends up.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
      referenceId: `deplete-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine).toBeDefined();
    // It holds no active purchase and it is still there. The client draws a
    // badge from this field, dashes the balance, and renames it in the
    // filter.
    expect(mine!['deleted']).toBe(false);
    expect(mine!['studioName']).toBe(fx.studioName);
    expect(Number(mine!['spent'])).toBe(100);
  });

  it("leaves the first studio alive after a purchase is repointed", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx.userId, 300, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 50,
      referenceId: `before-move-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    // What acceptance item 10 asks for: repointing takes the purchase from
    // the first studio at once.
    await sql`UPDATE credit_lots SET designated_studio_id = NULL WHERE id = ${lotId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine!['deleted']).toBe(false);
    expect(Number(mine!['spent'])).toBe(50);
  });
});

describe("the ledger is read by payer", () => {
  it("shows a debt paid off as a repayment, not as a generation", async () => {
    const fx = await seedFixture();
    // Run up the debt first: with no purchase to draw on, all of it is owed.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
      referenceId: `owe-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    const lotId = await seedLot(fx.userId, 500, 1000, null);
    // Pointing a purchase there pays the debt off first and writes a
    // `debt_repayment` row.
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // Two lines: the 40 this designation paid off, and the run itself, which
    // drew on no purchase and is marked as having cost nothing. The
    // repayment is money that really left, so it belongs in his ledger; it
    // carries no model and no project, so it has to say what it is.
    const rows = body.data.items;
    const repayment = rows.find((r) => r['kind'] === "debt_repayment");
    expect(repayment).toBeDefined();
    expect(Number(repayment!['amount'])).toBe(-40);
    expect(repayment!['model']).toBeNull();
  });
});

describe("a deleted studio says so on its row", () => {
  it("reads deleted as true with the name still reachable", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 120,
      referenceId: `gone-flag-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fx.studioId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const gone = studios.find((s) => s['studioId'] === fx.studioId);

    // The client draws a badge from this field and dashes the balance. Only
    // the false side used to be pinned.
    expect(gone!['deleted']).toBe(true);
    expect(gone!['studioName']).toBe(fx.studioName);
  });

  it("carries the studio name on every ledger row", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
      referenceId: `studio-name-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // The column is shown. Making the client ask again by id would be thirty
    // requests for a thirty-row page.
    expect(body.data.items[0]!['studioName']).toBe(fx.studioName);
  });
});

describe("a studio's debt is the studio's, not the reader's", () => {
  it("withholds it from someone who no longer administers the studio", async () => {
    // A debt is the studio's own figure. It moves as the people inside go on
    // generating, and only an admin can act on it by pointing a purchase
    // there. Anyone else is not shown it.
    const fx = await seedFixture();
    await seedLot(fx.userId, 10, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
      referenceId: `debt-vis-${Date.now()}`,
    });

    const asAdmin = await creditLotService.getOverview(fx.userId);
    expect(asAdmin.studios.find((s) => s.studioId === fx.studioId)?.debt).toBe(20);

    // Demoted to maintainer: what he spent is still his own history and the
    // row stays. The debt is not his.
    await sql`
      UPDATE studio_members SET role = 'maintainer'
      WHERE studio_id = ${fx.studioId} AND user_id = ${fx.userId}
    `;

    const after = await creditLotService.getOverview(fx.userId);
    const row = after.studios.find((s) => s.studioId === fx.studioId);
    expect(row).toBeDefined();
    // The purchase holds 10, so a charge of 30 takes 10 and leaves 20 owed
    // by the studio.
    expect(row!.spent).toBe(10);
    expect(row!.debt).toBeNull();
  });
});

describe("the overview reports what is owed and how many purchases point there (plan §4.3)", () => {
  it("carries the debt and the count for each studio", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 300, 1000, fx.studioId);
    await seedLot(fx.userId, 200, 1000, fx.studioId);

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine).toBeDefined();
    expect(Number(mine!['debt'])).toBe(0);
    // A count and not a list: what the reader wants to know is whether
    // anything points there.
    expect(Number(mine!['lotCount'])).toBe(2);
  });

  it("counts a purchase pointed at a soft-deleted studio in no group", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 400, 1000, fx.studioId);
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fx.studioId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const gone = studios.find((s) => s['studioId'] === fx.studioId);

    // `sumUnassignedForUser` already counts it as unassigned — an orphaned
    // designation reads as unassigned. Counting it in a group as well would
    // show the same purchase twice.
    //
    // Green as it stands: #11's or(isNull(designated_studio_id),
    // isNotNull(studios.deleted_at)) already answers it. Kept as a guard —
    // §4.3 adds a count grouped by studio, and a count that does not test
    // liveness breaks this.
    expect(Number(data['unassignedCredits'])).toBe(400);
    expect(gone).toBeUndefined();
  });
});

describe("the overview says whether the deployment charges at all (plan §4.4)", () => {
  it("carries a flag that tells an empty account from a free deployment", async () => {
    const fx = await seedFixture();

    const data = await readOverview(fx.cookie);

    // Three zeros and no studios look exactly like a deployment that charges
    // nobody. `PAYMENT_ENABLED` is readable only on the server, so the server
    // has to say.
    expect(data['billing']).toBe(true);
  });
});

describe("purchases show what was paid and where they point (plan §4.5 §4.6)", () => {
  it("carries the amount paid and its currency", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 880, 1000);

    const page = await readLots(fx.cookie);
    const lot = page.items[0];

    expect(lot).toBeDefined();
    // What was paid lives on `payments`, not on `credit_lots`. Working it
    // back from the credit count through a price table fails too: that table
    // is replaced wholesale (#13), and an old purchase was bought at the
    // price of its own day.
    expect(Number(lot!['paidCents'])).toBe(1000);
    expect(lot!['currency']).toBe("usd");
  });

  it("names the studio a purchase points at", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);

    const page = await readLots(fx.cookie);
    const lot = page.items[0];

    expect(lot).toBeDefined();
    expect(lot!['designatedStudioId']).toBe(fx.studioId);
    expect(lot!['designatedStudioName']).toBe(fx.studioName);
  });
});

describe("a purchase pointed at a studio that is gone reads as unassigned", () => {
  it("says so in the purchases list, the same as the overview counts it", async () => {
    // studio 软删的那一刻它就不该再持有任何积分包（user 2026-08-24）。写侧
    // 的清空归 #26；读侧这里必须先说对，否则同一个包在总览里算「未指定」、
    // 在充值记录里写着「已指定给 X」，而 X 已经没了。
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fx.studioId}`;

    const page = await readLots(fx.cookie);
    const mine = page.items[0];

    expect(mine).toBeDefined();
    expect(mine!["designatedStudioId"]).toBeNull();
    expect(mine!["designatedStudioName"]).toBeNull();

    // 总览那一侧本来就是这么算的，两处从此说同一句话。
    const data = await readOverview(fx.cookie);
    expect(data["unassignedCredits"]).toBe(500);
  });
});

describe("three sections each want their own subset (plan §4.7)", () => {
  it("takes a lifecycle parameter", async () => {
    const fx = await seedFixture();
    const active = await seedLot(fx.userId, 500, 1000, fx.studioId);
    const depleted = await seedLot(fx.userId, 100, 1000, fx.studioId);
    await sql`
      UPDATE credit_lots SET lifecycle = 'depleted', remaining_credits = 0
      WHERE id = ${depleted}
    `;

    const page = await readLots(fx.cookie, "&lifecycle=active");
    const ids = page.items.map((l) => l['id']);

    // Assigning lists only the active ones, refunds sort them into three
    // buckets, and purchases wants them all. Filtering a keyset stream on the
    // client breaks the test for "scroll to load more": a filtered page can
    // come out empty while the cursor still says there is more.
    expect(ids).toContain(active);
    expect(ids).not.toContain(depleted);
  });
});

describe("one generation is one ledger row (plan §4.8)", () => {
  it("merges a run that spanned several purchases into one row totalling them", async () => {
    const fx = await seedFixture();
    // Three small purchases, and a run that spans all of them.
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 250,
      // Every real charge carries one: the canvas path passes the task id
      // (`dispatch.ts:807`) and the agent and text tools go through
      // `chargeOnceForGeneration`, which passes its idempotency key. It is
      // what ties the rows of one generation together.
      referenceId: `overlay-charge-${Date.now()}`,
      model: "kling-v2.1",
      provider: "kuaishou",
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };
    const rows = body.data.items;

    // A run writes one `spend` row per purchase it drew on, all in the same
    // instant. Returned row by row, a page boundary lands inside one run and
    // shows it twice, each time with a fragment of its total.
    // `listLedgerByStudio` already called this a bug and solved it by
    // grouping on `reference_id`.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!['amount'])).toBe(-250);
  });

  it("keeps the top-up row out of the spending list", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // A top-up carries the same `payer_user_id` and no actor, project or
    // model, so four of the six columns would be empty.
    expect(body.data.items).toHaveLength(0);
  });
});

describe("a debt is the studio's and names nobody", () => {
  it("keeps another member's overspend out of his own ledger", async () => {
    const fx = await seedFixture();
    const [guest] = await sql<{ id: string }[]>`
      INSERT INTO users (email)
      VALUES (${`overlay-guest-${Date.now()}@example.test`}) RETURNING id`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${fx.studioId}, ${guest!.id}, 'maintainer')`;
    await seedLot(fx.userId, 30, 1000, fx.studioId);

    // He runs something dearer than the balance: 30 comes off the purchase
    // and 70 is recorded as the studio's debt.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: guest!.id,
      amount: 100,
      referenceId: `cross-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    // He paid nothing. An account's ledger answers where his own money
    // went.
    const his = await creditLotRepo.listLedgerByPayer(guest!.id, 50, null);
    expect(his).toHaveLength(0);
  });

  it("shows the funder what he paid, with the debt off his account", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 30, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
      referenceId: `own-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // One line, for the 30 he paid. The run used 100; the other 70 is the
    // studio's debt — it names no payer and sits on the studio's own
    // account.
    expect(body.data.items).toHaveLength(1);
    expect(Number(body.data.items[0]!['amount'])).toBe(-30);
    expect(body.data.items[0]!['kind']).toBe("generation");
  });

  it("still lists a studio that only ever owed", async () => {
    const fx = await seedFixture();
    // No purchase at all: the whole charge is owed and no `spend` row is
    // written.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
      referenceId: `debt-only-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    // Acceptance item 8 reports the debt. With the row gone, the debt is
    // nowhere on the screen.
    expect(mine).toBeDefined();
    expect(Number(mine!['debt'])).toBe(40);
    expect(mine!['deleted']).toBe(false);
  });
});

describe("usage that drew on no purchase is listed and says so", () => {
  it("marks it unbilled instead of dropping it from the ledger", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);
    // No studio means no pool to draw on: the text tools' path carries no
    // project id at all.
    await creditLotService.chargeForGeneration({
      projectId: null,
      actorUserId: fx.userId,
      amount: 42,
      referenceId: `nopool-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // Its `lot_id` is null and nothing left any purchase — and it is still
    // usage this account produced. The ledger lists it and marks that it drew
    // on nothing; hiding it would take a piece out of "what did I run",
    // which is the question this section answers.
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      kind: "unbilled",
      amount: -42,
      model: "seedream-4.0",
    });
  });
});

describe("every studio row can say why it is there", () => {
  it("drops a studio from the list once its debt is paid", async () => {
    const fx = await seedFixture();
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
      referenceId: `owe-then-pay-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    const lotId = await seedLot(fx.userId, 500, 1000, null);
    // Pointing a purchase there pays the debt off first, to nothing.
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    // It is still listed, now because money sits there and money was spent
    // there — not because anything is owed.
    expect(mine).toBeDefined();
    expect(Number(mine!['debt'])).toBe(0);
    expect(Number(mine!['spendable'])).toBeGreaterThan(0);
  });

  it("leaves no row of four zeroes once the debt is paid and nothing is left", async () => {
    // `fx.userId` administers this studio; the other account is a
    // maintainer brought in.
    const fx = await seedFixture();
    const [guest] = await sql<{ id: string }[]>`
      INSERT INTO users (email)
      VALUES (${`runner-${Date.now()}@example.test`}) RETURNING id`;
    const [guestStudio] = await sql<{ id: string }[]>`
      INSERT INTO studios (name, slug, type, created_by_user_id)
      VALUES ('Runner', ${`runner-s-${Date.now()}`}, 'personal', ${guest!.id})
      RETURNING id`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${guestStudio!.id}, ${guest!.id}, 'admin')`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${fx.studioId}, ${guest!.id}, 'maintainer')`;
    const guestCookie = await loginAs(guest!.id);

    // He generates here and runs up 40 owed, holding no purchase.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: guest!.id,
      amount: 40,
      referenceId: `others-pay-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    // The studio's admin pays it off with a purchase of his own.
    const lotId = await seedLot(fx.userId, 500, 1000, null);
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const data = await readOverview(guestCookie);
    const studios = data['studios'] as Record<string, unknown>[];

    // He holds nothing here, spent nothing here, and owes nothing. The row
    // would be four zeroes.
    expect(studios.find((s) => s['studioId'] === fx.studioId)).toBeUndefined();
  });

  it("still counts a spent purchase among those pointed at the studio", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
      referenceId: `deplete-count-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    // The purchases section lists this one and says it points at this
    // studio. Saying here that nothing points at it makes two sections
    // contradict each other about the same fact.
    expect(Number(mine!['lotCount'])).toBe(1);
  });
});
