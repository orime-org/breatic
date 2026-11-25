// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The account facts the billing service reads from the product (inner#1993
 * §3.3 `accounts`, `accounts/lookup`): who to mail and in which language,
 * whether the account is deleted, its effective tier, and the credits it holds.
 */

import { getMembershipReadingForUser } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import { lookupAccountFacts, readAccountFacts } from "@server/modules/auth/user.repo.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";

/**
 * One account's facts.
 * @param userId - The account.
 * @returns 200 with the facts (the tier is null for a deleted account), or 404 `account_not_found`.
 * @throws {Error} When the database fails.
 */
export async function readAccount(userId: string): Promise<StoredAnswer> {
  const facts = await readAccountFacts(userId);
  if (facts === null) return { httpStatus: 404, body: { code: "account_not_found" } };
  // A deleted account has no membership left to read; its tier is null.
  const [effectiveTier, heldCredits] = await Promise.all([
    facts.deleted ? Promise.resolve(null) : getMembershipReadingForUser(userId).then((reading) => reading.effectiveTier),
    creditLotRepo.sumHeldForUser(userId),
  ]);
  return {
    httpStatus: 200,
    body: { email: facts.email, locale: facts.locale, deleted: facts.deleted, effectiveTier, heldCredits },
  };
}

/**
 * Many accounts' facts with each one's personal Studio name.
 * @param userIds - The accounts, at most 100.
 * @returns 200 with one row per known account.
 * @throws {Error} When the database fails.
 */
export async function lookupAccounts(userIds: string[]): Promise<StoredAnswer> {
  return { httpStatus: 200, body: await lookupAccountFacts(userIds) };
}
