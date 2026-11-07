// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, promoterApplications } from "@breatic/core";
import type { DbTx } from "@breatic/core";

export type PromoterApplicationStatus = "pending" | "approved" | "rejected";

export interface PromoterApplicationSummary {
  id: string;
  status: PromoterApplicationStatus;
  createdAt: Date;
  decidedAt: Date | null;
  applicantNote: string | null;
}

/**
 * Reads an account's most recent application.
 * @param userId - The account.
 * @param tx - The caller's transaction, if any.
 * @returns The latest application, or null when the account never applied.
 */
export async function findLatestApplication(userId: string, tx?: DbTx): Promise<PromoterApplicationSummary | null> {
  const rows = await (tx ?? db)
    .select({
      id: promoterApplications.id,
      status: promoterApplications.status,
      createdAt: promoterApplications.createdAt,
      decidedAt: promoterApplications.decidedAt,
      applicantNote: promoterApplications.applicantNote,
    })
    .from(promoterApplications)
    .where(and(eq(promoterApplications.userId, userId), isNull(promoterApplications.deletedAt)))
    .orderBy(desc(promoterApplications.createdAt), desc(promoterApplications.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Files a pending application unless one is already under review.
 *
 * The partial unique index on pending applications decides between two
 * submissions arriving together; the loser inserts nothing.
 * @param input - The applicant and what they filled in.
 * @param input.userId - The applicant.
 * @param input.country - ISO 3166-1 alpha-2 code.
 * @param input.channels - Where they will promote, 1–10 entries.
 * @param input.plan - How they will promote.
 * @param input.termsVersion - The promoter terms they agreed to.
 * @returns True when the application was filed.
 */
export async function insertPendingApplication(input: {
  userId: string;
  country: string;
  channels: string[];
  plan: string;
  termsVersion: string;
}): Promise<boolean> {
  const rows = await db
    .insert(promoterApplications)
    .values({ ...input, status: "pending", termsAcceptedAt: sql`now()` })
    .onConflictDoNothing()
    .returning({ id: promoterApplications.id });
  return rows.length > 0;
}
