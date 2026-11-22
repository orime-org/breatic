// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A team Studio's monthly spend limits, which only its admin reads and writes
 * (inner#1968, design 3.10). A personal Studio, or a deployment with payments
 * off, answers 404; anyone but its admin 403.
 */

import type { CreditDecimal } from '@breatic/shared';

import { apiDelete, apiGet, apiPut } from '@web/data/api/request';

/** One person who can spend the Studio's credits, as the admin sees them. */
export interface SpendLimitMember {
  userId: string;
  /** A Studio member, a collaborator invited only to a Project, or someone gone who spent this month. */
  relation: 'studio_member' | 'project_collaborator' | 'former';
  /** Their own limit; `monthlyCredits` null is no limit. Null when they follow the default. */
  override: { monthlyCredits: CreditDecimal | null } | null;
  /** The limit in force for them; null for none. */
  effective: CreditDecimal | null;
  /** What they spent here this month. */
  spent: CreditDecimal;
}

/** The Studio's spend limits, this UTC month and what was spent in it. */
export interface SpendLimitsView {
  memberDefault: CreditDecimal | null;
  studioMonthly: CreditDecimal | null;
  monthStart: string;
  nextResetAt: string;
  studioSpent: CreditDecimal;
  members: SpendLimitMember[];
}

/**
 * The query key the spend limits of one Studio are cached under.
 * @param slug - The Studio.
 * @returns The key.
 */
export function spendLimitsQueryKey(slug: string): readonly [string, string] {
  return ['studio-spend-limits', slug] as const;
}

/**
 * Read a Studio's spend limits.
 * @param slug - The Studio.
 * @returns The limits.
 * @throws {ApiException} 403 for anyone but its admin, 404 for a personal Studio or with payments off.
 */
export function fetchSpendLimits(slug: string): Promise<SpendLimitsView> {
  return apiGet<SpendLimitsView>(`/studio/${slug}/spend-limits`);
}

/**
 * Write the per-person default and the Studio's monthly total.
 * @param slug - The Studio.
 * @param limits - Each in credits, or null to set none.
 * @param limits.memberDefault - The per-person default.
 * @param limits.studioMonthly - The Studio's total.
 * @returns Once written.
 * @throws {ApiException} When the server refuses.
 */
export function saveSpendLimits(slug: string, limits: { memberDefault: number | null; studioMonthly: number | null }): Promise<unknown> {
  return apiPut(`/studio/${slug}/spend-limits`, limits);
}

/**
 * Give one person their own monthly limit.
 * @param slug - The Studio.
 * @param userId - The person.
 * @param monthlyCredits - Their limit in credits, or null for no limit.
 * @returns Once written.
 * @throws {ApiException} When the server refuses.
 */
export function saveMemberSpendLimit(slug: string, userId: string, monthlyCredits: number | null): Promise<unknown> {
  return apiPut(`/studio/${slug}/members/${userId}/spend-limit`, { monthlyCredits });
}

/**
 * Put one person back on the default.
 * @param slug - The Studio.
 * @param userId - The person.
 * @returns Once removed.
 * @throws {ApiException} When the server refuses.
 */
export function removeMemberSpendLimit(slug: string, userId: string): Promise<unknown> {
  return apiDelete(`/studio/${slug}/members/${userId}/spend-limit`);
}
