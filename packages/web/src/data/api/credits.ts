// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet } from '@web/data/api/request';

/** One purchase, as the server reports it. */
export interface CreditLotView {
  id: string;
  purchasedCredits: number;
  remainingCredits: number;
  /** The studio allowed to spend it; `null` means unassigned, so unspendable. */
  designatedStudioId: string | null;
  lifecycle: string;
  /** How many refund requests were refused; the lifecycle keeps no trace. */
  refundAttempts: number;
  createdAt: string;
}

/** One movement of credits. */
export interface CreditLedgerView {
  id: string;
  entryType: string;
  /** Signed: positive in, negative out. */
  amount: number;
  /** Who spent them, which in a team is often not who paid. */
  actorUserId: string | null;
  studioId: string | null;
  projectId: string | null;
  lotId: string | null;
  model: string | null;
  provider: string | null;
  tokensUsed: number | null;
  description: string | null;
  createdAt: string;
}

/** One keyset page. */
export interface CreditPage<T> {
  items: T[];
  /** Pass back as the cursor for the next page; `null` at the end. */
  nextCursor: string | null;
}

/** What one studio's credits tab shows. */
export interface StudioCredits {
  /** What this studio can spend right now. */
  spendable: number;
  /** The purchases making it up, oldest first — the order they are spent in. */
  lots: CreditLotView[];
  /**
   * Movements of the reader's own credits in this studio. Taken by payer, so a
   * member sees what their money paid for here.
   */
  ledger: CreditPage<CreditLedgerView>;
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
): Promise<StudioCredits> {
  return apiGet<StudioCredits>(`/studio/${encodeURIComponent(slug)}/credits`, {
    params: cursor ? { cursor } : undefined,
  });
}
