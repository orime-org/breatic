// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Purchase history (inner#1993 §3.2 #5): how an account came by its credits,
 * newest first. The product holds every lot (bought, gifted, compensated);
 * the billing service holds the payments that opened none yet (clearing,
 * failed, abandoned) and whether each purchase's letter can be sent again.
 * Both halves are read on one keyset and merged.
 */

import { decodeActivityCursor, env, mailStatusAnswerSchema, toPage, unlandedPaymentsAnswerSchema } from "@breatic/core";
import { creditLotRepo, creditSourceRepo } from "@breatic/domain";
import {
  parseCreditDecimal,
  serializeCreditMicro,
  type CreditDecimal,
  type CreditLotLifecycle,
  type CreditPage,
  type CreditSourceKind,
  type PurchaseRow,
} from "@breatic/shared";
import { getCreditPageLimits } from "@server/config/limits.js";
import { requestCommerce, userPath } from "@server/modules/commerce/commerce-client.js";

/** A history row and the keyset position it sorts by. */
interface Keyed {
  row: PurchaseRow;
  cursorAt: string;
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
  const bounds = getCreditPageLimits();
  const asked = rawLimit === undefined ? Number.NaN : Number.parseInt(rawLimit, 10);
  const size = !Number.isFinite(asked) || asked <= 0 ? bounds.default : Math.min(asked, bounds.max);
  const cursor = rawCursor === undefined ? null : decodeActivityCursor(rawCursor);

  const local = await localRows(userId, size, cursor);
  const merged = env.SELLING ? [...local, ...(await unlandedRows(userId, size, cursor === null ? null : rawCursor!))] : local;
  merged.sort((a, b) => compareDesc(a, b));
  const taken = merged.slice(0, size + 1);
  if (env.SELLING) await fillCanResend(userId, taken);
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
 * The product's half: its lots.
 * @param userId - The account.
 * @param size - The page size.
 * @param cursor - Where the previous page ended.
 * @returns Up to `size + 1` rows, the bought ones not yet knowing whether they can be resent.
 * @throws {Error} When a gift's origin is missing.
 */
async function localRows(userId: string, size: number, cursor: { createdAt: string; id: string } | null): Promise<Keyed[]> {
  const rows = await creditLotRepo.listLotHistory(userId, size, cursor);
  const gifts = rows.filter((r) => r.sourceKind === "gift").map((r) => r.sourceId);
  const origins = await creditSourceRepo.readGiftOrigins(gifts);
  return rows.map((r) => {
    if (r.sourceKind === "gift" && !origins.has(r.sourceId)) throw new Error("Gift receipt origin missing");
    return {
      cursorAt: r.cursorAt,
      row: {
        rowId: r.rowId,
        sourceKind: r.sourceKind as CreditSourceKind,
        ...(r.sourceKind === "gift" ? { giftOrigin: origins.get(r.sourceId)! } : {}),
        paymentId: r.paymentId,
        amountCents: r.amountCents,
        totalCents: r.totalCents,
        taxCents: r.taxCents,
        currency: r.currency,
        creditsGranted: credits(r.creditsGranted),
        remainingCredits: credits(r.remainingCredits),
        lifecycle: r.lifecycle as CreditLotLifecycle,
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
    row: {
      rowId: p.paymentId,
      sourceKind: "payment",
      paymentId: p.paymentId,
      amountCents: p.amountCents,
      totalCents: p.totalCents,
      taxCents: p.taxCents,
      currency: p.currency,
      creditsGranted: credits(p.creditsGranted),
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
 * @param userId - The account.
 * @param rows - The page's rows; the product's bought ones are filled in.
 * @throws {UnavailableError} When the billing service cannot answer.
 */
async function fillCanResend(userId: string, rows: Keyed[]): Promise<void> {
  const local = rows.filter((k) => k.row.paymentId !== null && k.row.lifecycle !== null);
  if (local.length === 0) return;
  const answer = mailStatusAnswerSchema.parse(
    await requestCommerce({
      method: "POST",
      path: userPath(userId, "/payment/mail-status"),
      body: { paymentIds: local.map((k) => k.row.paymentId!) },
      quick: true,
    }),
  );
  for (const k of local) k.row.canResend = answer.data[k.row.paymentId!] === true;
}

/**
 * A stored credit figure in the wire form.
 * @param decimal - The figure as the database reads it.
 * @returns The serialized amount.
 */
function credits(decimal: string): CreditDecimal {
  return serializeCreditMicro(parseCreditDecimal(decimal));
}
