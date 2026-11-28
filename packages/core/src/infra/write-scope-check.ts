// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether a connection can write exactly what a write scope lists (inner#2043).
 *
 * collab's entry runs it at startup with `COLLAB_WRITE_SCOPE`. Every product
 * table must be readable; inserts and updates must match the scope table by
 * table and column by column; nothing may be deleted, truncated, triggered or
 * referenced. Beyond the product tables it covers every way PostgreSQL lets a
 * login write, in every schema outside the system ones: views, materialized
 * views and foreign tables, sequences, every SECURITY DEFINER function (it runs
 * as its owner, and triggers, aggregates, event triggers and type I/O run it
 * without the caller's EXECUTE), rules on a table the login writes (they run
 * as the table's owner), roles the login can switch to, the attributes of the
 * login and of every role it can switch to (SET ROLE takes them on), and
 * CREATE on a schema or the database. Objects come from `pg_catalog`, since `information_schema`
 * lists only what the connection already has a privilege on. The check
 * returns what it found; the caller logs and exits.
 */

import type { Sql } from "postgres";
import { rawPg } from "@core/db/client.js";
import { COLLAB_WRITER_ROLE, type CollabWriteScope } from "@core/db/collab-write-scope.js";

interface RelationRow {
  label: string;
  name: string;
  kind: string;
  productTable: boolean;
  canSelect: boolean;
  other: boolean;
  tableInsert: boolean;
  tableUpdate: boolean;
  anyInsert: boolean;
  anyUpdate: boolean;
}

interface RoleAttributesRow {
  role: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

/** The role attributes that let a login act beyond its grants. */
const ROLE_ATTRIBUTES: [keyof RoleAttributesRow, string][] = [
  ["rolsuper", "SUPERUSER"],
  ["rolcreaterole", "CREATEROLE"],
  ["rolcreatedb", "CREATEDB"],
  ["rolreplication", "REPLICATION"],
  ["rolbypassrls", "BYPASSRLS"],
];

/**
 * Compare everything the connection can write with a write scope.
 * @param expected - The tables and columns the connection may write.
 * @param sql - The connection to check; core's `rawPg` by default.
 * @returns One line per difference, naming the object and, for a column, the column; empty when they match.
 * @throws {Error} When the catalog queries fail.
 */
export async function checkWriteScope(expected: CollabWriteScope, sql: Sql = rawPg): Promise<string[]> {
  const relations = await sql<RelationRow[]>`
    SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE format('%I.%I', n.nspname, c.relname) END AS label,
      c.relname AS name,
      CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' ELSE 'table' END AS kind,
      n.nspname = 'public' AND c.relkind IN ('r', 'p') AS "productTable",
      has_table_privilege(c.oid, 'SELECT') AS "canSelect",
      has_table_privilege(c.oid, 'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS other,
      has_table_privilege(c.oid, 'INSERT') AS "tableInsert",
      has_table_privilege(c.oid, 'UPDATE') AS "tableUpdate",
      has_any_column_privilege(c.oid, 'INSERT') AS "anyInsert",
      has_any_column_privilege(c.oid, 'UPDATE') AS "anyUpdate"
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ORDER BY 1`;
  const columns = await sql<{ t: string; c: string; canUpdate: boolean }[]>`
    SELECT c.relname AS t, a.attname AS c, has_column_privilege(c.oid, a.attnum, 'UPDATE') AS "canUpdate"
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY(${Object.keys(expected)}) AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY 1, 2`;
  const sequences = await sql<{ s: string }[]>`
    SELECT c.oid::regclass::text AS s
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      -- The planner may test this before relkind; CASE keeps it to sequences.
      AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE,UPDATE') ELSE false END
    ORDER BY 1`;
  const definers = await sql<{ f: string }[]>`
    SELECT p.oid::regprocedure::text AS f
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ORDER BY 1`;
  const rules = await sql<{ r: string; t: string }[]>`
    SELECT r.rulename AS r, c.oid::regclass::text AS t
    FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE r.ev_type <> '1' AND n.nspname !~ '^pg_'
      AND (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE') OR has_any_column_privilege(c.oid, 'INSERT,UPDATE'))
    ORDER BY 2, 1`;
  const roles = await sql<{ r: string }[]>`
    SELECT rolname AS r FROM pg_catalog.pg_roles
    WHERE pg_has_role(current_user, oid, 'MEMBER') AND rolname <> current_user AND rolname <> ${COLLAB_WRITER_ROLE}
    ORDER BY 1`;
  const schemas = await sql<{ s: string }[]>`
    SELECT nspname AS s FROM pg_catalog.pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND has_schema_privilege(oid, 'CREATE')
    ORDER BY 1`;
  const attributes = await sql<RoleAttributesRow[]>`
    SELECT rolname AS role, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles WHERE pg_has_role(current_user, oid, 'MEMBER')
    ORDER BY 1`;
  const [database] = await sql<{ db: string; createDb: boolean }[]>`
    SELECT current_database() AS db, has_database_privilege(current_database(), 'CREATE') AS "createDb"`;

  const violations: string[] = [];
  const present = new Set(relations.filter((row) => row.productTable).map((row) => row.name));
  for (const row of relations) {
    const what = `${row.kind} ${row.label}`;
    const scope = row.productTable ? expected[row.name] : undefined;
    if (row.productTable && !row.canSelect) violations.push(`${what}: SELECT expected, not granted`);
    if (row.other) violations.push(`${what}: DELETE, TRUNCATE, TRIGGER or REFERENCES granted, expected none`);
    if (scope === undefined) {
      if (row.anyInsert || row.anyUpdate) violations.push(`${what}: INSERT or UPDATE granted, expected none`);
      continue;
    }
    if (scope.insert && !row.tableInsert) violations.push(`${what}: INSERT expected, not granted`);
    if (!scope.insert && row.anyInsert) violations.push(`${what}: INSERT granted, expected none`);
    if (row.tableUpdate) violations.push(`${what}: table-level UPDATE granted, expected only listed columns`);
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
  for (const { s } of sequences) violations.push(`sequence ${s}: USAGE or UPDATE granted, expected none`);
  for (const { f } of definers) {
    violations.push(`function ${f}: SECURITY DEFINER, runs as its owner, expected none`);
  }
  for (const { r, t } of rules) violations.push(`rule ${r} on ${t}: runs as the table's owner when this login writes it`);
  for (const { r } of roles) violations.push(`role ${r}: this login is a member, expected only ${COLLAB_WRITER_ROLE}`);
  for (const { s } of schemas) violations.push(`schema ${s}: CREATE granted, expected none`);
  for (const row of attributes) {
    for (const [key, name] of ROLE_ATTRIBUTES) {
      if (row[key] === true) violations.push(`role ${row.role}: attribute ${name} set, expected none`);
    }
  }
  if (database?.createDb === true) violations.push(`database ${database.db}: CREATE granted, expected none`);
  return violations;
}
