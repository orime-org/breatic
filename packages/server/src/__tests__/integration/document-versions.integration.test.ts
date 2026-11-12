// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Document snapshots over HTTP (inner#1129 A1, A2, A7, A8, A11, A12, A14).
 *
 * Driven through the real app, database and Redis: who may save, list, read,
 * rename and delete; that another project's or another document's snapshot
 * answers 404; the per-document ceiling under concurrent saves; cursor paging;
 * soft delete.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { getDocumentVersionLimits } from "@server/config/limits.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: "document-versions-test-driver" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

interface Member { userId: string; cookie: string }
interface Fixture { owner: Member; editor: Member; viewer: Member; projectId: string; spaceId: string }

const BODY = { type: "doc", content: [{ type: "blockGroup", content: [] }] };

async function sessionFor(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

async function seedUser(): Promise<Member & { studioId: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`dv-${crypto.randomUUID()}@example.test`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`dv-s-${crypto.randomBytes(8).toString("hex")}`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  return { userId: user!.id, studioId: studio!.id, cookie: await sessionFor(user!.id) };
}

async function seedProject(): Promise<Fixture> {
  const owner = await seedUser();
  const slug = `dv-p-${crypto.randomBytes(8).toString("hex")}`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, initial_space_type)
    VALUES (${owner.studioId}, ${owner.userId}, ${slug}, ${slug}, 'document') RETURNING id
  `;
  const projectId = project!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${owner.userId}, 'owner', null)`;
  const editor = await seedUser();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${editor.userId}, 'editor', ${owner.userId})`;
  const viewer = await seedUser();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${viewer.userId}, 'viewer', ${owner.userId})`;
  return { owner, editor, viewer, projectId, spaceId: crypto.randomUUID() };
}

async function call(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return await app.request(`/api/v1/documents/versions${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const scope = (fx: Fixture): string => `project_id=${fx.projectId}&space_id=${fx.spaceId}`;

async function save(fx: Fixture, who: Member, name?: string): Promise<Response> {
  return call("POST", "", who.cookie, { project_id: fx.projectId, space_id: fx.spaceId, content: BODY, schema_version: "v-test", ...(name ? { name } : {}) });
}

async function saved(fx: Fixture, name?: string): Promise<{ id: string }> {
  const res = await save(fx, fx.editor, name);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { data: { version: { id: string } } }).data.version;
}

describe("saving a snapshot (A1, A7)", () => {
  it("lets an editor save, named or not, and records who saved it", async () => {
    const fx = await seedProject();
    const res = await save(fx, fx.editor, "  First draft  ");
    expect(res.status).toBe(201);
    const { version } = ((await res.json()) as { data: { version: { id: string; name: string | null; createdBy: { id: string } } } }).data;
    expect(version.name).toBe("First draft");
    expect(version.createdBy.id).toBe(fx.editor.userId);
    const unnamed = await saved(fx);
    expect(unnamed.id).toBeTruthy();
  });

  it("refuses a viewer with 403 and a stranger with 404", async () => {
    const fx = await seedProject();
    expect((await save(fx, fx.viewer)).status).toBe(403);
    const stranger = await seedUser();
    expect((await save(fx, stranger)).status).toBe(404);
  });

  it("refuses every write once the project is archived", async () => {
    const fx = await seedProject();
    const v = await saved(fx);
    await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${fx.owner.userId} WHERE id = ${fx.projectId}`;
    expect((await save(fx, fx.editor)).status).toBe(403);
    expect((await call("PATCH", `/${v.id}`, fx.editor.cookie, { project_id: fx.projectId, space_id: fx.spaceId, name: "x" })).status).toBe(403);
    expect((await call("DELETE", `/${v.id}?${scope(fx)}`, fx.editor.cookie)).status).toBe(403);
    expect((await call("GET", `?${scope(fx)}`, fx.editor.cookie)).status).toBe(200);
  });
});

describe("the per-document ceiling (A8)", () => {
  it("answers 409 with the reason and the limit once the document is full", async () => {
    const fx = await seedProject();
    const { maxPerSpace } = getDocumentVersionLimits();
    await sql`
      INSERT INTO document_versions (project_id, space_id, created_by_user_id, content, schema_version, content_bytes)
      SELECT ${fx.projectId}, ${fx.spaceId}, ${fx.editor.userId}, ${sql.json(BODY)}, 'v-test', 10 FROM generate_series(1, ${maxPerSpace})
    `;
    const res = await save(fx, fx.editor);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { reason: string; message: string } };
    expect(body.error.reason).toBe("document_versions_full");
    expect(body.error.message).toContain(String(maxPerSpace));
  });

  it("lets only one of two saves through when one slot is left", async () => {
    const fx = await seedProject();
    const { maxPerSpace } = getDocumentVersionLimits();
    await sql`
      INSERT INTO document_versions (project_id, space_id, created_by_user_id, content, schema_version, content_bytes)
      SELECT ${fx.projectId}, ${fx.spaceId}, ${fx.editor.userId}, ${sql.json(BODY)}, 'v-test', 10 FROM generate_series(1, ${maxPerSpace - 1})
    `;
    const codes = (await Promise.all([save(fx, fx.editor), save(fx, fx.editor)])).map((r) => r.status).sort();
    expect(codes).toEqual([201, 409]);
  });

  it("counts deleted snapshots out and other documents out", async () => {
    const fx = await seedProject();
    const { maxPerSpace } = getDocumentVersionLimits();
    await sql`
      INSERT INTO document_versions (project_id, space_id, created_by_user_id, content, schema_version, content_bytes, deleted_at)
      SELECT ${fx.projectId}, ${fx.spaceId}, ${fx.editor.userId}, ${sql.json(BODY)}, 'v-test', 10, now() FROM generate_series(1, ${maxPerSpace})
    `;
    await sql`
      INSERT INTO document_versions (project_id, space_id, created_by_user_id, content, schema_version, content_bytes)
      SELECT ${fx.projectId}, ${crypto.randomUUID()}, ${fx.editor.userId}, ${sql.json(BODY)}, 'v-test', 10 FROM generate_series(1, ${maxPerSpace})
    `;
    expect((await save(fx, fx.editor)).status).toBe(201);
  });
});

describe("listing and reading (A2, A3, A7)", () => {
  it("lets a viewer list newest first, without content, with the saver, page by page with no gaps or repeats", async () => {
    const fx = await seedProject();
    const { pageSize } = getDocumentVersionLimits();
    const made: string[] = [];
    for (let i = 0; i < pageSize + 3; i++) made.push((await saved(fx, `v${i}`)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call("GET", `?${scope(fx)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, fx.viewer.cookie);
      expect(res.status).toBe(200);
      const page = ((await res.json()) as { data: { versions: Array<{ id: string; createdBy: { id: string } } & Record<string, unknown>>; nextCursor: string | null } }).data;
      for (const v of page.versions) {
        expect(v).not.toHaveProperty("content");
        expect(v.createdBy.id).toBe(fx.editor.userId);
        seen.push(v.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...made].reverse());
  });

  it("returns the content to a viewer", async () => {
    const fx = await seedProject();
    const v = await saved(fx);
    const res = await call("GET", `/${v.id}?${scope(fx)}`, fx.viewer.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { content: unknown } }).data.content).toEqual(BODY);
  });

  it("answers 404 for another project's or another document's snapshot (A7, A14)", async () => {
    const a = await seedProject();
    const b = await seedProject();
    const v = await saved(a);
    expect((await call("GET", `/${v.id}?${scope(b)}`, b.editor.cookie)).status).toBe(404);
    expect((await call("GET", `/${v.id}?project_id=${a.projectId}&space_id=${crypto.randomUUID()}`, a.editor.cookie)).status).toBe(404);
    expect((await call("PATCH", `/${v.id}`, b.editor.cookie, { project_id: b.projectId, space_id: b.spaceId, name: "x" })).status).toBe(404);
    expect((await call("DELETE", `/${v.id}?${scope(b)}`, b.editor.cookie)).status).toBe(404);
    expect((await call("GET", `/${v.id}?${scope(a)}`, a.editor.cookie)).status).toBe(200);
  });
});

describe("renaming and deleting (A11, A12, A14)", () => {
  it("lets an editor rename and clear the name, and refuses a viewer", async () => {
    const fx = await seedProject();
    const v = await saved(fx, "Old");
    const body = { project_id: fx.projectId, space_id: fx.spaceId };
    expect((await call("PATCH", `/${v.id}`, fx.viewer.cookie, { ...body, name: "x" })).status).toBe(403);
    expect((await call("PATCH", `/${v.id}`, fx.editor.cookie, { ...body, name: "New" })).status).toBe(200);
    expect((await call("PATCH", `/${v.id}`, fx.editor.cookie, { ...body, name: null })).status).toBe(200);
    const [row] = await sql<{ name: string | null }[]>`SELECT name FROM document_versions WHERE id = ${v.id}`;
    expect(row!.name).toBeNull();
  });

  it("soft-deletes for an editor: gone from the list, 404 after, the row kept", async () => {
    const fx = await seedProject();
    const v = await saved(fx);
    expect((await call("DELETE", `/${v.id}?${scope(fx)}`, fx.viewer.cookie)).status).toBe(403);
    expect((await call("DELETE", `/${v.id}?${scope(fx)}`, fx.editor.cookie)).status).toBe(200);
    expect((await call("DELETE", `/${v.id}?${scope(fx)}`, fx.editor.cookie)).status).toBe(404);
    expect((await call("GET", `/${v.id}?${scope(fx)}`, fx.editor.cookie)).status).toBe(404);
    const list = ((await (await call("GET", `?${scope(fx)}`, fx.editor.cookie)).json()) as { data: { versions: unknown[] } }).data.versions;
    expect(list).toHaveLength(0);
    const [row] = await sql<{ deleted_by_user_id: string }[]>`SELECT deleted_by_user_id FROM document_versions WHERE id = ${v.id} AND deleted_at IS NOT NULL`;
    expect(row!.deleted_by_user_id).toBe(fx.editor.userId);
  });
});
