// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether a connection can write exactly what a write scope lists (inner#2043).
 *
 * collab's entry runs it at startup with `COLLAB_WRITE_SCOPE`: every product
 * table must be readable, no table may be deleted from, truncated, triggered
 * or referenced, and inserts and updates must match the scope table by table
 * and column by column. The tables come from `pg_catalog.pg_tables`, since
 * `information_schema` lists only the tables the connection already has a
 * privilege on, and an unreadable table would be missing there. The check
 * returns what it found; the caller logs and exits.
 */

import type { Sql } from "postgres";
import { rawPg } from "@core/db/client.js";
import type { CollabWriteScope } from "@core/db/collab-write-scope.js";

interface TableRow {
  t: string;
  canSelect: boolean;
  other: boolean;
  tableInsert: boolean;
  tableUpdate: boolean;
  anyInsert: boolean;
  anyUpdate: boolean;
}

/**
 * Compare the connection's privileges on every public table with a write scope.
 * @param expected - The tables and columns the connection may write.
 * @param sql - The connection to check; core's `rawPg` by default.
 * @returns One line per difference, naming the table and, for a column, the column; empty when they match.
 * @throws {Error} When the catalog queries fail.
 */
export async function checkWriteScope(expected: CollabWriteScope, sql: Sql = rawPg): Promise<string[]> {
  const tables = await sql<TableRow[]>`
    SELECT tablename AS t,
      has_table_privilege(q, 'SELECT') AS "canSelect",
      has_table_privilege(q, 'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS other,
      has_table_privilege(q, 'INSERT') AS "tableInsert",
      has_table_privilege(q, 'UPDATE') AS "tableUpdate",
      has_any_column_privilege(q, 'INSERT') AS "anyInsert",
      has_any_column_privilege(q, 'UPDATE') AS "anyUpdate"
    FROM pg_catalog.pg_tables, LATERAL (SELECT format('%I.%I', schemaname, tablename) AS q) named
    WHERE schemaname = 'public'
    ORDER BY tablename`;
  const columns = await sql<{ t: string; c: string; canUpdate: boolean }[]>`
    SELECT c.relname AS t, a.attname AS c, has_column_privilege(c.oid, a.attnum, 'UPDATE') AS "canUpdate"
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY(${Object.keys(expected)}) AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY 1, 2`;

  const violations: string[] = [];
  const present = new Set(tables.map((row) => row.t));
  for (const row of tables) {
    const scope = expected[row.t];
    if (!row.canSelect) violations.push(`table ${row.t}: SELECT expected, not granted`);
    if (row.other) violations.push(`table ${row.t}: DELETE, TRUNCATE, TRIGGER or REFERENCES granted, expected none`);
    if (scope === undefined) {
      if (row.anyInsert || row.anyUpdate) violations.push(`table ${row.t}: INSERT or UPDATE granted, expected none`);
      continue;
    }
    if (scope.insert && !row.tableInsert) violations.push(`table ${row.t}: INSERT expected, not granted`);
    if (!scope.insert && row.anyInsert) violations.push(`table ${row.t}: INSERT granted, expected none`);
    if (row.tableUpdate) violations.push(`table ${row.t}: table-level UPDATE granted, expected only listed columns`);
  }
  for (const table of Object.keys(expected)) {
    if (!present.has(table)) violations.push(`table ${table}: listed in the write scope but does not exist`);
  }
  for (const { t, c, canUpdate } of columns) {
    const listed = expected[t]!.update.includes(c);
    if (listed && !canUpdate) violations.push(`table ${t} column ${c}: UPDATE expected, not granted`);
    if (!listed && canUpdate) violations.push(`table ${t} column ${c}: UPDATE granted, expected none`);
  }
  for (const [table, scope] of Object.entries(expected)) {
    for (const column of scope.update) {
      if (present.has(table) && !columns.some((row) => row.t === table && row.c === column)) {
        violations.push(`table ${table} column ${column}: listed in the write scope but does not exist`);
      }
    }
  }
  return violations;
}
