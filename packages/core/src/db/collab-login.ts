// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab's database login (inner#2043), made by the migration command after
 * the migrations ran: the login named in `COLLAB_DATABASE_URL` exists, has the
 * password written there and holds the role `collab_writer` the migrations
 * created, and nothing of its own. Identifiers and the password are quoted by
 * PostgreSQL (`format('%I')`, `format('%L')`), never pasted into SQL here, and
 * no error this throws carries the password.
 */

import type { Sql } from "postgres";
import { createPgClient } from "@core/db/client.js";

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
 * Make sure collab's login exists with the password in its URL and holds `collab_writer`.
 * @param adminUrl - The migrating account's URL (`DATABASE_URL`).
 * @param collabUrl - collab's URL (`COLLAB_DATABASE_URL`).
 * @returns Once the login is in place.
 * @throws {Error} When the collab URL names no user or password, names the admin account, or the database refuses.
 */
export async function ensureCollabLogin(adminUrl: string, collabUrl: string): Promise<void> {
  const collab = new URL(collabUrl);
  const user = decodeURIComponent(collab.username);
  const password = decodeURIComponent(collab.password);
  if (user === "" || password === "") throw new Error("COLLAB_DATABASE_URL must name a user and a password");
  if (user === decodeURIComponent(new URL(adminUrl).username)) {
    throw new Error("COLLAB_DATABASE_URL must name its own login, not DATABASE_URL's account");
  }
  const admin = createPgClient(adminUrl, { name: "collab-login", max: 1 });
  try {
    const existing = await admin<{ one: number }[]>`SELECT 1 AS one FROM pg_roles WHERE rolname = ${user}`;
    const verb = existing.length === 0 ? "CREATE" : "ALTER";
    await runFormatted(admin, `${verb} ROLE %I LOGIN PASSWORD %L`, [user, password]);
    await runFormatted(admin, "GRANT collab_writer TO %I", [user]);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
