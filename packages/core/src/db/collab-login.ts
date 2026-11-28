// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab's database login (inner#2043), made by the migration command after
 * the migrations ran: the login named in `COLLAB_DATABASE_URL` exists, has the
 * password written there and holds the role `collab_writer` the migrations
 * created, and nothing of its own. A role that already exists is changed only
 * when it is collab's: it inherits `collab_writer`, no role it can switch to
 * has an administrative attribute, and it is neither the migrating account nor
 * `collab_writer` itself. The user name and password are the ones postgres.js
 * reads from the URL, so they match what collab logs in with. The password
 * reaches the database only as a SCRAM-SHA-256 verifier, as psql's
 * `\password` sends it, so no statement or server log carries it; the role
 * change and the grant commit together. After the grant the command connects
 * with the collab URL and makes sure it reached the same server and database
 * as `DATABASE_URL`. Identifiers and the verifier are quoted by PostgreSQL
 * (`format('%I')`, `format('%L')`), never pasted into SQL here.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { createPgClient } from "@core/db/client.js";
import { COLLAB_WRITER_ROLE } from "@core/db/collab-write-scope.js";

/** PostgreSQL's default SCRAM iteration count (`scram_iterations`). */
const SCRAM_ITERATIONS = 4096;

interface Where {
  db: string;
  started: string;
}

interface ExistingRole {
  privileged: boolean;
  writer: boolean;
  inherits: boolean;
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password, computed the way postgres.js proves the password at login.
 * @param password - The password.
 * @returns `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`.
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/**
 * Run one statement PostgreSQL builds from a `format()` template.
 * @param sql - The admin connection or transaction.
 * @param template - The `format()` template.
 * @param args - Its arguments, passed as parameters.
 * @returns Once the statement ran.
 * @throws {Error} When it fails, with PostgreSQL's message.
 */
async function runFormatted(sql: Sql | TransactionSql, template: string, args: string[]): Promise<void> {
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(", ");
  const [row] = await sql.unsafe<{ stmt: string }[]>(`SELECT format($1, ${placeholders}) AS stmt`, [template, ...args]);
  try {
    await sql.unsafe(row!.stmt);
  } catch (err) {
    throw new Error(`collab login: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Which database on which running server a connection reached.
 * @param sql - The connection.
 * @returns The database name and the server's start time in epoch seconds, which no session setting changes.
 * @throws {Error} When the query fails.
 */
async function whereIs(sql: Sql): Promise<Where> {
  const [row] = await sql<Where[]>`
    SELECT current_database() AS db, extract(epoch FROM pg_postmaster_start_time())::text AS started`;
  return row!;
}

/**
 * Why an existing role is not collab's to change, if it is not.
 * @param role - The role found under the URL's user name.
 * @returns The reason, or `null` when it is collab's.
 */
function notCollabs(role: ExistingRole): string | null {
  if (role.privileged) return "has an administrative attribute, or can switch to a role that has one";
  if (!role.writer) return `does not hold ${COLLAB_WRITER_ROLE}`;
  if (!role.inherits) return `does not inherit ${COLLAB_WRITER_ROLE}'s privileges (NOINHERIT)`;
  return null;
}

/**
 * Make sure collab's login exists with the password in its URL and holds `collab_writer`.
 * @param adminUrl - The migrating account's URL (`DATABASE_URL`).
 * @param collabUrl - collab's URL (`COLLAB_DATABASE_URL`).
 * @returns The login's name.
 * @throws {Error} When the collab URL names no user or password, names the migrating account, `collab_writer` or a role that is not collab's, reaches another database, or the database refuses.
 */
export async function ensureCollabLogin(adminUrl: string, collabUrl: string): Promise<{ user: string }> {
  const written = new URL(collabUrl);
  if (written.username === "" || written.password === "") throw new Error("COLLAB_DATABASE_URL must name a user and a password");
  const probe = createPgClient(collabUrl, { name: "collab-login-check", max: 1 });
  try {
    const { user, pass } = probe.options;
    if (typeof user !== "string" || typeof pass !== "string") throw new Error("COLLAB_DATABASE_URL must name a user and a password");
    if (user === COLLAB_WRITER_ROLE) {
      throw new Error(`COLLAB_DATABASE_URL must name a login of collab's own, not the role ${COLLAB_WRITER_ROLE}`);
    }
    const adminWhere = await grantLogin(adminUrl, user, pass);
    const collabWhere = await whereIs(probe).catch((err: unknown) => {
      throw new Error(`collab login: cannot connect with COLLAB_DATABASE_URL: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (collabWhere.db !== adminWhere.db || collabWhere.started !== adminWhere.started) {
      throw new Error("COLLAB_DATABASE_URL reaches another database than DATABASE_URL; point both at the same server and database");
    }
    return { user };
  } finally {
    await probe.end({ timeout: 5 });
  }
}

/**
 * Create or update the login and grant it `collab_writer` in one transaction on the admin connection.
 * @param adminUrl - The migrating account's URL.
 * @param user - The login's name.
 * @param password - Its password.
 * @returns Where the admin connection is.
 * @throws {Error} When the login names the admin account or a role that is not collab's, or the database refuses.
 */
async function grantLogin(adminUrl: string, user: string, password: string): Promise<Where> {
  const admin = createPgClient(adminUrl, { name: "collab-login", max: 1 });
  try {
    const [self] = await admin<{ current: string; session: string }[]>`
      SELECT current_user AS current, session_user AS session`;
    if (user === self!.current || user === self!.session) {
      throw new Error("COLLAB_DATABASE_URL must name its own login, not DATABASE_URL's account");
    }
    const [existing] = await admin<ExistingRole[]>`
      SELECT EXISTS (
          SELECT 1 FROM pg_roles r WHERE pg_has_role(t.oid, r.oid, 'MEMBER')
            AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
        ) AS privileged,
        pg_has_role(t.oid, ${COLLAB_WRITER_ROLE}, 'MEMBER') AS writer,
        pg_has_role(t.oid, ${COLLAB_WRITER_ROLE}, 'USAGE') AS inherits
      FROM pg_roles t WHERE t.rolname = ${user}`;
    const why = existing === undefined ? null : notCollabs(existing);
    if (why !== null) throw new Error(`COLLAB_DATABASE_URL names the existing role ${user}, which ${why}; name a login of collab's own`);
    await admin.begin(async (tx) => {
      await runFormatted(tx, `${existing === undefined ? "CREATE" : "ALTER"} ROLE %I LOGIN PASSWORD %L`, [user, scramVerifier(password)]);
      await runFormatted(tx, `GRANT ${COLLAB_WRITER_ROLE} TO %I`, [user]);
    });
    return await whereIs(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
