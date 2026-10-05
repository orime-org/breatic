// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Studio transfer needs every live credit pack pointed at the studio to be
 * unassigned first, and none may be pointed at it while the offer waits.
 *
 * A spent pack still names the studio but the credits panel offers no way to
 * unassign it, so it does not hold the transfer up; accepting clears it.
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
import { creditLotService } from "@breatic/domain";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as studioCreditDesignation from "@server/modules/studio/studioCreditDesignation.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 3,
    prepare: false,
    connection: { application_name: "transfer-credit-precondition-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a verified user with a personal studio; returns the user id. */
async function insertUser(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`tcp-${Date.now()}-${seq++}@example.com`}, true) RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`tcp-personal-${Date.now()}-${seq++}`}, 'personal', 'Person')
  `;
  return user!.id;
}

/** A team studio with an admin and one maintainer. */
async function seedStudio(): Promise<{ studioId: string; slug: string; adminId: string; memberId: string }> {
  const adminId = await insertUser();
  const memberId = await insertUser();
  const slug = `tcp-studio-${Date.now()}-${seq++}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId}, ${slug}, 'team', 'Precondition Studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${adminId}, 'admin'), (${studio!.id}, ${memberId}, 'maintainer')
  `;
  return { studioId: studio!.id, slug, adminId, memberId };
}

/**
 * Open a purchased lot through the real grant path, optionally pointed at a
 * studio and optionally marked spent.
 * @param userId - Who bought it.
 * @param studioId - Where it points, or null.
 * @param lifecycle - The lot's lifecycle after the grant.
 * @returns The lot id.
 */
async function insertLot(
  userId: string,
  studioId: string | null,
  lifecycle: "active" | "depleted" = "active",
): Promise<string> {
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
  `;
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${source!.id}, ${userId}, 1000, 'completed', 500) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId,
    purchasedCredits: 500,
  });
  await sql`
    UPDATE credit_lots
    SET designated_studio_id = ${studioId}, lifecycle = ${lifecycle},
        remaining_credits = ${lifecycle === "depleted" ? 0 : 500}
    WHERE id = ${lot.id}
  `;
  return lot.id;
}

/** How many transfer offers this studio has, live or not. */
async function transferCount(studioId: string): Promise<number> {
  const [row] = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM studio_transfers WHERE studio_id = ${studioId}
  `;
  return row!.c;
}

describe("starting a Studio transfer", () => {
  it("is refused while a live credit pack is pointed at the studio, and files nothing", async () => {
    const s = await seedStudio();
    await insertLot(s.adminId, s.studioId);

    await expect(
      studioTransferService.requestTransfer(s.slug, s.adminId, s.memberId),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await transferCount(s.studioId)).toBe(0);
    const [bell] = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM notifications
      WHERE user_id = ${s.memberId} AND type = 'studio.transfer_request'
    `;
    expect(bell!.c).toBe(0);
  });

  it("goes through once the pack is unassigned", async () => {
    const s = await seedStudio();
    const lot = await insertLot(s.adminId, s.studioId);
    await creditLotService.designateLot({ lotId: lot, requestingUserId: s.adminId, studioId: null });

    await studioTransferService.requestTransfer(s.slug, s.adminId, s.memberId);
    expect(await transferCount(s.studioId)).toBe(1);
  });

  it("is not held up by a spent pack that still names the studio", async () => {
    const s = await seedStudio();
    await insertLot(s.adminId, s.studioId, "depleted");

    await studioTransferService.requestTransfer(s.slug, s.adminId, s.memberId);
    expect(await transferCount(s.studioId)).toBe(1);
  });
});

describe("pointing a pack at a studio", () => {
  it("is refused while a transfer of that studio waits, and allowed again once it is withdrawn", async () => {
    const s = await seedStudio();
    const lot = await insertLot(s.adminId, null);
    await studioTransferService.requestTransfer(s.slug, s.adminId, s.memberId);

    await expect(
      studioCreditDesignation.designateLot({ lotId: lot, requestingUserId: s.adminId, studioId: s.studioId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [offer] = await sql<{ id: string }[]>`
      SELECT id FROM studio_transfers WHERE studio_id = ${s.studioId}
    `;
    await studioTransferService.withdrawTransfer(offer!.id, s.slug);
    const lotAfter = await studioCreditDesignation.designateLot({
      lotId: lot,
      requestingUserId: s.adminId,
      studioId: s.studioId,
    });
    expect(lotAfter.designatedStudioId).toBe(s.studioId);
  });

  it("still lets a pack be unassigned while a transfer waits", async () => {
    const s = await seedStudio();
    const lot = await insertLot(s.adminId, null);
    await studioTransferService.requestTransfer(s.slug, s.adminId, s.memberId);
    await sql`UPDATE credit_lots SET designated_studio_id = ${s.studioId} WHERE id = ${lot}`;

    const lotAfter = await studioCreditDesignation.designateLot({
      lotId: lot,
      requestingUserId: s.adminId,
      studioId: null,
    });
    expect(lotAfter.designatedStudioId).toBeNull();
  });
});
