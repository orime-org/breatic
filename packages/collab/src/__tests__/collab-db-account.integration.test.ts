// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab's own database account (inner#2043).
 *
 * The migration creates the role `collab_writer`, which can read every product
 * table and write only what `COLLAB_WRITE_SCOPE` lists. The migration command
 * then makes sure collab's login exists with the password in its URL and holds
 * that role. collab checks at startup, with `checkWriteScope`, that its
 * connection can do exactly that much: a privilege too many or too few is
 * reported. Real database; every connection here is opened from an explicit
 * URL, the admin one from `inject("DATABASE_URL")`.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  COLLAB_WRITE_SCOPE, checkWriteScope, createTestDb, ensureCollabLogin, initCore, type CollabWriteScope,
} from "@breatic/core";

type Client = ReturnType<typeof createTestDb>["client"];

const ADMIN_URL = inject("DATABASE_URL");
let admin!: Client;
const opened: Client[] = [];
const madeRoles: string[] = [];

/**
 * The admin URL with another account's name and password.
 * @param user - The account.
 * @param password - Its password.
 * @returns The connection URL.
 */
function urlFor(user: string, password: string): string {
  const url = new URL(ADMIN_URL);
  url.username = user;
  url.password = encodeURIComponent(password);
  return url.toString();
}

/**
 * Open a one-connection client that the suite closes at the end.
 * @param url - The connection URL.
 * @returns The client.
 */
function connect(url: string): Client {
  const { client } = createTestDb(url, 1);
  opened.push(client);
  return client;
}

/**
 * A fresh login name, dropped when the suite ends.
 * @param prefix - What the login is for.
 * @returns The name.
 */
function freshRole(prefix: string): string {
  const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  madeRoles.push(name);
  return name;
}

/**
 * Whom the connection logs in as.
 * @param url - The connection URL.
 * @returns `current_user` on a new connection.
 */
async function loginOf(url: string): Promise<string> {
  const [row] = await connect(url)<{ u: string }[]>`SELECT current_user AS u`;
  return row!.u;
}

/**
 * A login that holds `collab_writer`, plus whatever the caller grants it directly.
 * @param extra - Extra statements, with `%I` standing for the login's name.
 * @returns The login's client.
 */
async function writerLogin(extra: string[] = []): Promise<Client> {
  const name = freshRole("scope_probe");
  await admin.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD 'probe-pw'`);
  await admin.unsafe(`GRANT collab_writer TO ${name}`);
  for (const statement of extra) await admin.unsafe(statement.replaceAll("%I", name));
  return connect(urlFor(name, "probe-pw"));
}

beforeAll(() => {
  initCore(process.env);
  admin = createTestDb(ADMIN_URL, 2).client;
});

afterAll(async () => {
  await Promise.allSettled(opened.map((c) => c.end({ timeout: 1 })));
  for (const name of madeRoles) {
    await admin.unsafe(`DROP OWNED BY ${name}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
  }
  await admin.end({ timeout: 1 });
});

describe("collab_writer role", () => {
  it("cannot log in", async () => {
    const [role] = await admin<{ login: boolean }[]>`SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = 'collab_writer'`;
    expect(role).toEqual({ login: false });
  });

  it("is granted SELECT on every product table, and table-level INSERT exactly where COLLAB_WRITE_SCOPE says", async () => {
    const tables = await admin<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
    const granted = await admin<{ t: string; p: string }[]>`
      SELECT c.relname AS t, a.privilege_type AS p
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.grantee = 'collab_writer'::regrole
      ORDER BY 1, 2`;
    const expected = tables.flatMap(({ t }) => [
      ...(COLLAB_WRITE_SCOPE[t]?.insert ? [{ t, p: "INSERT" }] : []),
      { t, p: "SELECT" },
    ]);
    expect(granted.map((r) => ({ ...r }))).toEqual(expected);
  });

  it("is granted column-level UPDATE on exactly the columns COLLAB_WRITE_SCOPE lists, and no other column privilege", async () => {
    const granted = await admin<{ t: string; c: string; p: string }[]>`
      SELECT c.relname AS t, att.attname AS c, a.privilege_type AS p
      FROM pg_attribute att
      JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(att.attacl) a
      WHERE n.nspname = 'public' AND a.grantee = 'collab_writer'::regrole
      ORDER BY 1, 2, 3`;
    const expected = Object.entries(COLLAB_WRITE_SCOPE)
      .flatMap(([t, scope]) => scope.update.map((c) => ({ t, c, p: "UPDATE" })))
      .sort((a, b) => (a.t + a.c).localeCompare(b.t + b.c));
    expect(granted.map((r) => ({ ...r }))).toEqual(expected);
  });

  it("names the four write targets the maintainer approved", () => {
    expect(COLLAB_WRITE_SCOPE).toEqual({
      project_activities: { insert: true, update: ["restored"] },
      account_activity_events: { insert: true, update: [] },
      project_edits: { insert: true, update: ["last_edited_at"] },
      projects: { insert: false, update: ["duplicate_completed_at"] },
    });
  });
});

describe("ensureCollabLogin", () => {
  it("creates the login with the URL's password, holding collab_writer and nothing of its own", async () => {
    const name = freshRole("collab_login");
    const url = urlFor(name, "first-pw");
    await ensureCollabLogin(ADMIN_URL, url);
    expect(await loginOf(url)).toBe(name);
    const [member] = await admin<{ m: boolean }[]>`SELECT pg_has_role(${name}, 'collab_writer', 'MEMBER') AS m`;
    expect(member).toEqual({ m: true });
    const own = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE a.grantee = ${name}::regrole`;
    expect(own).toEqual([{ n: 0 }]);
  });

  it("changes an existing login's password to the URL's, so the old one stops working", async () => {
    const name = freshRole("collab_login");
    await ensureCollabLogin(ADMIN_URL, urlFor(name, "old-pw"));
    await ensureCollabLogin(ADMIN_URL, urlFor(name, "new-pw"));
    expect(await loginOf(urlFor(name, "new-pw"))).toBe(name);
    await expect(loginOf(urlFor(name, "old-pw"))).rejects.toMatchObject({ code: "28P01" });
  });

  it("changes nothing when run again with the same URL", async () => {
    const name = freshRole("collab_login");
    const url = urlFor(name, "same-pw");
    await ensureCollabLogin(ADMIN_URL, url);
    await ensureCollabLogin(ADMIN_URL, url);
    expect(await loginOf(url)).toBe(name);
  });

  it("takes a password with quotes and dollar signs as it is", async () => {
    const name = freshRole("collab_login");
    const url = urlFor(name, `it's "$1" $$x`);
    await ensureCollabLogin(ADMIN_URL, url);
    expect(await loginOf(url)).toBe(name);
  });

  it("refuses a collab URL that names the admin account and leaves the admin password alone", async () => {
    const adminUser = new URL(ADMIN_URL).username;
    await expect(ensureCollabLogin(ADMIN_URL, urlFor(adminUser, "hijacked"))).rejects.toThrow();
    expect(await loginOf(ADMIN_URL)).toBe(adminUser);
  });
});

describe("checkWriteScope", () => {
  it("finds nothing wrong for a login that holds only collab_writer", async () => {
    expect(await checkWriteScope(COLLAB_WRITE_SCOPE, await writerLogin())).toEqual([]);
  });

  const extraGrants: [string, string, string][] = [
    ["a table-level write on a table outside the list", "GRANT INSERT ON users TO %I", "users"],
    ["a column UPDATE on a table outside the list", "GRANT UPDATE (name) ON studios TO %I", "studios"],
    ["INSERT on projects", "GRANT INSERT ON projects TO %I", "projects"],
    ["UPDATE on a projects column not in the list", "GRANT UPDATE (name) ON projects TO %I", "projects"],
    ["table-level UPDATE on a listed table", "GRANT UPDATE ON project_edits TO %I", "project_edits"],
    ["DELETE on a listed table", "GRANT DELETE ON project_activities TO %I", "project_activities"],
    ["TRUNCATE on a table outside the list", "GRANT TRUNCATE ON users TO %I", "users"],
  ];
  for (const [label, grant, table] of extraGrants) {
    it(`reports ${label}`, async () => {
      const violations = await checkWriteScope(COLLAB_WRITE_SCOPE, await writerLogin([grant]));
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.every((v) => v.includes(table))).toBe(true);
    });
  }

  it("reports a listed column the login cannot update", async () => {
    const narrower: CollabWriteScope = {
      ...COLLAB_WRITE_SCOPE,
      projects: { insert: false, update: ["duplicate_completed_at", "name"] },
    };
    const violations = await checkWriteScope(narrower, await writerLogin());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("projects");
    expect(violations[0]).toContain("name");
  });

  it("reports a listed table the login cannot insert into", async () => {
    const wider: CollabWriteScope = { ...COLLAB_WRITE_SCOPE, users: { insert: true, update: [] } };
    const violations = await checkWriteScope(wider, await writerLogin());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("users");
  });

  it("reports a table another role created that the login cannot read", async () => {
    const owner = freshRole("other_owner");
    const table = `stray_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN`);
    await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${owner}`);
    await admin.unsafe(`SET ROLE ${owner}; CREATE TABLE public.${table} (id uuid PRIMARY KEY); RESET ROLE`);
    try {
      const violations = await checkWriteScope(COLLAB_WRITE_SCOPE, await writerLogin());
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(table);
    } finally {
      await admin.unsafe(`DROP TABLE public.${table}`);
      await admin.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${owner}`);
    }
  });
});

describe("the suite's collab accounts", () => {
  it("logs collab code in as breatic_collab_test, holding collab_writer", async () => {
    const url = inject("COLLAB_DATABASE_URL");
    expect(await loginOf(url)).toBe("breatic_collab_test");
    const [member] = await admin<{ m: boolean }[]>`SELECT pg_has_role('breatic_collab_test', 'collab_writer', 'MEMBER') AS m`;
    expect(member).toEqual({ m: true });
  });

  it("logs deliberate out-of-scope probes in as breatic_collab_probe, holding collab_writer", async () => {
    const url = inject("COLLAB_PROBE_DATABASE_URL");
    expect(await loginOf(url)).toBe("breatic_collab_probe");
    const [member] = await admin<{ m: boolean }[]>`SELECT pg_has_role('breatic_collab_probe', 'collab_writer', 'MEMBER') AS m`;
    expect(member).toEqual({ m: true });
  });
});
