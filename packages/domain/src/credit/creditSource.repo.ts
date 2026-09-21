// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { db, creditSources, type DbTx } from "@breatic/core";
import { eq } from "drizzle-orm";

/** What a lot of credits can come from. */
export type CreditSourceKind =
  | "payment"
  | "compensation"
  | "gift"
  | "discount";

/** One receipt: what a lot of credits came from. */
export interface CreditSourceEntity {
  id: string;
  kind: CreditSourceKind;
  createdAt: Date;
}

/**
 * Open a receipt for credits about to be granted.
 *
 * The id is the caller's, because each kind of source shares its primary key
 * with the row that holds its details — a payment's own id IS its source id.
 * That is what lets a redelivered webhook reach the same source: it reads the
 * payment it already has rather than opening a second receipt, which would
 * hand it a fresh id and let the unique index on `credit_lots.source_id` admit
 * a second grant.
 * @param data - The receipt to open.
 * @param data.id - The id of the row that holds this source's details.
 * @param data.kind - Which kind of source it is.
 * @param tx - The transaction the detail row is written in. The two commit
 *   together, so neither can exist without the other.
 * @returns The new source.
 * @throws {Error} If a source already carries this id.
 */
export async function createSource(
  data: { id: string; kind: CreditSourceKind },
  tx?: DbTx,
): Promise<CreditSourceEntity> {
  const conn = tx ?? db;
  const rows = await conn
    .insert(creditSources)
    .values({ id: data.id, kind: data.kind })
    .returning();
  const row = rows[0]!;
  return {
    id: row.id,
    kind: row.kind as CreditSourceKind,
    createdAt: row.createdAt,
  };
}

/**
 * Read one receipt back.
 * @param id - The source id, which is also its detail row's id.
 * @returns The source, or null where none was opened under that id.
 */
export async function findSourceById(
  id: string,
): Promise<CreditSourceEntity | null> {
  const rows = await db
    .select()
    .from(creditSources)
    .where(eq(creditSources.id, id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind as CreditSourceKind,
    createdAt: row.createdAt,
  };
}
