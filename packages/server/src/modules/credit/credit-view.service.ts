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

import { assetService, creditLotRepo, creditLotService } from "@breatic/domain";
import type { LotContext, PayerLedgerRow } from "@breatic/domain";
import { encodeActivityCursor, decodeActivityCursor } from "@breatic/core";
import type { ActivityCursor } from "@breatic/core";
import type {
  CreditLotEntity,
  CreditLotLifecycle,
  CreditLedgerEntryEntity,
} from "@breatic/shared";
import { getCreditPageLimits } from "@server/config/limits.js";

/** One purchase, as the overlay shows it. */
export interface CreditLotView {
  id: string;
  purchasedCredits: number;
  remainingCredits: number;
  designatedStudioId: string | null;
  /** The studio it points at, named. Null when it points at none. */
  designatedStudioName: string | null;
  /** What was paid for it, in the smallest unit of `currency`. */
  paidCents: number;
  currency: string;
  lifecycle: string;
  /** How many refund requests were refused; the lifecycle keeps no trace. */
  refundAttempts: number;
  createdAt: string;
}

/** One lot a studio holds, where the buyer is a column. */
export interface StudioLotView extends CreditLotView {
  /** Who bought it. Absent when their personal studio is gone. */
  buyerName: string | null;
}

/** One ledger row, as the overlay shows it. */
export interface CreditLedgerView {
  id: string;
  actorUserId: string | null;
  /** Who spent it, by display name. */
  actorName: string | null;
  studioId: string | null;
  /** Which studio it was spent in, by name. Survives that studio's deletion. */
  studioName: string | null;
  projectId: string | null;
  /** Where it was spent, by name. */
  projectName: string | null;
  model: string | null;
  provider: string | null;
  /** What left a purchase. */
  charged: number;
  /** What the run used, debt included. */
  consumed: number;
  /** How much of it went on the tab. */
  owed: number;
  createdAt: string;
}

/** One keyset page. */
export interface CreditPage<T> {
  items: T[];
  /** Feed back as `?cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

/**
 * Decode a cursor, treating anything unusable as "start from the beginning".
 * @param raw - The client's `?cursor`, if any.
 * @returns The decoded cursor, or null to start from the beginning.
 */
function readCursor(raw: string | undefined): ActivityCursor | null {
  return raw ? decodeActivityCursor(raw) : null;
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
function toLotView(lot: CreditLotEntity & LotContext): CreditLotView {
  return {
    id: lot.id,
    purchasedCredits: toNumber(lot.purchasedCredits),
    remainingCredits: toNumber(lot.remainingCredits),
    designatedStudioId: lot.designatedStudioId,
    designatedStudioName: lot.designatedStudioName,
    paidCents: lot.paidCents,
    currency: lot.currency,
    lifecycle: lot.lifecycle,
    refundAttempts: lot.refundAttempts,
    createdAt: lot.createdAt.toISOString(),
  };
}

/**
 * Map a lot to its display shape on a studio's page.
 * @param lot - The stored lot, with the buyer's name joined in.
 * @returns The view model.
 */
function toStudioLotView(lot: creditLotRepo.StudioLot): StudioLotView {
  return { ...toLotView(lot), buyerName: lot.buyerName };
}

/**
 * Map a ledger row to its display shape.
 * @param entry - The stored row.
 * @returns The view.
 */
function toLedgerView(row: PayerLedgerRow): CreditLedgerView {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    studioId: row.studioId,
    studioName: row.studioName,
    projectId: row.projectId,
    projectName: row.projectName,
    model: row.model,
    provider: row.provider,
    charged: toNumber(row.charged),
    consumed: toNumber(row.consumed),
    owed: toNumber(row.owed),
    createdAt: row.createdAt.toISOString(),
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
 * @param keyOf - The row's `(created_at::text, id)` for the cursor.
 * @returns The page and its next cursor.
 */
function toPage<TRow, TView>(
  rows: TRow[],
  size: number,
  map: (row: TRow) => TView,
  keyOf: (row: TRow) => { cursorAt: string; id: string },
): CreditPage<TView> {
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor:
      hasMore && last
        ? encodeActivityCursor(keyOf(last).cursorAt, keyOf(last).id)
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
  lifecycle?: CreditLotLifecycle,
): Promise<CreditPage<CreditLotView>> {
  const size = pageSize(rawLimit);
  const cursor = readCursor(rawCursor);
  const rows = await creditLotRepo.listLotsByUser(userId, size + 1, cursor, lifecycle);
  return toPage(rows, size, toLotView, (row) => ({
    cursorAt: row.cursorAt,
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
    cursorAt: row.cursorAt,
    id: row.id,
  }));
}

/**
 * What the studio owning a project can spend, for the project's top bar.
 *
 * The same figure the studio's credits page shows, below zero when the studio
 * owes. Reached by project id because that is what the page holds.
 * @param projectId - The project being viewed.
 * @returns The studio's spendable credits.
 * @throws {NotFoundError} When the project has no live studio.
 */
export async function getProjectCredits(projectId: string): Promise<number> {
  const studioId = await assetService.resolveOwnerStudioId(projectId);
  return creditLotService.getSpendableCredits(studioId);
}

/** One line of a studio's ledger: everything one event moved. */
export interface StudioLedgerView {
  id: string;
  /** A generation, or a designation paying off what the studio owed. */
  kind: "generation" | "debt_repayment";
  actorUserId: string | null;
  /** Who ran it, by display name. */
  actorName: string | null;
  projectId: string | null;
  /** Where it ran, by name. */
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

/** What one studio holds and has spent, for its credits tab. */
export interface StudioCreditsView {
  /** Present on the first page only — it does not change between pages. */
  spendable?: number;
  /** What the studio owes, as a positive number. First page only. */
  debt?: number;
  /** Present on the first page only, for the same reason. */
  lots?: StudioLotView[];
  ledger: CreditPage<StudioLedgerView>;
}

/**
 * Map one grouped ledger line to its display shape.
 * @param row - The grouped row.
 * @returns The view model.
 */
function toStudioLedgerView(
  row: creditLotRepo.StudioLedgerRow,
): StudioLedgerView {
  return {
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    projectId: row.projectId,
    projectName: row.projectName,
    model: row.model,
    provider: row.provider,
    charged: toNumber(row.charged),
    consumed: toNumber(row.consumed),
    owed: toNumber(row.owed),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Where a studio ledger row sits in the keyset.
 * @param row - The row.
 * @returns Its `created_at` text and id.
 */
function studioLedgerKey(row: creditLotRepo.StudioLedgerRow): {
  cursorAt: string;
  id: string;
} {
  return { cursorAt: row.cursorAt, id: row.id };
}

/**
 * One studio's credits, as its admin sees them.
 *
 * The pool is the studio's and so is the ledger: the admin manages this
 * studio's money, and taking the ledger by payer would hide what everyone
 * else's top-ups paid for. The person on each line is whoever ran the
 * generation.
 *
 * The tab opens with four figures that state they add up, so the first page
 * takes them from one snapshot. A continuation asks for ledger lines and
 * nothing else, and reads only those: the other three are on the client's
 * screen already, and one of them is the studio's whole list of lots, which
 * has no limit and grows with every lot the studio is given.
 *
 * Which page it is comes off the decoded cursor, the same value the ledger
 * read below uses. Asking whether the client sent a string instead splits the
 * request in half on the one input where the two disagree: a cursor that
 * arrives but decodes to nothing would take the ledger to its first page
 * while this half treated the request as a continuation and omitted the
 * fields the tab opens with.
 * @param studioId - The studio being viewed.
 * @param rawLimit - The client's `?limit`, if any.
 * @param rawCursor - The client's `?cursor`, if any.
 * @returns The studio's credit view.
 */
export async function getStudioCredits(
  studioId: string,
  rawLimit?: string,
  rawCursor?: string,
): Promise<StudioCreditsView> {
  const size = pageSize(rawLimit);
  const cursor = readCursor(rawCursor);

  if (cursor) {
    const rows = await creditLotRepo.listLedgerByStudio(
      studioId,
      size + 1,
      cursor,
    );
    return {
      ledger: toPage(rows, size, toStudioLedgerView, studioLedgerKey),
    };
  }

  const snapshot = await creditLotService.readStudioCredits(studioId, size + 1);
  return {
    spendable: snapshot.spendable,
    debt: snapshot.debt,
    lots: snapshot.lots.map(toStudioLotView),
    ledger: toPage(snapshot.ledger, size, toStudioLedgerView, studioLedgerKey),
  };
}
