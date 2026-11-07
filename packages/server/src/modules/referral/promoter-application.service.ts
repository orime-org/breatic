// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { db, lockAccountRow } from "@breatic/core";
import { findLatestApplication, insertPendingApplication } from "@server/modules/referral/promoter-application.repo.js";

export interface ApplicationForm {
  country: string;
  channels: string[];
  plan: string;
  termsVersion: string;
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: "program_closed" | "application_pending" | "already_promoter" }
  | { ok: false; reason: "terms_changed"; termsVersion: string };

/**
 * Files an account's application to become a promoter.
 * @param userId - The applicant.
 * @param form - What they filled in, with the terms version they agreed to.
 * @param currentTerms - `promoter_terms_version` now; empty while the program is closed.
 * @returns Filed, or why not.
 * @throws {Error} if the database fails.
 */
export async function submitApplication(userId: string, form: ApplicationForm, currentTerms: string): Promise<SubmitOutcome> {
  if (currentTerms === "") return { ok: false, reason: "program_closed" };
  if (form.termsVersion !== currentTerms) return { ok: false, reason: "terms_changed", termsVersion: currentTerms };
  // Approval takes the same account lock, so this read and the insert see
  // either no decision yet or the finished one.
  return db.transaction(async (tx): Promise<SubmitOutcome> => {
    await lockAccountRow(userId, tx);
    if ((await findLatestApplication(userId, tx))?.status === "approved") return { ok: false, reason: "already_promoter" };
    const filed = await insertPendingApplication({
      userId,
      country: form.country,
      channels: form.channels,
      plan: form.plan,
      termsVersion: form.termsVersion,
    }, tx);
    return filed ? { ok: true } : { ok: false, reason: "application_pending" };
  });
}
