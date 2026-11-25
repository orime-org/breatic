// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A team studio's monthly spend limits (inner#1968, design 3.10):
 * `studio_spend_limits` (the per-person default and the studio total) and
 * `studio_member_spend_limits` (one person's override). A null amount means
 * not set; on an override it means that person has no limit.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, projectMembers, projects, studioMemberSpendLimits, studioMembers, studioSpendLimits } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** A studio's two limits, as decimal strings; null when not set. */
export interface StudioSpendLimits {
  memberDefault: string | null;
  studioMonthly: string | null;
}

/** One person's override; `monthlyCredits` null means no limit. */
export interface MemberSpendLimit {
  userId: string;
  monthlyCredits: string | null;
}

/**
 * A studio's live limits.
 * @param studioId - The studio.
 * @param tx - Optional transaction.
 * @returns The two limits, both null when none were ever set.
 */
export async function getStudioLimits(studioId: string, tx?: DbTx): Promise<StudioSpendLimits> {
  const [row] = await (tx ?? db)
    .select({ memberDefault: studioSpendLimits.memberDefaultCredits, studioMonthly: studioSpendLimits.studioMonthlyCredits })
    .from(studioSpendLimits)
    .where(and(eq(studioSpendLimits.studioId, studioId), isNull(studioSpendLimits.deletedAt)));
  return row ?? { memberDefault: null, studioMonthly: null };
}

/**
 * Every live override of a studio.
 * @param studioId - The studio.
 * @param tx - Optional transaction.
 * @returns The overrides.
 */
export async function listOverrides(studioId: string, tx?: DbTx): Promise<MemberSpendLimit[]> {
  return (tx ?? db)
    .select({ userId: studioMemberSpendLimits.userId, monthlyCredits: studioMemberSpendLimits.monthlyCredits })
    .from(studioMemberSpendLimits)
    .where(and(eq(studioMemberSpendLimits.studioId, studioId), isNull(studioMemberSpendLimits.deletedAt)));
}

/**
 * One person's live override in a studio.
 * @param studioId - The studio.
 * @param userId - The person.
 * @param tx - Optional transaction.
 * @returns The override, or null when they follow the default.
 */
export async function findOverride(studioId: string, userId: string, tx?: DbTx): Promise<MemberSpendLimit | null> {
  const [row] = await (tx ?? db)
    .select({ userId: studioMemberSpendLimits.userId, monthlyCredits: studioMemberSpendLimits.monthlyCredits })
    .from(studioMemberSpendLimits)
    .where(and(eq(studioMemberSpendLimits.studioId, studioId), eq(studioMemberSpendLimits.userId, userId), isNull(studioMemberSpendLimits.deletedAt)));
  return row ?? null;
}

/**
 * Write a studio's two limits, bringing a soft-deleted row back.
 * @param studioId - The studio.
 * @param limits - The limits; null clears one.
 * @param updatedByUserId - The admin writing them.
 */
export async function upsertStudioLimits(studioId: string, limits: StudioSpendLimits, updatedByUserId: string): Promise<void> {
  const values = { memberDefaultCredits: limits.memberDefault, studioMonthlyCredits: limits.studioMonthly, updatedByUserId };
  await db
    .insert(studioSpendLimits)
    .values({ studioId, ...values })
    .onConflictDoUpdate({ target: studioSpendLimits.studioId, set: { ...values, deletedAt: null, updatedAt: sql`now()` } });
}

/**
 * Write one person's override over the live one, if any.
 * @param studioId - The studio.
 * @param userId - The person.
 * @param monthlyCredits - The limit; null for none.
 * @param updatedByUserId - The admin writing it.
 */
export async function upsertOverride(studioId: string, userId: string, monthlyCredits: string | null, updatedByUserId: string): Promise<void> {
  await db
    .insert(studioMemberSpendLimits)
    .values({ studioId, userId, monthlyCredits, updatedByUserId })
    .onConflictDoUpdate({
      target: [studioMemberSpendLimits.studioId, studioMemberSpendLimits.userId],
      targetWhere: isNull(studioMemberSpendLimits.deletedAt),
      set: { monthlyCredits, updatedByUserId, updatedAt: sql`now()` },
    });
}

/**
 * Soft-delete one person's override.
 * @param studioId - The studio.
 * @param userId - The person.
 * @param tx - Optional transaction, so leaving a studio drops it in its own commit.
 * @returns Whether a live override was removed.
 */
export async function softDeleteOverride(studioId: string, userId: string, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db)
    .update(studioMemberSpendLimits)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(studioMemberSpendLimits.studioId, studioId), eq(studioMemberSpendLimits.userId, userId), isNull(studioMemberSpendLimits.deletedAt)))
    .returning({ userId: studioMemberSpendLimits.userId });
  return rows.length > 0;
}

/** Someone who can spend a studio's credits, and how. */
export interface StudioPayer {
  userId: string;
  relation: "studio_member" | "project_collaborator";
}

/**
 * Everyone who can spend a studio's credits: its live members, and the live
 * members of its live projects who are not studio members.
 * @param studioId - The studio.
 * @returns Each person once, a studio member before a collaborator.
 */
export async function listPayers(studioId: string): Promise<StudioPayer[]> {
  const members = await db
    .select({ userId: studioMembers.userId })
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, studioId), isNull(studioMembers.deletedAt)));
  const collaborators = await db
    .selectDistinct({ userId: projectMembers.userId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projects.studioId, studioId), isNull(projects.deletedAt), isNull(projectMembers.deletedAt)));
  const seen = new Set(members.map((m) => m.userId));
  return [
    ...members.map((m) => ({ userId: m.userId, relation: "studio_member" as const })),
    ...collaborators.filter((c) => !seen.has(c.userId)).map((c) => ({ userId: c.userId, relation: "project_collaborator" as const })),
  ];
}
