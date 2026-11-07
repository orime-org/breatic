// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { eq } from "drizzle-orm";
import { db, referralCodes } from "@breatic/core";
import type { DbTx } from "@breatic/core";

export type ReferralCodeStatus = "active" | "disabled" | "removed";

export interface StoredReferralCode {
  id: string;
  code: string;
  promoterId: string;
  status: ReferralCodeStatus;
}

/**
 * Finds a code by its stored form.
 * @param code - Upper-case code, already parsed.
 * @param tx - The caller's transaction, if any.
 * @returns The code, or null when no promoter holds it.
 */
export async function findCodeByCode(code: string, tx?: DbTx): Promise<StoredReferralCode | null> {
  const rows = await (tx ?? db)
    .select({ id: referralCodes.id, code: referralCodes.code, promoterId: referralCodes.promoterId, status: referralCodes.status })
    .from(referralCodes)
    .where(eq(referralCodes.code, code))
    .limit(1);
  return rows[0] ?? null;
}
