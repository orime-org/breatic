// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { getMembershipReadingForUser, hasPaidMembership, lockAccountRow } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { findBindingByUser, insertBinding } from "@server/modules/referral/referral-binding.repo.js";
import type { ReferralSource } from "@server/modules/referral/referral-binding.repo.js";
import { parseReferralCode } from "@server/modules/referral/referral-code.js";
import { findCodeByCode } from "@server/modules/referral/referral-code.repo.js";

export type BindRefusal = "invalid_code" | "already_bound" | "not_eligible" | "already_paid";
export type BindOutcome = { ok: true } | { ok: false; reason: BindRefusal };

/**
 * Attaches a referral code to an account; the only way a binding is written.
 *
 * The account row is locked before the account is judged: recording a first
 * membership payment takes the same lock (`applySubscriptionWrite`), so a
 * payment landing meanwhile is seen here and the code is refused.
 * @param input - The account, the code as typed or carried, and its source.
 * @param input.userId - The account.
 * @param input.code - Raw code text.
 * @param input.source - Where the code came from.
 * @param tx - The caller's transaction: account creation, or the backfill's own.
 * @returns Bound, or why not, judged in the order code, binding, enterprise, payment.
 * @throws {Error} if the account does not exist or a write fails.
 */
export async function bindReferral(
  input: { userId: string; code: string; source: ReferralSource },
  tx: DbTx,
): Promise<BindOutcome> {
  const parsed = parseReferralCode(input.code);
  const code = parsed === null ? null : await findCodeByCode(parsed, tx);
  if (code === null || code.status !== "active") return { ok: false, reason: "invalid_code" };

  await lockAccountRow(input.userId, tx);
  if ((await findBindingByUser(input.userId, tx)) !== null) return { ok: false, reason: "already_bound" };
  if ((await getMembershipReadingForUser(input.userId, tx)).effectiveTier === "enterprise") {
    return { ok: false, reason: "not_eligible" };
  }
  if (await hasPaidMembership(input.userId, tx)) return { ok: false, reason: "already_paid" };

  await insertBinding({ userId: input.userId, referralCodeId: code.id, source: input.source }, tx);
  return { ok: true };
}
