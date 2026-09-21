// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { creditSources, type DbTx } from "@breatic/core";

/**
 * What a lot of credits can come from.
 *
 * The same four words are the `credit_sources_kind_check` list in 0079. An
 * integration test inserts every one of these, so a fifth added here without a
 * migration widening that constraint fails there rather than at runtime.
 */
export const CREDIT_SOURCE_KINDS = [
  "payment",
  "compensation",
  "gift",
  "discount",
] as const;

/** One of {@link CREDIT_SOURCE_KINDS}. */
export type CreditSourceKind = (typeof CREDIT_SOURCE_KINDS)[number];

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
