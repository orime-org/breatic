// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, promoterApplications, referralCodes, studioMembers, studios, users } from "@breatic/core";
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
 * @param tx - The caller's transaction, when it holds the applicant's account lock.
 * @returns True when the application was filed.
 */
export async function insertPendingApplication(input: {
  userId: string;
  country: string;
  channels: string[];
  plan: string;
  termsVersion: string;
}, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db)
    .insert(promoterApplications)
    .values({ ...input, status: "pending", termsAcceptedAt: sql`now()` })
    .onConflictDoNothing()
    .returning({ id: promoterApplications.id });
  return rows.length > 0;
}

/**
 * Who filed an application; the applicant never changes, so no lock is needed to read it.
 * @param id - The application.
 * @param tx - The decision's transaction.
 * @returns The applicant, or null when there is no such live application.
 */
export async function findApplicant(id: string, tx: DbTx): Promise<string | null> {
  const rows = await tx
    .select({ userId: promoterApplications.userId })
    .from(promoterApplications)
    .where(and(eq(promoterApplications.id, id), isNull(promoterApplications.deletedAt)))
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Locks an application for a review decision.
 * @param id - The application.
 * @param tx - The decision's transaction.
 * @returns The applicant and status, or null when there is no such live application.
 */
export async function lockApplication(
  id: string,
  tx: DbTx,
): Promise<{ id: string; userId: string; status: PromoterApplicationStatus } | null> {
  const rows = await tx
    .select({ id: promoterApplications.id, userId: promoterApplications.userId, status: promoterApplications.status })
    .from(promoterApplications)
    .where(and(eq(promoterApplications.id, id), isNull(promoterApplications.deletedAt)))
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Records a review decision on a locked pending application.
 * @param input - The decision.
 * @param input.id - The application.
 * @param input.status - approved or rejected.
 * @param input.adminId - Who decided.
 * @param input.reason - Why, for the back office.
 * @param input.applicantNote - What the applicant reads, when rejected.
 * @param tx - The decision's transaction.
 */
export async function decideApplication(
  input: { id: string; status: "approved" | "rejected"; adminId: string; reason: string; applicantNote: string | null },
  tx: DbTx,
): Promise<void> {
  await tx
    .update(promoterApplications)
    .set({
      status: input.status,
      decidedAt: sql`now()`,
      decidedBy: input.adminId,
      decisionReason: input.reason,
      applicantNote: input.applicantNote,
    })
    .where(eq(promoterApplications.id, input.id));
}

export interface ApplicationListRow {
  id: string;
  userId: string;
  email: string;
  status: PromoterApplicationStatus;
  country: string;
  createdAt: Date;
  decidedAt: Date | null;
  cursorAt: string;
}

/**
 * Lists applications newest first, one row over the page size.
 * @param input - Filter and position.
 * @param input.status - Only this status, when given.
 * @param input.limit - Rows to read, one more than the page size.
 * @param input.after - The last row of the previous page.
 * @returns Rows with the full-precision cursor time.
 */
export async function listApplications(input: {
  status: PromoterApplicationStatus | undefined;
  limit: number;
  after: { createdAt: string; id: string } | null;
}): Promise<ApplicationListRow[]> {
  return db
    .select({
      id: promoterApplications.id,
      userId: promoterApplications.userId,
      email: users.email,
      status: promoterApplications.status,
      country: promoterApplications.country,
      createdAt: promoterApplications.createdAt,
      decidedAt: promoterApplications.decidedAt,
      cursorAt: sql<string>`${promoterApplications.createdAt}::text`,
    })
    .from(promoterApplications)
    .innerJoin(users, eq(users.id, promoterApplications.userId))
    .where(
      and(
        isNull(promoterApplications.deletedAt),
        input.status ? eq(promoterApplications.status, input.status) : undefined,
        input.after
          ? sql`(${promoterApplications.createdAt}, ${promoterApplications.id}) < (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(promoterApplications.createdAt), desc(promoterApplications.id))
    .limit(input.limit);
}

export interface ApplicationDetail {
  id: string;
  userId: string;
  email: string;
  personalStudioName: string | null;
  status: PromoterApplicationStatus;
  country: string;
  channels: string[];
  plan: string;
  termsVersion: string;
  termsAcceptedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionReason: string | null;
  applicantNote: string | null;
  referralCode: string | null;
  createdAt: Date;
}

/**
 * Reads one application with what the reviewer needs beside it.
 * @param id - The application.
 * @returns The application, or null when there is no such live application.
 */
export async function findApplicationDetail(id: string): Promise<ApplicationDetail | null> {
  const rows = await db
    .select({
      id: promoterApplications.id,
      userId: promoterApplications.userId,
      email: users.email,
      personalStudioName: sql<string | null>`(
        select ${studios.name} from ${studios}
        join ${studioMembers} on ${studioMembers.studioId} = ${studios.id}
        where ${studioMembers.userId} = ${promoterApplications.userId} and ${studioMembers.role} = 'admin'
          and ${studios.type} = 'personal' and ${studios.deletedAt} is null
        limit 1)`,
      status: promoterApplications.status,
      country: promoterApplications.country,
      channels: promoterApplications.channels,
      plan: promoterApplications.plan,
      termsVersion: promoterApplications.termsVersion,
      termsAcceptedAt: promoterApplications.termsAcceptedAt,
      decidedAt: promoterApplications.decidedAt,
      decidedBy: promoterApplications.decidedBy,
      decisionReason: promoterApplications.decisionReason,
      applicantNote: promoterApplications.applicantNote,
      referralCode: referralCodes.code,
      createdAt: promoterApplications.createdAt,
    })
    .from(promoterApplications)
    .innerJoin(users, eq(users.id, promoterApplications.userId))
    .leftJoin(referralCodes, eq(referralCodes.applicationId, promoterApplications.id))
    .where(and(eq(promoterApplications.id, id), isNull(promoterApplications.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}
