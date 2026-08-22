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
  actorName: string | null;
  projectName: string | null;
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

/** One purchase a studio received, where the buyer is a column. */
export interface StudioPurchaseView extends CreditLotView {
  /** Who bought it. Absent when their personal studio is gone. */
  buyerName: string | null;
}

/** One line of a studio's ledger: everything one event moved. */
export interface StudioLedgerView {
  id: string;
  /** A generation, or a designation paying off what the studio owed. */
  kind: 'generation' | 'debt_repayment';
  /** Who ran it, which in a team is often not who paid. */
  actorUserId: string | null;
  actorName: string | null;
  projectId: string | null;
  projectName: string | null;
  model: string | null;
  provider: string | null;
  /** What left the pool. This is the figure the amount column shows. */
  charged: number;
  /** What the run used. Equal to `charged` unless a lot could not cover it. */
  consumed: number;
  /** The part of that no lot covered. */
  owed: number;
  createdAt: string;
}

/** What one studio's credits tab shows. */
export interface StudioCredits {
  /**
   * What this studio can spend right now, below zero when it owes. Sent with
   * the first page only.
   */
  spendable?: number;
  /** What it owes, as a positive number. Sent with the first page only. */
  debt?: number;
  /** Every top-up it received, oldest first. Sent with the first page only. */
  lots?: StudioPurchaseView[];
  /** This studio's spending, one line per event, newest first. */
  ledger: CreditPage<StudioLedgerView>;
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
