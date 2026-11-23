// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The database's own clock (#1580). The deadline sweep ends each round's window at this instant, because every read
 * its notices cause judges "due" by the database clock (`now()`), and a host clock running ahead would announce an
 * item early, before that read can see it, then move past it for good.
 */

import { sql } from "drizzle-orm";
import { db } from "@breatic/core";

/**
 * Read the database clock.
 * @returns Now, as the database tells it.
 * @throws {Error} When the read fails or returns nothing.
 */
export async function readDatabaseClock(): Promise<Date> {
  const rows = await db.execute(sql`SELECT clock_timestamp() AS now`);
  if (!rows[0]) throw new Error("The database clock could not be read.");
  return new Date(String(rows[0].now));
}
