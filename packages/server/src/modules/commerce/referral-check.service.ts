// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Asks the billing service whether a sign-up's referral code is active
 * (inner#1993 §3.2, §8.4), on the quick timeout: a sign-up waits on it.
 */

import { SignedCallError, isUnavailable, logger, referralCodeCheckAnswerSchema } from "@breatic/core";
import { callCommerce } from "@server/modules/commerce/commerce-client.js";

/** What the billing service said about a code. */
export type ReferralCodeCheck = { status: "active"; code: string } | { status: "inactive" } | { status: "unknown" };

/**
 * Check one code.
 * @param code - The code as the user gave it.
 * @returns Active with its stored form, inactive, or unknown when the billing service could not be asked.
 * @throws {Error} When its answer does not read as the contract says.
 */
export async function checkReferralCode(code: string): Promise<ReferralCodeCheck> {
  try {
    const answer = referralCodeCheckAnswerSchema.parse(
      (await callCommerce({ method: "POST", path: "/referral-codes/check", body: { code }, quick: true })).body,
    );
    return answer.active ? { status: "active", code: answer.code } : { status: "inactive" };
  } catch (err) {
    if (err instanceof SignedCallError && !isUnavailable(err)) return { status: "inactive" };
    if (!isUnavailable(err)) throw err;
    logger.error({ err }, "referral_code_check_unavailable");
    return { status: "unknown" };
  }
}
