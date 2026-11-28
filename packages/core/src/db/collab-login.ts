// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab's database login (inner#2043), made by the migration command after
 * the migrations ran: the login named in `COLLAB_DATABASE_URL` exists, has the
 * password written there and holds the role `collab_writer` the migrations
 * created, and nothing of its own. A role that already exists is changed only
 * when it is collab's: it holds `collab_writer`, has no administrative
 * attribute and is not the migrating account. After the grant the command
 * connects with the collab URL and makes sure it reached the same server and
 * database as `DATABASE_URL`. Identifiers and the password are quoted by
 * PostgreSQL (`format('%I')`, `format('%L')`), never pasted into SQL here, and
 * no error this throws carries the password.
 */

import type { Sql } from "postgres";
import { createPgClient } from "@core/db/client.js";
import { COLLAB_WRITER_ROLE } from "@core/db/collab-write-scope.js";

interface Where {
  db: string;
  started: string;
}

/**
 * Decode a user name or password from a URL the way postgres.js does: a value that is not valid percent-encoding is taken as written.
 * @param part - The URL's `username` or `password`.
 * @returns The decoded value.
 */
function decodeUrlPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Run one statement PostgreSQL builds from a `format()` template.
 * @param admin - The admin connection.
 * @param template - The `format()` template.
 * @param args - Its arguments, passed as parameters.
 * @returns Once the statement ran.
 * @throws {Error} When it fails; the message is PostgreSQL's, without the statement.
 */
async function runFormatted(admin: Sql, template: string, args: string[]): Promise<void> {
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(", ");
  const [row] = await admin.unsafe<{ stmt: string }[]>(`SELECT format($1, ${placeholders}) AS stmt`, [template, ...args]);
  try {
    await admin.unsafe(row!.stmt);
  } catch (err) {
    // The statement may hold the password; keep only PostgreSQL's message.
    throw new Error(`collab login: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Which database on which running server a connection reached.
 * @param sql - The connection.
 * @returns The database name and the server's start time.
 * @throws {Error} When the query fails.
 */
async function whereIs(sql: Sql): Promise<Where> {
  const [row] = await sql<Where[]>`SELECT current_database() AS db, pg_postmaster_start_time()::text AS started`;
  return row!;
}

/**
 * Make sure collab's login exists with the password in its URL and holds `collab_writer`.
 * @param adminUrl - The migrating account's URL (`DATABASE_URL`).
 * @param collabUrl - collab's URL (`COLLAB_DATABASE_URL`).
 * @returns The login's name.
 * @throws {Error} When the collab URL names no user or password, names the migrating account or a role that is not collab's, reaches another database, or the database refuses.
 */
export async function ensureCollabLogin(adminUrl: string, collabUrl: string): Promise<{ user: string }> {
  const collab = new URL(collabUrl);
  const user = decodeUrlPart(collab.username);
  const password = decodeUrlPart(collab.password);
  if (user === "" || password === "") throw new Error("COLLAB_DATABASE_URL must name a user and a password");
  const admin = createPgClient(adminUrl, { name: "collab-login", max: 1 });
  let adminWhere: Where;
  try {
    const [self] = await admin<{ current: string; session: string }[]>`
      SELECT current_user AS current, session_user AS session`;
    if (user === self!.current || user === self!.session) {
      throw new Error("COLLAB_DATABASE_URL must name its own login, not DATABASE_URL's account");
    }
    const [existing] = await admin<{ privileged: boolean; writer: boolean }[]>`
      SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls AS privileged,
        pg_has_role(oid, ${COLLAB_WRITER_ROLE}, 'MEMBER') AS writer
      FROM pg_roles WHERE rolname = ${user}`;
    if (existing !== undefined && (existing.privileged || !existing.writer)) {
      const why = existing.privileged ? "has an administrative attribute" : `does not hold ${COLLAB_WRITER_ROLE}`;
      throw new Error(`COLLAB_DATABASE_URL names the existing role ${user}, which ${why}; name a login of collab's own`);
    }
    await runFormatted(admin, `${existing === undefined ? "CREATE" : "ALTER"} ROLE %I LOGIN PASSWORD %L`, [user, password]);
    await runFormatted(admin, `GRANT ${COLLAB_WRITER_ROLE} TO %I`, [user]);
    adminWhere = await whereIs(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const probe = createPgClient(collabUrl, { name: "collab-login-check", max: 1 });
  try {
    const collabWhere = await whereIs(probe).catch((err: unknown) => {
      throw new Error(`collab login: cannot connect with COLLAB_DATABASE_URL: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (collabWhere.db !== adminWhere.db || collabWhere.started !== adminWhere.started) {
      throw new Error("COLLAB_DATABASE_URL reaches another database than DATABASE_URL; point both at the same server and database");
    }
  } finally {
    await probe.end({ timeout: 5 });
  }
  return { user };
}
