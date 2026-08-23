// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type {
  CreditLedgerView,
  CreditLotView,
  CreditOverview,
  CreditPage,
  StudioCreditsView,
} from '@breatic/shared';

import { apiGet, apiPatch } from '@web/data/api/request';

/**
 * Read what this account holds and where it went.
 * @returns The totals, plus a line per studio it has money in or spent in.
 */
export async function fetchCreditOverview(): Promise<CreditOverview> {
  return apiGet<CreditOverview>('/credits/overview');
}

/**
 * Read this account's purchases, newest first.
 * @param options - Which purchases, and where to resume.
 * @param options.lifecycle - Narrow to one state; omit for every purchase.
 * @param options.cursor - The previous page's `nextCursor`.
 * @returns One page of purchases.
 */
export async function fetchCreditLots(options?: {
  lifecycle?: string;
  cursor?: string;
}): Promise<CreditPage<CreditLotView>> {
  const params: Record<string, string> = {};
  if (options?.lifecycle !== undefined) params['lifecycle'] = options.lifecycle;
  if (options?.cursor !== undefined) params['cursor'] = options.cursor;
  return apiGet<CreditPage<CreditLotView>>('/credits/lots', {
    params: Object.keys(params).length > 0 ? params : undefined,
  });
}

/**
 * Read this account's spending, one line per generation, newest first.
 * @param options - Which spending, and where to resume.
 * @param options.studioId - Narrow to one studio; omit for all of them.
 * @param options.cursor - The previous page's `nextCursor`.
 * @returns One page of the ledger.
 */
export async function fetchCreditLedger(options?: {
  studioId?: string;
  cursor?: string;
}): Promise<CreditPage<CreditLedgerView>> {
  const params: Record<string, string> = {};
  if (options?.studioId !== undefined) params['studioId'] = options.studioId;
  if (options?.cursor !== undefined) params['cursor'] = options.cursor;
  return apiGet<CreditPage<CreditLedgerView>>('/credits/ledger', {
    params: Object.keys(params).length > 0 ? params : undefined,
  });
}

/**
 * Point a purchase at a studio, or at none.
 *
 * `null` is an instruction rather than an omission — it takes the purchase
 * back from whichever studio held it, which is how credits are moved.
 * @param lotId - The purchase being pointed.
 * @param studioId - The studio to point it at, or null to take it back.
 * @returns The purchase as it now stands.
 */
export async function designateCreditLot(
  lotId: string,
  studioId: string | null,
): Promise<CreditLotView> {
  return apiPatch<CreditLotView>(
    `/credits/lots/${encodeURIComponent(lotId)}/designation`,
    { studioId },
  );
}

/**
 * Read what the studio owning a project can spend.
 *
 * Its own request, separate from the project's detail: this figure moves with
 * every generation while the project's name and role do not.
 * @param projectId - The project being viewed.
 * @returns What its studio has left, below zero when the studio owes.
 */
export async function fetchProjectCredits(
  projectId: string,
): Promise<{ spendable: number }> {
  return apiGet<{ spendable: number }>(
    `/projects/${encodeURIComponent(projectId)}/credits`,
  );
}

/**
 * Read one studio's credits.
 * @param slug - The studio being viewed.
 * @param cursor - The previous page's `nextCursor`, when paging the ledger.
 * @returns The studio's credits and one page of its ledger.
 */
export async function fetchStudioCredits(
  slug: string,
  cursor?: string,
): Promise<StudioCreditsView> {
  return apiGet<StudioCreditsView>(`/studio/${encodeURIComponent(slug)}/credits`, {
    params: cursor ? { cursor } : undefined,
  });
}
