// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Opening the receipt a test payment is written under.
 */

import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/**
 * Opens the `credit_sources` row a payment is filed under.
 *
 * A payment shares its source row's primary key (migration 0079), so the
 * receipt is opened first and the payment is inserted with the id this
 * returns.
 * @param sql - The connection to write through.
 * @param createdAt - When the receipt says it was opened; the column default
 *   applies when omitted.
 * @returns The source id, which the payment row takes as its own.
 */
export async function openPaymentSource(sql: Sql, createdAt?: string): Promise<string> {
  const [source] =
    createdAt === undefined
      ? await sql<{ id: string }[]>`
          INSERT INTO credit_sources (id, kind)
          VALUES (gen_random_uuid(), 'payment') RETURNING id
        `
      : await sql<{ id: string }[]>`
          INSERT INTO credit_sources (id, kind, created_at)
          VALUES (gen_random_uuid(), 'payment', ${createdAt}) RETURNING id
        `;
  return source!.id;
}
