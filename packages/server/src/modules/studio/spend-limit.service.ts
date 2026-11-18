// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A team studio's monthly spend limits, as its admin reads and writes them
 * (inner#1968, design 3.10). The admin gate is the route's; a personal studio
 * has no such setting and answers 404.
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { NotFoundError } from "@breatic/core";
import { creditHoldService, spendLimitRepo } from "@breatic/domain";
import { ceilToCreditCent, parseCreditDecimal, quantizeQuotedCredits, serializeCreditMicro, t, type CreditDecimal } from "@breatic/shared";

/** One person's row in the settings. */
export interface SpendLimitMember {
  userId: string;
  /** A studio member, a collaborator invited only to a project, or someone gone who spent this month. */
  relation: "studio_member" | "project_collaborator" | "former";
  /** Their override; `monthlyCredits` null means no limit. Null when they follow the default. */
  override: { monthlyCredits: CreditDecimal | null } | null;
  /** The limit that applies to them; null for none. */
  effective: CreditDecimal | null;
  /** What they spent in the studio this month. */
  spent: CreditDecimal;
}

/** What the admin reads. */
export interface SpendLimitsView {
  memberDefault: CreditDecimal | null;
  studioMonthly: CreditDecimal | null;
  monthStart: string;
  nextResetAt: string;
  studioSpent: CreditDecimal;
  members: SpendLimitMember[];
}

/**
 * A stored amount in the wire's form.
 * @param value - The stored decimal, or null.
 * @returns It as a credit decimal, or null.
 */
function wire(value: string | null): CreditDecimal | null {
  return value === null ? null : serializeCreditMicro(parseCreditDecimal(value));
}

/**
 * An amount the admin sent, settled to the cent as every credit figure is.
 * @param credits - The amount, or null to clear it.
 * @returns The decimal to store, or null.
 */
function stored(credits: number | null): string | null {
  return credits === null ? null : serializeCreditMicro(quantizeQuotedCredits(ceilToCreditCent(credits)));
}

/**
 * The team studio a slug names.
 * @param slug - The studio's URL handle.
 * @returns Its id.
 * @throws {NotFoundError} When there is no such studio, or it is personal.
 */
async function teamStudioId(slug: string): Promise<string> {
  const studio = await studioRepo.getBySlug(slug);
  if (studio === null || studio.type === "personal") throw new NotFoundError(t("server.error.not_found"));
  return studio.id;
}

/**
 * Read both limits, the month, what was spent and everyone who can spend.
 * @param slug - The studio's URL handle.
 * @returns The settings.
 * @throws {NotFoundError} When there is no such team studio.
 */
export async function readSpendLimits(slug: string): Promise<SpendLimitsView> {
  const studioId = await teamStudioId(slug);
  const limits = await spendLimitRepo.getStudioLimits(studioId);
  const overrides = new Map((await spendLimitRepo.listOverrides(studioId)).map((o) => [o.userId, o.monthlyCredits]));
  const spent = await creditHoldService.monthSpent(studioId);
  const payers = await spendLimitRepo.listPayers(studioId);
  const known = new Set(payers.map((p) => p.userId));
  const people = [
    ...payers,
    ...[...spent.byActor.keys()].filter((userId) => !known.has(userId)).map((userId) => ({ userId, relation: "former" as const })),
  ];
  return {
    memberDefault: wire(limits.memberDefault),
    studioMonthly: wire(limits.studioMonthly),
    monthStart: spent.month.start.toISOString(),
    nextResetAt: spent.month.next.toISOString(),
    studioSpent: serializeCreditMicro(spent.total),
    members: people.map(({ userId, relation }) => {
      const own = overrides.get(userId);
      const override = own === undefined ? null : { monthlyCredits: own };
      return {
        userId,
        relation,
        override: override === null ? null : { monthlyCredits: wire(override.monthlyCredits) },
        effective: wire(creditHoldService.effectiveMemberLimit(limits, override)),
        spent: serializeCreditMicro(spent.byActor.get(userId) ?? 0n),
      };
    }),
  };
}

/**
 * Write the per-person default and the studio total.
 * @param slug - The studio's URL handle.
 * @param adminUserId - The admin writing them.
 * @param limits - The two limits; null clears one.
 * @param limits.memberDefault - The per-person default.
 * @param limits.studioMonthly - The studio total.
 * @throws {NotFoundError} When there is no such team studio.
 */
export async function writeStudioLimits(slug: string, adminUserId: string, limits: { memberDefault: number | null; studioMonthly: number | null }): Promise<void> {
  const studioId = await teamStudioId(slug);
  await spendLimitRepo.upsertStudioLimits(studioId, { memberDefault: stored(limits.memberDefault), studioMonthly: stored(limits.studioMonthly) }, adminUserId);
}

/**
 * Write one person's override.
 * @param slug - The studio's URL handle.
 * @param adminUserId - The admin writing it.
 * @param userId - The person: a studio member or a member of one of its projects.
 * @param monthlyCredits - Their limit; null for none.
 * @throws {NotFoundError} When there is no such team studio, or the person can spend none of its credits.
 */
export async function writeMemberLimit(slug: string, adminUserId: string, userId: string, monthlyCredits: number | null): Promise<void> {
  const studioId = await teamStudioId(slug);
  if (!(await spendLimitRepo.listPayers(studioId)).some((p) => p.userId === userId)) throw new NotFoundError(t("server.error.not_found"));
  await spendLimitRepo.upsertOverride(studioId, userId, stored(monthlyCredits), adminUserId);
}

/**
 * Remove one person's override, so the default applies again.
 * @param slug - The studio's URL handle.
 * @param userId - The person.
 * @throws {NotFoundError} When there is no such team studio.
 */
export async function removeMemberLimit(slug: string, userId: string): Promise<void> {
  const studioId = await teamStudioId(slug);
  await spendLimitRepo.softDeleteOverride(studioId, userId);
}
