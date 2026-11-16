// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who pays for a Studio, read from the global directory (inner#1955) — real PG.
 *
 * The admin in `studio_directory` is the one fact the credit ledger uses to
 * decide who may point a purchase at a Studio and whose purchases a Studio
 * spends. `changeDirectoryAdmin` is the only writer of that admin: it checks
 * the expected previous admin, releases that admin's designations to the
 * Studio in the same transaction, and returns its first answer again for a
 * repeated change id. While a transfer offer is open the directory carries
 * `transfer_pending_until`, and no purchase may be newly pointed at the Studio
 * until that moment has passed or the offer has ended.
 *
 * The pins:
 *
 *   1. A purchase can be pointed at a Studio that exists only in the
 *      directory, by the admin the directory names, and by nobody else.
 *   2. `transfer_pending_until` in the future refuses a new designation; in
 *      the past, or empty, it does not.
 *   3. `changeDirectoryAdmin` changes the admin only from the expected one,
 *      releases the old admin's designations, and replays by change id.
 *   4. Property: over any sequence of changes with repeated ids, the admin
 *      and the designations match a model that remembers the last applied
 *      change id and judges every other id against the current admin.
 *   5. Opening a transfer offer sets `transfer_pending_until` to its expiry;
 *      declining, withdrawing and accepting it clear it; accepting moves the
 *      directory admin.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
import fc from "fast-check";
import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import { creditLotService, studioDirectoryService } from "@breatic/domain";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import { openPaymentSource } from "./payment-source.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    // Only the start-up check reads these; no Stripe call is made here.
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    REGION: "us-west",
    GLOBAL_REGION: "us-west",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "studio-directory-admin-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account.
 * @returns Its id.
 */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`dir-admin-${Date.now()}-${seq++}@example.test`}, true)
    RETURNING id
  `;
  return row!.id;
}

/**
 * A directory row for a team Studio in another region, with no local rows.
 * @param adminId - The admin the directory names.
 * @param pendingUntil - The open offer's expiry, or null.
 * @returns The Studio id.
 */
async function remoteStudio(adminId: string, pendingUntil: Date | null = null): Promise<string> {
  const studioId = crypto.randomUUID();
  await sql`
    INSERT INTO studio_directory
      (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state, transfer_pending_until)
    VALUES (${studioId}, ${`dir-${crypto.randomBytes(5).toString("hex")}`}, 'sg', 'team', 'Remote',
            ${adminId}, ${adminId}, 'live', ${pendingUntil})
  `;
  return studioId;
}

/**
 * An undesignated purchase owned by a user.
 * @param ownerId - The buyer.
 * @param credits - What it grants.
 * @returns The lot id.
 */
async function purchase(ownerId: string, credits = 10): Promise<string> {
  const sourceId = await openPaymentSource(sql);
  await sql`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${sourceId}, ${ownerId}, 1000, 'completed', ${credits})
  `;
  const lot = await creditLotService.grantFromPayment({ paymentId: sourceId, userId: ownerId, purchasedCredits: credits });
  return lot.id;
}

/**
 * Where a lot points now.
 * @param lotId - The lot.
 * @returns The designated Studio id, or null.
 */
async function designation(lotId: string): Promise<string | null> {
  const [row] = await sql<{ studio: string | null }[]>`SELECT designated_studio_id AS studio FROM credit_lots WHERE id = ${lotId}`;
  return row!.studio;
}

/**
 * The directory admin of a Studio.
 * @param studioId - The Studio.
 * @returns The admin's user id.
 */
async function directoryAdmin(studioId: string): Promise<string> {
  const [row] = await sql<{ admin: string }[]>`SELECT admin_user_id AS admin FROM studio_directory WHERE studio_id = ${studioId}`;
  return row!.admin;
}

describe("designating a purchase by the directory admin", () => {
  it("lets the directory admin point a purchase at a Studio that has no local rows", async () => {
    const admin = await user();
    const studioId = await remoteStudio(admin);
    const lotId = await purchase(admin);

    await creditLotService.designateLot({ lotId, requestingUserId: admin, studioId });

    expect(await designation(lotId)).toBe(studioId);
  });

  it("refuses a buyer the directory does not name as admin", async () => {
    const admin = await user();
    const other = await user();
    const studioId = await remoteStudio(admin);
    const lotId = await purchase(other);

    await expect(creditLotService.designateLot({ lotId, requestingUserId: other, studioId })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await designation(lotId)).toBeNull();
  });

  it("refuses while a transfer offer is open and allows it once the offer's expiry has passed", async () => {
    const admin = await user();
    const open = await remoteStudio(admin, new Date(Date.now() + 3_600_000));
    const lapsed = await remoteStudio(admin, new Date(Date.now() - 1_000));
    const first = await purchase(admin);
    const second = await purchase(admin);

    await expect(creditLotService.designateLot({ lotId: first, requestingUserId: admin, studioId: open })).rejects.toMatchObject({
      statusCode: 409,
    });
    await creditLotService.designateLot({ lotId: second, requestingUserId: admin, studioId: lapsed });

    expect(await designation(first)).toBeNull();
    expect(await designation(second)).toBe(lapsed);
  });
});

describe("changeDirectoryAdmin", () => {
  it("moves the admin from the expected one and releases that admin's designations", async () => {
    const from = await user();
    const to = await user();
    const studioId = await remoteStudio(from);
    const lotId = await purchase(from);
    await creditLotService.designateLot({ lotId, requestingUserId: from, studioId });

    const result = await studioDirectoryService.changeDirectoryAdmin({
      studioId,
      fromUserId: from,
      toUserId: to,
      changeId: crypto.randomUUID(),
    });

    expect(result).toEqual({ changed: true });
    expect(await directoryAdmin(studioId)).toBe(to);
    expect(await designation(lotId)).toBeNull();
  });

  it("refuses when the admin is no longer the expected one, and changes nothing", async () => {
    const admin = await user();
    const stale = await user();
    const to = await user();
    const studioId = await remoteStudio(admin);

    const result = await studioDirectoryService.changeDirectoryAdmin({
      studioId,
      fromUserId: stale,
      toUserId: to,
      changeId: crypto.randomUUID(),
    });

    expect(result).toEqual({ changed: false, reason: "admin_mismatch" });
    expect(await directoryAdmin(studioId)).toBe(admin);
  });

  it("answers a repeated change id with its first answer", async () => {
    const from = await user();
    const to = await user();
    const studioId = await remoteStudio(from);
    const change = { studioId, fromUserId: from, toUserId: to, changeId: crypto.randomUUID() };

    const first = await studioDirectoryService.changeDirectoryAdmin(change);
    const again = await studioDirectoryService.changeDirectoryAdmin(change);

    expect(again).toEqual(first);
    expect(await directoryAdmin(studioId)).toBe(to);
  });

  it("keeps the admin and designations equal to a model of last-applied replay", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 0, max: 3 }),
            from: fc.integer({ min: 0, max: 2 }),
            to: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (steps) => {
          const people = [await user(), await user(), await user()];
          const studioId = await remoteStudio(people[0]!);
          const lots = await Promise.all(people.map((person) => purchase(person)));
          await creditLotService.designateLot({ lotId: lots[0]!, requestingUserId: people[0]!, studioId });
          const changeIds = Array.from({ length: 4 }, () => crypto.randomUUID());

          // The directory row remembers only the last change that applied:
          // replaying it answers "changed" again, and any other id is judged
          // afresh against the current admin.
          let modelAdmin = 0;
          let lastApplied: number | null = null;
          const designated = new Set<number>([0]);
          for (const step of steps) {
            const result = await studioDirectoryService.changeDirectoryAdmin({
              studioId,
              fromUserId: people[step.from]!,
              toUserId: people[step.to]!,
              changeId: changeIds[step.id]!,
            });
            let changed: boolean;
            if (step.id === lastApplied) {
              changed = true;
            } else if (step.from === modelAdmin) {
              changed = true;
              designated.delete(step.from);
              modelAdmin = step.to;
              lastApplied = step.id;
            } else {
              changed = false;
            }
            expect(result.changed).toBe(changed);
          }

          expect(await directoryAdmin(studioId)).toBe(people[modelAdmin]);
          for (const [index, lotId] of lots.entries()) {
            expect(await designation(lotId)).toBe(designated.has(index) ? studioId : null);
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});

describe("transfer offers and transfer_pending_until in the global region", () => {
  /**
   * A team Studio here with its directory row, an admin and a maintainer.
   * @returns Its id, slug and the two members.
   */
  async function localStudio(): Promise<{ studioId: string; slug: string; adminId: string; memberId: string }> {
    const adminId = await user();
    const memberId = await user();
    const slug = `dir-t-${crypto.randomBytes(5).toString("hex")}`;
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminId}, ${slug}, 'team', 'Local') RETURNING id
    `;
    const studioId = studio!.id;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${adminId}, 'admin')`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${memberId}, 'maintainer')`;
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${studioId}, ${slug}, NULL, 'team', 'Local', ${adminId}, ${adminId}, 'live')
    `;
    return { studioId, slug, adminId, memberId };
  }

  /**
   * The directory's open-offer expiry of a Studio.
   * @param studioId - The Studio.
   * @returns The expiry, or null.
   */
  async function pendingUntil(studioId: string): Promise<Date | null> {
    const [row] = await sql<{ until: Date | null }[]>`
      SELECT transfer_pending_until AS until FROM studio_directory WHERE studio_id = ${studioId}
    `;
    return row!.until;
  }

  /**
   * The open offer's id and expiry.
   * @param studioId - The Studio.
   * @returns Them.
   */
  async function openOffer(studioId: string): Promise<{ id: string; expiresAt: Date }> {
    const [row] = await sql<{ id: string; expires_at: Date }[]>`
      SELECT id, expires_at FROM studio_transfers WHERE studio_id = ${studioId} AND status = 'pending'
    `;
    return { id: row!.id, expiresAt: row!.expires_at };
  }

  it("is set to the offer's expiry when the offer opens", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();

    await studioTransferService.requestTransfer(slug, adminId, memberId);

    const offer = await openOffer(studioId);
    expect((await pendingUntil(studioId))?.getTime()).toBe(offer.expiresAt.getTime());
  });

  it("is cleared when the offer is declined", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const offer = await openOffer(studioId);

    await studioTransferService.declineTransfer(offer.id, memberId);

    expect(await pendingUntil(studioId)).toBeNull();
  });

  it("is cleared when the offer is withdrawn", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const offer = await openOffer(studioId);

    await studioTransferService.withdrawTransfer(offer.id, slug);

    expect(await pendingUntil(studioId)).toBeNull();
  });

  it("is cleared, and the directory admin moves, when the offer is accepted", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const offer = await openOffer(studioId);

    await studioTransferService.confirmTransfer(offer.id, memberId);

    expect(await pendingUntil(studioId)).toBeNull();
    expect(await directoryAdmin(studioId)).toBe(memberId);
  });
});
