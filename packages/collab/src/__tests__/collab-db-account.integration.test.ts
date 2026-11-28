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

  it("reports the login it made", async () => {
    const name = freshRole("collab_login");
    expect(await ensureCollabLogin(ADMIN_URL, urlFor(name, "named-pw"))).toEqual({ user: name });
  });

  it("takes a password holding a lone percent sign as written, as the driver does", async () => {
    const name = freshRole("collab_login");
    const url = new URL(ADMIN_URL);
    const raw = `${url.protocol}//${name}:50%off@${url.host}${url.pathname}`;
    await ensureCollabLogin(ADMIN_URL, raw);
    expect(await loginOf(raw)).toBe(name);
  });

  const existing: [string, string][] = [
    ["a superuser", "SUPERUSER"],
    ["a role that can create roles", "CREATEROLE"],
    ["a role that bypasses row security", "BYPASSRLS"],
    ["a plain login that is not collab's", ""],
  ];
  for (const [label, attribute] of existing) {
    it(`refuses an existing role that is ${label} and keeps its password`, async () => {
      const name = freshRole("other_login");
      await admin.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD 'kept-pw' ${attribute}`);
      await expect(ensureCollabLogin(ADMIN_URL, urlFor(name, "taken-pw"))).rejects.toThrow("COLLAB_DATABASE_URL");
      expect(await loginOf(urlFor(name, "kept-pw"))).toBe(name);
    });
  }

  it("refuses a collab URL that reaches another database than DATABASE_URL", async () => {
    const name = freshRole("collab_login");
    const other = `other_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await admin.unsafe(`CREATE DATABASE ${other}`);
    try {
      const url = new URL(urlFor(name, "elsewhere-pw"));
      url.pathname = `/${other}`;
      await expect(ensureCollabLogin(ADMIN_URL, url.toString())).rejects.toThrow("COLLAB_DATABASE_URL");
    } finally {
      await admin.unsafe(`DROP DATABASE ${other} WITH (FORCE)`);
    }
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

  /**
   * Run statements as the admin, check a plain writer login, then undo them.
   * @param setup - Statements creating the objects, with `%I` for the login.
   * @param teardown - Statements dropping them.
   * @returns The violations found while they existed.
   */
  async function violationsWith(setup: string[], teardown: string[]): Promise<string[]> {
    const name = freshRole("scope_probe");
    await admin.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD 'probe-pw'`);
    await admin.unsafe(`GRANT collab_writer TO ${name}`);
    try {
      for (const statement of setup) await admin.unsafe(statement.replaceAll("%I", name));
      return await checkWriteScope(COLLAB_WRITE_SCOPE, connect(urlFor(name, "probe-pw")));
    } finally {
      for (const statement of teardown) await admin.unsafe(statement);
    }
  }

  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const escapes: [string, string[], string[], string][] = [
    ["UPDATE on a view over a product table",
      [`CREATE VIEW public.v_${tag} AS SELECT id, email FROM users`, `GRANT UPDATE ON public.v_${tag} TO %I`],
      [`DROP VIEW IF EXISTS public.v_${tag}`], `v_${tag}`],
    ["INSERT on a table in another schema",
      [`CREATE SCHEMA side_${tag}`, `CREATE TABLE side_${tag}.t (id int)`, `GRANT USAGE ON SCHEMA side_${tag} TO %I`,
        `GRANT INSERT ON side_${tag}.t TO %I`],
      [`DROP SCHEMA IF EXISTS side_${tag} CASCADE`], `side_${tag}`],
    ["UPDATE on a sequence",
      [`CREATE SEQUENCE public.seq_${tag}`, `GRANT UPDATE ON SEQUENCE public.seq_${tag} TO %I`],
      [`DROP SEQUENCE IF EXISTS public.seq_${tag}`], `seq_${tag}`],
    ["a SECURITY DEFINER function it can execute",
      [`CREATE FUNCTION public.fn_${tag}() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`],
      [`DROP FUNCTION IF EXISTS public.fn_${tag}()`], `fn_${tag}`],
    ["a SECURITY DEFINER trigger on a table it writes",
      [`CREATE FUNCTION public.tg_${tag}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN NEW; END'`,
        `REVOKE EXECUTE ON FUNCTION public.tg_${tag}() FROM PUBLIC`,
        `CREATE TRIGGER tr_${tag} BEFORE INSERT ON project_edits FOR EACH ROW EXECUTE FUNCTION public.tg_${tag}()`],
      [`DROP TRIGGER IF EXISTS tr_${tag} ON project_edits`, `DROP FUNCTION IF EXISTS public.tg_${tag}()`], `tg_${tag}`],
    ["a rule on a table it writes",
      [`CREATE RULE ru_${tag} AS ON INSERT TO project_edits DO ALSO NOTIFY ru_${tag}`],
      [`DROP RULE IF EXISTS ru_${tag} ON project_edits`], `ru_${tag}`],
    ["a role it can switch to",
      [`CREATE ROLE side_role_${tag} NOLOGIN`, `GRANT side_role_${tag} TO %I WITH INHERIT FALSE`],
      [`DROP ROLE IF EXISTS side_role_${tag}`], `side_role_${tag}`],
    ["the CREATEROLE attribute", ["ALTER ROLE %I CREATEROLE"], [], "CREATEROLE"],
    ["CREATE on the public schema", ["GRANT CREATE ON SCHEMA public TO %I"], [], "public"],
  ];
  for (const [label, setup, teardown, named] of escapes) {
    it(`reports ${label}`, async () => {
      const violations = await violationsWith(setup, teardown);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.every((v) => v.includes(named))).toBe(true);
    });
  }

  it("reports CREATE on the database", async () => {
    const [row] = await admin<{ db: string }[]>`SELECT current_database() AS db`;
    const violations = await violationsWith([`GRANT CREATE ON DATABASE "${row!.db}" TO %I`], []);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.includes(row!.db))).toBe(true);
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
