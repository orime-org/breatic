// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { QueryClient } from '@tanstack/react-query';

import { creditOverviewKey } from '@web/features/credits/use-credit-overview';

/**
 * Query key for the account's purchases read as lots.
 *
 * Without a scope it is the prefix both lists share, so invalidating it marks
 * the assign list (`active`) and the refunds list (`all`) together.
 * @param userId - Whose money, or null while nobody is signed in.
 * @param scope - Which lots one list reads.
 * @returns That key.
 */
export function creditLotsKey(
  userId: string | null,
  scope?: 'active' | 'all',
): readonly unknown[] {
  return scope === undefined ? ['credits', 'lots', userId] : ['credits', 'lots', userId, scope];
}

/**
 * Query key for the account's credit ledger.
 *
 * Without a Studio it is the prefix every filtered page shares.
 * @param userId - Whose money, or null while nobody is signed in.
 * @param studioId - The Studio filter one page reads.
 * @returns That key.
 */
export function creditLedgerKey(userId: string | null, studioId?: string): readonly unknown[] {
  return studioId === undefined
    ? ['credits', 'ledger', userId]
    : ['credits', 'ledger', userId, studioId];
}

/**
 * Query key for the account's purchase history.
 * @param userId - Whose money, or null while nobody is signed in.
 * @returns That key.
 */
export function paymentHistoryKey(userId: string | null): readonly unknown[] {
  return ['payment', 'history', userId];
}

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
    client.invalidateQueries({ queryKey: creditLotsKey(userId) }),
    client.invalidateQueries({ queryKey: creditOverviewKey(userId) }),
    client.invalidateQueries({ queryKey: paymentHistoryKey(userId) }),
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
    client.invalidateQueries({ queryKey: creditLedgerKey(userId) }),
  ]);
}
