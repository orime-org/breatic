// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Purchase history (inner#1993 §3.2 #5): how an account came by its credits,
 * newest first. The product holds every lot (bought, gifted, compensated)
 * and the receipt of every payment it granted, lot or not; the billing
 * service holds the payments the product has no receipt for yet (clearing,
 * failed, abandoned) and whether each purchase's letter can be sent again.
 * Both halves are read on one keyset and merged.
 */

import { env, MAIL_STATUS_IDS_MAX, mailStatusAnswerSchema, toPage, unlandedPaymentsAnswerSchema } from "@breatic/core";
import { creditLotRepo, creditSourceRepo } from "@breatic/domain";
import {
  type CreditLotLifecycle,
  type CreditPage,
  type CreditSourceKind,
  type PurchaseRow,
} from "@breatic/shared";
import { requestCommerce, userPath } from "@server/modules/commerce/commerce-client.js";
import { pageSize, readCursor, toDecimal } from "@server/modules/credit/credit-view.service.js";

/** A history row and the keyset position it sorts by. */
interface Keyed {
  row: PurchaseRow;
  cursorAt: string;
  /** A payment the product holds the receipt of: its resend state is asked of the billing service. */
  receipt: boolean;
}

/**
 * One account's purchase history page.
 * @param userId - The signed-in account.
 * @param rawLimit - The page size asked for.
 * @param rawCursor - The previous page's cursor.
 * @returns The page.
 * @throws {UnavailableError} When the billing service cannot answer its half.
 */
export async function readPurchaseHistory(userId: string, rawLimit: string | undefined, rawCursor: string | undefined): Promise<CreditPage<PurchaseRow>> {
  const size = pageSize(rawLimit);
  const cursor = readCursor(rawCursor);

  const local = await localRows(userId, size, cursor);
  const merged = env.SELLING ? [...local, ...(await unlandedRows(userId, size, cursor === null ? null : rawCursor!))] : local;
  merged.sort((a, b) => compareDesc(a, b));
  const taken = merged.slice(0, size + 1);
  // Only the rows the page returns; the extra one only tells whether more exist.
  if (env.SELLING) await fillCanResend(userId, taken.slice(0, size));
  return toPage(taken, size, (k) => k.row, (k) => ({ cursorAt: k.cursorAt, id: k.row.rowId }));
}

/**
 * Newest first, then the larger id.
 * @param a - One row.
 * @param b - Another.
 * @returns The sort order.
 */
function compareDesc(a: Keyed, b: Keyed): number {
  if (a.cursorAt !== b.cursorAt) return a.cursorAt < b.cursorAt ? 1 : -1;
  return a.row.rowId < b.row.rowId ? 1 : a.row.rowId > b.row.rowId ? -1 : 0;
}

/**
 * The product's half: its lots and the receipts that have no live lot.
 * @param userId - The account.
 * @param size - The page size.
 * @param cursor - Where the previous page ended.
 * @returns Up to `size + 1` rows, the bought ones not yet knowing whether they can be resent.
 * @throws {Error} When a gift's origin or an enterprise purchase's receipt is missing.
 */
async function localRows(userId: string, size: number, cursor: { createdAt: string; id: string } | null): Promise<Keyed[]> {
  const rows = await creditLotRepo.listLotHistory(userId, size, cursor);
  const details = await creditSourceRepo.readReceiptDetails(rows);
  return rows.map((r) => {
    return {
      cursorAt: r.cursorAt,
      receipt: r.paymentId !== null,
      row: {
        rowId: r.rowId,
        sourceKind: r.sourceKind as CreditSourceKind,
        ...details.get(r.sourceId),
        paymentId: r.paymentId,
        amountCents: r.amountCents,
        totalCents: r.totalCents,
        taxCents: r.taxCents,
        currency: r.currency,
        creditsGranted: toDecimal(r.creditsGranted),
        remainingCredits: r.remainingCredits === null ? null : toDecimal(r.remainingCredits),
        lifecycle: r.lifecycle as CreditLotLifecycle | null,
        designatedStudioId: r.designatedStudioId,
        designatedStudioName: r.designatedStudioName,
        status: r.paymentId === null ? null : "completed",
        createdAt: r.createdAt.toISOString(),
        canResend: false,
      },
    };
  });
}

/**
 * The billing service's half: payments that opened no lot.
 * @param userId - The account.
 * @param size - The page size.
 * @param rawCursor - The previous page's cursor as the browser sent it, or null.
 * @returns Up to `size + 1` rows.
 * @throws {UnavailableError} When the billing service cannot answer.
 */
async function unlandedRows(userId: string, size: number, rawCursor: string | null): Promise<Keyed[]> {
  const query = `?limit=${size + 1}${rawCursor === null ? "" : `&before=${encodeURIComponent(rawCursor)}`}`;
  const answer = unlandedPaymentsAnswerSchema.parse(
    await requestCommerce({ method: "GET", path: userPath(userId, `/payment/history/unlanded${query}`), quick: true }),
  );
  return answer.data.map((p) => ({
    cursorAt: p.cursorAt,
    receipt: false,
    row: {
      rowId: p.paymentId,
      sourceKind: "payment",
      paymentId: p.paymentId,
      amountCents: p.amountCents,
      totalCents: p.totalCents,
      taxCents: p.taxCents,
      currency: p.currency,
      creditsGranted: toDecimal(p.creditsGranted),
      remainingCredits: null,
      lifecycle: null,
      designatedStudioId: null,
      designatedStudioName: null,
      status: p.status,
      createdAt: p.createdAt,
      canResend: p.canResend,
    },
  }));
}

/**
 * Ask the billing service which of the product's bought rows can have their letter sent again.
 *
 * A page may be larger than one request may carry (`credit_page_max` is an
 * operator setting), so the ids go in chunks of `MAIL_STATUS_IDS_MAX`.
 * @param userId - The account.
 * @param rows - The page's rows; the product's bought ones are filled in.
 * @throws {UnavailableError} When the billing service cannot answer.
 */
async function fillCanResend(userId: string, rows: Keyed[]): Promise<void> {
  const local = rows.filter((k) => k.receipt);
  for (let start = 0; start < local.length; start += MAIL_STATUS_IDS_MAX) {
    const chunk = local.slice(start, start + MAIL_STATUS_IDS_MAX);
    const answer = mailStatusAnswerSchema.parse(
      await requestCommerce({
        method: "POST",
        path: userPath(userId, "/payment/mail-status"),
        body: { paymentIds: chunk.map((k) => k.row.paymentId!) },
        quick: true,
      }),
    );
    for (const k of chunk) k.row.canResend = answer.data[k.row.paymentId!] === true;
  }
}
