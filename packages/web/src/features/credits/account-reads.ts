// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { QueryClient } from '@tanstack/react-query';

import { creditOverviewKey } from '@web/features/credits/use-credit-overview';

/**
 * Re-reads everything on this panel that speaks about one purchase.
 *
 * A purchase is a row on the history, a figure among the overview's three,
 * and a row on both the assign and refunds lists — four screens backed by
 * three query keys, with nothing but this connecting them. Whatever moved
 * that purchase, or was turned down for trying to, left all three behind.
 *
 * The ledger is not among them: it records credits entering and leaving, and
 * neither a refused write nor a refund request writes an entry. What does is
 * {@link invalidateAfterLedgerWrite}.
 * @param client - The query client holding the panel's reads.
 * @param userId - Whose money, as the three keys spell it.
 * @returns When all three have been marked.
 */
export async function invalidateAccountReads(
  client: QueryClient,
  userId: string | null,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['credits', 'lots', userId] }),
    client.invalidateQueries({ queryKey: creditOverviewKey(userId) }),
    client.invalidateQueries({ queryKey: ['payment', 'history', userId] }),
  ]);
}

/**
 * The same three, plus the ledger, for a write that moved credits.
 *
 * Pointing a purchase at a Studio that owed writes a repayment, so the
 * ledger is a fourth reader with a stale answer. Separating the two is what
 * keeps a refused write from re-reading a list nothing changed.
 * @param client - The query client holding the panel's reads.
 * @param userId - Whose money.
 * @returns When all four have been marked.
 */
export async function invalidateAfterLedgerWrite(
  client: QueryClient,
  userId: string | null,
): Promise<void> {
  await Promise.all([
    invalidateAccountReads(client, userId),
    client.invalidateQueries({ queryKey: ['credits', 'ledger', userId] }),
  ]);
}
