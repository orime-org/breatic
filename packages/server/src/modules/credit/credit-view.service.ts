// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The read side of credits (task #11) — what the overlay and the studio's
 * credits tab display.
 *
 * Credits leave here as numbers. They are stored as `numeric(20, 6)` and every
 * calculation runs in Postgres or on integer micro-credits; this boundary is
 * the one place a value stops being arithmetic and becomes something to show,
 * and the wire's number range covers billions of credits, five orders above
 * the largest pack.
 */

import { creditLotRepo, creditLotService } from "@breatic/domain";
import { encodeActivityCursor, decodeActivityCursor } from "@breatic/core";
import type { ActivityCursor } from "@breatic/core";
import type { CreditLotEntity, CreditLedgerEntryEntity } from "@breatic/shared";
import { getCreditPageLimits } from "@server/config/limits.js";

/** One purchase, as the overlay shows it. */
export interface CreditLotView {
  id: string;
  purchasedCredits: number;
  remainingCredits: number;
  designatedStudioId: string | null;
  lifecycle: string;
  /** How many refund requests were refused; the lifecycle keeps no trace. */
  refundAttempts: number;
  createdAt: string;
}

/** One ledger row, as the overlay shows it. */
export interface CreditLedgerView {
  id: string;
  entryType: string;
  amount: number;
  actorUserId: string | null;
  /** Who spent it, by display name. */
  actorName: string | null;
  /** Where it was spent, by name. */
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
  /** Feed back as `?cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

/** Matches a canonical UUID, which is what the id columns hold. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode a cursor, treating anything unusable as "start from the beginning".
 *
 * The shared decoder checks that the timestamp is a finite number and the id a
 * non-empty string, which two usable-looking shapes still get past: an id that
 * is not a uuid reaches a uuid column, and a number no Date can represent
 * reaches the driver as an invalid date. Both surface as a failed request on a
 * value that arrived over the network.
 * @param raw - The client's `?cursor`, if any.
 * @returns The decoded cursor, or null to start from the beginning.
 */
function readCursor(raw: string | undefined): ActivityCursor | null {
  if (!raw) return null;
  const cursor = decodeActivityCursor(raw);
  if (!cursor) return null;
  if (!UUID.test(cursor.id)) return null;
  if (Number.isNaN(cursor.createdAt.getTime())) return null;
  return cursor;
}

/**
 * Clamp a client's `?limit` to the configured bounds.
 * @param raw - The raw query value, if any.
 * @returns A page size within bounds.
 */
function pageSize(raw: string | undefined): number {
  const bounds = getCreditPageLimits();
  const asked = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(asked) || asked <= 0) return bounds.default;
  return Math.min(asked, bounds.max);
}

/**
 * Turn a stored decimal string into the number the wire carries.
 * @param value - A `numeric(20, 6)` value as Postgres returned it.
 * @returns The same amount as a number.
 */
function toNumber(value: string): number {
  return Number(value);
}

/**
 * Map a lot to its display shape.
 * @param lot - The stored lot.
 * @returns The view.
 */
function toLotView(lot: CreditLotEntity): CreditLotView {
  return {
    id: lot.id,
    purchasedCredits: toNumber(lot.purchasedCredits),
    remainingCredits: toNumber(lot.remainingCredits),
    designatedStudioId: lot.designatedStudioId,
    lifecycle: lot.lifecycle,
    refundAttempts: lot.refundAttempts,
    createdAt: lot.createdAt.toISOString(),
  };
}

/**
 * Map a ledger row to its display shape.
 * @param entry - The stored row.
 * @returns The view.
 */
function toLedgerView(entry: CreditLedgerEntryEntity): CreditLedgerView {
  return {
    id: entry.id,
    entryType: entry.entryType,
    amount: toNumber(entry.amount),
    actorUserId: entry.actorUserId,
    actorName: entry.actorName,
    projectName: entry.projectName,
    studioId: entry.studioId,
    projectId: entry.projectId,
    lotId: entry.lotId,
    model: entry.model,
    provider: entry.provider,
    tokensUsed: entry.tokensUsed,
    description: entry.description,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Build a keyset page out of one row over the asked-for size.
 *
 * The extra row is what distinguishes "the page is full" from "there is more":
 * counting the total would cost a second scan and would still be stale by the
 * time the next page is asked for.
 * @param rows - Rows fetched, one more than the page size.
 * @param size - The page size asked for.
 * @param map - How to turn a row into its view.
 * @param keyOf - The row's `(created_at, id)` for the cursor.
 * @returns The page and its next cursor.
 */
function toPage<TRow, TView>(
  rows: TRow[],
  size: number,
  map: (row: TRow) => TView,
  keyOf: (row: TRow) => { createdAt: Date; id: string },
): CreditPage<TView> {
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor:
      hasMore && last
        ? encodeActivityCursor(keyOf(last).createdAt, keyOf(last).id)
        : null,
  };
}

/**
 * What this account holds and where it went.
 * @param userId - The signed-in account.
 * @returns The overview.
 */
export async function getOverview(
  userId: string,
): Promise<Awaited<ReturnType<typeof creditLotService.getOverview>>> {
  return creditLotService.getOverview(userId);
}

/**
 * This account's purchases, newest first.
 * @param userId - The signed-in account.
 * @param rawLimit - The client's `?limit`, if any.
 * @param rawCursor - The client's `?cursor`, if any.
 * @returns One page of purchases.
 */
export async function listLots(
  userId: string,
  rawLimit?: string,
  rawCursor?: string,
): Promise<CreditPage<CreditLotView>> {
  const size = pageSize(rawLimit);
  const cursor = readCursor(rawCursor);
  const rows = await creditLotRepo.listLotsByUser(userId, size + 1, cursor);
  return toPage(rows, size, toLotView, (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }));
}

/**
 * This account's ledger, newest first, always taken by payer.
 * @param userId - The signed-in account, whose money this is.
 * @param rawLimit - The client's `?limit`, if any.
 * @param rawCursor - The client's `?cursor`, if any.
 * @param studioId - Narrow to one studio, if asked for.
 * @returns One page of ledger rows.
 */
export async function listLedger(
  userId: string,
  rawLimit?: string,
  rawCursor?: string,
  studioId?: string,
): Promise<CreditPage<CreditLedgerView>> {
  const size = pageSize(rawLimit);
  const cursor = readCursor(rawCursor);
  const rows = await creditLotRepo.listLedgerByPayer(
    userId,
    size + 1,
    cursor,
    studioId,
  );
  return toPage(rows, size, toLedgerView, (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }));
}

/** What one studio holds and has spent, for its credits tab. */
export interface StudioCreditsView {
  /** Present on the first page only — it does not change between pages. */
  spendable?: number;
  /** Present on the first page only, for the same reason. */
  lots?: CreditLotView[];
  ledger: CreditPage<CreditLedgerView>;
}

/**
 * One studio's credits, as its members see them.
 *
 * The pool is the studio's, so every member sees what it can spend. The ledger
 * beside it is still taken by payer: it answers "where did MY money go in this
 * studio", and a member reading it sees their own contribution, not the
 * studio's whole history.
 * @param studioId - The studio being viewed.
 * @param viewerUserId - The signed-in member.
 * @param rawLimit - The client's `?limit`, if any.
 * @param rawCursor - The client's `?cursor`, if any.
 * @returns The studio's credit view.
 */
export async function getStudioCredits(
  studioId: string,
  viewerUserId: string,
  rawLimit?: string,
  rawCursor?: string,
): Promise<StudioCreditsView> {
  const ledgerPage = listLedger(viewerUserId, rawLimit, rawCursor, studioId);
  // Asked of the decoded cursor, which is what the ledger under this reads
  // too. Asking whether the client sent a string instead splits the page in
  // half on the one input where the two disagree: a cursor that parses but
  // decodes to nothing takes the ledger to its first page while this half
  // treats the request as a continuation and omits the two fields the tab
  // opens with.
  if (readCursor(rawCursor)) return { ledger: await ledgerPage };

  const [spendable, lots, ledger] = await Promise.all([
    creditLotService.getSpendableCredits(studioId),
    creditLotRepo.listLotsByStudio(studioId),
    ledgerPage,
  ]);
  return { spendable, lots: lots.map(toLotView), ledger };
}
