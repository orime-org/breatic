// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The account facts the billing service reads from the product (inner#1993
 * §3.3 `accounts` and `accounts/lookup`): mail address and language, whether
 * the account is deleted, its effective tier, the credits it still holds, and,
 * in bulk, the name of its personal Studio.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { accountFactsSchema, accountLookupAnswerSchema, closeDb, initCore } from "@breatic/core";
import { lookupAccounts, readAccount } from "@server/modules/commerce/commerce-accounts.service.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-accounts-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * One account with a personal Studio.
 * @param deleted - Whether the account is soft-deleted.
 * @returns Its id and Studio name.
 */
async function account(deleted = false): Promise<{ userId: string; studioName: string }> {
  const userId = randomUUID();
  const studioName = `Studio ${userId.slice(0, 6)}`;
  await sql`INSERT INTO users(id,email,locale,deleted_at) VALUES (${userId},${`${userId}@example.test`},'zh-CN',${deleted ? new Date() : null})`;
  await sql`INSERT INTO studios(id,created_by_user_id,slug,name,type) VALUES (${randomUUID()},${userId},${userId.slice(0, 30)},${studioName},'personal')`;
  return { userId, studioName };
}

/**
 * A lot the account holds.
 * @param userId - Whose lot.
 * @param lifecycle - Its lifecycle.
 * @param remaining - Credits left on it.
 */
async function lot(userId: string, lifecycle: string, remaining: number): Promise<void> {
  const sourceId = randomUUID();
  await sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},'payment')`;
  await sql`INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
    VALUES (${sourceId},'payment',${userId},1000,${remaining},${lifecycle})`;
}

describe("readAccount", () => {
  it("answers the mail address, language, tier and the credits still held", async () => {
    const { userId } = await account();
    await lot(userId, "active", 300);
    await lot(userId, "refund_pending", 200);
    await lot(userId, "refunded", 900);

    const answer = await readAccount(userId);

    expect(answer.httpStatus).toBe(200);
    expect(accountFactsSchema.safeParse(answer.body).success).toBe(true);
    expect(answer.body).toEqual({
      email: `${userId}@example.test`,
      locale: "zh-CN",
      deleted: false,
      effectiveTier: expect.any(String),
      heldCredits: "500.000000",
    });
  });

  it("answers a deleted account as deleted", async () => {
    const { userId } = await account(true);

    const answer = await readAccount(userId);

    expect(answer).toMatchObject({ httpStatus: 200, body: { deleted: true, effectiveTier: null } });
    expect(accountFactsSchema.safeParse(answer.body).success).toBe(true);
  });

  it("answers 404 for an account that never existed", async () => {
    expect(await readAccount(randomUUID())).toEqual({ httpStatus: 404, body: { code: "account_not_found" } });
  });
});

describe("lookupAccounts", () => {
  it("answers each known account with its personal Studio name and leaves unknown ids out", async () => {
    const live = await account();
    const gone = await account(true);

    const answer = await lookupAccounts([live.userId, gone.userId, randomUUID()]);

    expect(answer.httpStatus).toBe(200);
    expect(accountLookupAnswerSchema.safeParse(answer.body).success).toBe(true);
    const rows = answer.body as Array<{ userId: string }>;
    expect(rows.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
      [
        { userId: live.userId, email: `${live.userId}@example.test`, locale: "zh-CN", deleted: false, personalStudioName: live.studioName },
        { userId: gone.userId, email: `${gone.userId}@example.test`, locale: "zh-CN", deleted: true, personalStudioName: gone.studioName },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
  });
});
