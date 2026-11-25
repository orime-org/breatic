// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Payment-disabled deployments record usage without drawing from credit lots.
 * The process-wide payment setting needs a separate suite from billed cases.
 * Unbilled ledger entries retain the payer and actor while their lot stays null.
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
import { db, initCore, env } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { creditViewService } from "@server/modules/index.js";
import { chargeNow } from "./studio-credit-fixtures.js";

const PG_DRIVER_LOCAL = "credit-engine-off-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // Switched off explicitly: other suites in the same worker switch it on for
  // their own needs, so the process environment cannot be relied on.
  initCore({ ...process.env, PAYMENT_ENABLED: "false" });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

/** One user with their studio and one project. */
async function seedFixture(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
}> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`off-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`off-s-${n}-${Date.now()}`}, 'team', 'Off') RETURNING id
  `;
  const studioId = studio!.id;
  // Both production paths that create a studio write this row, and the
  // account-side reads ask it who administers the studio.
  // `created_by_user_id` records who opened it and never changes, so it
  // cannot answer that.
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`off-p-${n}-${Date.now()}`}, 'Off') RETURNING id
  `;
  return { userId, studioId, projectId: project!.id };
}

describe("payments off", () => {
  it("has the switch really off", () => {
    expect(env.PAYMENT_ENABLED).toBe(false);
    // CHARGING_ENABLED is unset here, so it falls back to the old name.
    expect(env.CHARGING_ENABLED).toBe(false);
  });

  it("still writes the usage row, with no lot_id and the payer filled in", async () => {
    const fx = await seedFixture();

    const outcome = await chargeNow({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42.5,
      model: "seedance-1.5-pro",
      provider: "volcengine",
      referenceId: `off-task-${Date.now()}`,
    });

    // Nothing is deducted, and not because nothing could be: this deployment charges nobody.
    expect(outcome).toMatchObject({ billed: false, charged: "0.000000", shortfall: "0.000000" });

    const [row] = await sql<
      {
        lot_id: string | null;
        payer_user_id: string;
        studio_id: string | null;
        amount: string;
        model: string | null;
      }[]
    >`
      SELECT lot_id, payer_user_id, studio_id, amount, model
      FROM credit_ledger
      WHERE payer_user_id = ${fx.userId} AND entry_type = 'spend'
    `;
    expect(row?.lot_id).toBeNull();
    // The account ledger is always read by payer, so the row must name one or a
    // self-hosted deployment sees no usage at all.
    expect(row?.payer_user_id).toBe(fx.userId);
    expect(row?.studio_id).toBe(fx.studioId);
    expect(row?.amount).toBe("-42.500000");
    expect(row?.model).toBe("seedance-1.5-pro");
  });

  it("settles the charge request and writes one standalone usage row", async () => {
    const fx = await seedFixture();
    const referenceId = `off-request-${Date.now()}`;
    const requestId = await db.transaction((tx) =>
      creditLotService.requestCharge(
        { kind: "task", referenceId, actorUserId: fx.userId, projectId: fx.projectId, amount: 12, model: "seedream-4.0" },
        tx,
      ),
    );
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const outcome = await creditLotService.settleCharge(requestId!);

    expect(outcome).toEqual({ billed: false, charged: "0.000000", shortfall: "0.000000", studioId: fx.studioId, lotIds: [] });
    expect(
      await sql`SELECT status, attempts, (settled_at IS NOT NULL) AS stamped FROM credit_charge_requests WHERE id = ${requestId}`,
    ).toEqual([{ status: "settled", attempts: 0, stamped: true }]);
    expect(
      await sql`SELECT entry_type, amount::text AS amount, lot_id, payer_user_id FROM credit_ledger WHERE reference_id = ${referenceId}`,
    ).toEqual([{ entry_type: "spend", amount: "-12.000000", lot_id: null, payer_user_id: fx.userId }]);

    // Settled is final: a second settlement writes nothing more.
    expect(await creditLotService.settleCharge(requestId!)).toBeNull();
    expect(await sql`SELECT 1 FROM credit_ledger WHERE reference_id = ${referenceId}`).toHaveLength(1);
  });

  it("neither errors nor fails when there is no credit lot at all", async () => {
    // Every development environment is in this state: no credit_lots row exists.
    const fx = await seedFixture();
    await expect(
      chargeNow({
        projectId: fx.projectId,
        actorUserId: fx.userId,
        amount: 1,
      }),
    ).resolves.toMatchObject({ billed: false });
  });
});

describe("the account ledger on a deployment that charges nobody", () => {
  it("lists the usage, marked as having drawn on no purchase", async () => {
    // Every usage row on this deployment has no lot_id. The ledger still shows
    // spending, and its footnote already tells the user these are usage records.
    const fx = await seedFixture();
    await chargeNow({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42,
      model: "seedream-4.0",
      referenceId: `off-ledger-${Date.now()}`,
    });

    const page = await creditViewService.listLedger(fx.userId);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: "unbilled",
      amount: "-42.000000",
      model: "seedream-4.0",
      studioId: fx.studioId,
    });
  });
});

describe("consumption while payments are off", () => {
  it("counts usage that drew on no credit lot as this studio's consumption", async () => {
    const fx = await seedFixture();
    await chargeNow({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42,
      model: "seedream-4.0",
    });

    const overview = await creditLotService.getOverview(fx.userId);
    const mine = overview.studios.find((s) => s.studioId === fx.studioId);

    // Unbilled spend still counts as Studio consumption without a credit lot;
    // debt_incurred records the liability and is excluded from consumption.
    expect(mine).toBeDefined();
    expect(mine!.spent).toBe("42.000000");
  });
});
