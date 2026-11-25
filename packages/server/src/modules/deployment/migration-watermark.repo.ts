// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { rawPg } from "@breatic/core";

export type BusinessMigrationWatermark = {
  count: number;
  watermark: number | null;
};

/**
 * Read the business database's applied migration count and highest timestamp.
 * @returns The aggregate ledger state, without individual migration records.
 * @throws {Error} When the ledger cannot be queried.
 */
export async function readBusinessMigrationWatermark(): Promise<BusinessMigrationWatermark> {
  const [row] = await rawPg<{ count: number; watermark: string | null }[]>`
    SELECT count(*)::int AS count, max(created_at)::text AS watermark
    FROM drizzle.__drizzle_migrations
  `;
  if (row === undefined) throw new Error("Missing business migration aggregate");
  return { count: row.count, watermark: row.watermark === null ? null : Number(row.watermark) };
}
