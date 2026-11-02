// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { z } from "zod";
import { createPgClient } from "@core/db/client.js";

const timestamp = z.string().min(1).refine(value => Number.isFinite(Date.parse(value)));
const confirmationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("user_confirmed_historical_manual_gift"),
  sourceId: z.string().uuid(),
  lotId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  personalStudioId: z.string().uuid(),
  originalCredits: z.string().regex(/^(?:0|[1-9]\d{0,13})\.\d{6}$/).refine(value => /[1-9]/.test(value)),
  sourceCreatedAt: timestamp,
  lotCreatedAt: timestamp,
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confirmedAt: timestamp,
}).strict();

/** A confirmation of existing funding; it neither claims an original operator nor requests more credits. */
export type LegacyGiftConfirmation = z.infer<typeof confirmationSchema>;

/**
 * Run pending original migration files with one explicitly confirmed historical gift.
 * The dedicated, non-recycled connection never shares its session setting with application traffic.
 * Losing that connection loses the setting and makes the pending backfill fail closed.
 * @param url - The caller's configured database connection.
 * @param migrationsFolder - The immutable release's original migration directory.
 * @param input - The operator-verified private confirmation, never an HTTP funding request.
 * @returns Nothing; the native migrator commits all pending entries or rolls them back.
 * @throws {Error} When confirmation shape, matching funding facts or a migration is invalid.
 */
export async function migrateConfirmedGiftDatabase(url: string, migrationsFolder: string, input: unknown): Promise<void> {
  const parsed = confirmationSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid historical manual gift confirmation");
  const client = createPgClient(url, { name: "confirmed-gift-migrate", max: 1, prepare: false, idle_timeout: 0, max_lifetime: 0, onnotice: () => {} });
  try {
    await client`SELECT set_config('breatic.legacy_gift_confirmation',${JSON.stringify(parsed.data)},false)`;
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
