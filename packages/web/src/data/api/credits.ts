// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type {
  CreditLedgerView,
  CreditLotView,
  CreditOverview,
  CreditPage,
  ProjectCreditsView,
  StudioCreditsView,
} from '@breatic/shared';

import { apiGet, apiPatch, apiPost } from '@web/data/api/request';

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
 *
 * Nothing is read from the reply. Pointing a purchase changes what several of
 * these reads answer, so the caller refetches them; the one lot the reply
 * carries would be a second, narrower answer to a question already asked.
 * @param lotId - The purchase being pointed.
 * @param studioId - The studio to point it at, or null to take it back.
 */
export async function designateCreditLot(
  lotId: string,
  studioId: string | null,
): Promise<void> {
  await apiPatch<unknown>(
    `/credits/lots/${encodeURIComponent(lotId)}/designation`,
    { studioId },
  );
}

/**
 * Read what the studio owning a project has.
 *
 * Its own request, separate from the project's detail: this figure moves with
 * every generation while the project's name and role do not.
 * @param projectId - The project being viewed.
 * @returns What its studio has, holds and has left.
 */
export async function fetchProjectCredits(projectId: string): Promise<ProjectCreditsView> {
  return apiGet<ProjectCreditsView>(`/projects/${encodeURIComponent(projectId)}/credits`);
}

/** Who wants to hear that a project's credits may have moved. */
const creditsListeners = new Set<(projectId: string) => void>();

/**
 * Say that a project's credits may have moved: a request that holds or spends
 * them returned, admitted or refused (inner#1611).
 * @param projectId - The project.
 */
export function noteCreditsChanged(projectId: string): void {
  for (const listener of creditsListeners) listener(projectId);
}

/**
 * Hear when a project's credits may have moved.
 * @param listener - Called with the project's id.
 * @returns A function that stops listening.
 */
export function onCreditsChanged(listener: (projectId: string) => void): () => void {
  creditsListeners.add(listener);
  return () => {
    creditsListeners.delete(listener);
  };
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

/**
 * Ask for a refund on one purchase.
 *
 * Nothing is read from the reply. The ask changes what several of these reads
 * answer, so the caller refetches them; the one lot the reply carries would be
 * a second, narrower answer to a question already asked.
 * @param lotId - The purchase to ask about.
 */
export async function requestCreditLotRefund(lotId: string): Promise<void> {
  await apiPost<unknown>(`/credits/lots/${encodeURIComponent(lotId)}/refund`);
}
