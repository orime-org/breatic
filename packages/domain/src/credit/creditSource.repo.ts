// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { creditSources, type DbTx } from "@breatic/core";
import type { CreditSourceKind } from "@breatic/shared";

// Re-exported rather than declared here: the browser decides what a row
// prints and whether its controls are offered from this same value, so the
// list and its type live in `@breatic/shared`.
export { CREDIT_SOURCE_KINDS, type CreditSourceKind } from "@breatic/shared";

/**
 * Open a receipt for credits about to be granted.
 *
 * The id is the caller's, because each kind of source shares its primary key
 * with the row holding its details — a payment's own id IS its source id.
 * That is what lets a redelivered webhook reach the same source: it reads the
 * payment it already has rather than opening a second receipt, which would
 * hand it a fresh id and let the unique index on `credit_lots.source_id`
 * admit a second grant.
 * @param data - The receipt to open.
 * @param data.id - The id of the row holding this source's details.
 * @param data.kind - Which kind of source it is.
 * @param tx - The transaction the detail row is written in. Required, so the
 *   two commit together and neither can exist without the other.
 * @returns Nothing; the caller already holds the id.
 * @throws {Error} If a source already carries this id.
 */
export async function createSource(
  data: { id: string; kind: CreditSourceKind },
  tx: DbTx,
): Promise<void> {
  await tx.insert(creditSources).values({ id: data.id, kind: data.kind });
}

/**
 * Open a receipt only if this id has not opened one already.
 *
 * The counterpart of {@link createSource}, for grants where a second attempt
 * is an ordinary outcome rather than a fault. A redelivered webhook reaching
 * `createSource` twice means something went wrong and has to be heard; an
 * account that deletes its personal studio and makes another simply arrives
 * here again, and the right answer is to grant nothing and let the studio be
 * created.
 *
 * Which id to use is the same rule either way — a source shares its primary
 * key with the row holding its details, and for a grant made to an account
 * that row is the account. So the collision here IS "this account has already
 * been granted", decided by the primary key rather than by anything counting.
 * @param data - The receipt to open.
 * @param data.id - The id of the row holding this source's details.
 * @param data.kind - Which kind of source it is.
 * @param tx - The transaction the detail row is written in.
 * @returns True when this call opened it; false when it was already open.
 */
export async function claimSource(
  data: { id: string; kind: CreditSourceKind },
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .insert(creditSources)
    .values({ id: data.id, kind: data.kind })
    .onConflictDoNothing({ target: creditSources.id })
    .returning({ id: creditSources.id });
  return rows.length > 0;
}
