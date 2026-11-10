// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Project instructions (#1400): one plain text per Project that every member's
 * Agent turn carries, read and written through `GET` / `PUT /chat/instructions`.
 *
 * Driven through the real app against a real database. What it pins:
 * - who may read and write: the Owner and Editors may, a Viewer is refused
 *   (403), a stranger is told the project does not exist (404), a signed-out
 *   caller is asked to sign in (401) — the answers `assertAccess(…, "editor")`
 *   gives every chat endpoint
 * - the stored row: one per project, text kept exactly as typed, the last save
 *   wins, an empty or whitespace-only text clears it (soft delete) and a later
 *   save brings it back
 * - the limit: 10000 characters, refused by the validator
 * - an archived project refuses it as it refuses opening chat there
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
    totalUsage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

import { agentInstructionsService } from "@server/modules";
import { getRateLimit } from "@server/config/rate-limits.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "agent-instructions-test" },
  });
  // Import the app AFTER initCore ran (app.js → cors.ts reads env at module
  // load; the dynamic import defers it past initCore above).
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** What `GET` and `PUT /chat/instructions` answer inside `data`. */
interface View {
  text: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** A signed-in user and the name the member list shows for them. */
interface Person {
  id: string;
  name: string;
  cookie: string;
}

/** A project with its owner. */
interface Scene {
  projectId: string;
  studioId: string;
  owner: Person;
}

/**
 * Give a user a session and the cookie that carries it.
 * @param userId - User to sign in.
 * @returns A Cookie header value `requireAuth` accepts.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Insert a signed-in user with a personal studio, whose name is the one the
 * project member list shows for them.
 * @returns The user.
 */
async function insertPerson(): Promise<Person> {
  const tag = `instr-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const name = `Person ${tag}`;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-me`}, 'personal', ${name})
  `;
  return { id: user!.id, name, cookie: await loginCookie(user!.id) };
}

/**
 * Seed a team studio and a project in it, owned by a fresh user.
 * @returns The project, its studio and its owner.
 */
async function seedProject(): Promise<Scene> {
  const tag = `instr-p-${seq++}`;
  const owner = await insertPerson();
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${owner.id}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${owner.id}, 'owner', null)
  `;
  return { projectId: project!.id, studioId: studio!.id, owner };
}

/**
 * Add a fresh user to the project with a role.
 * @param scene - The project to join.
 * @param role - Project role to hold.
 * @returns The new member.
 */
async function addMember(scene: Scene, role: "editor" | "viewer"): Promise<Person> {
  const member = await insertPerson();
  const studioRole = role === "editor" ? "maintainer" : "guest";
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${scene.studioId}, ${member.id}, ${studioRole})
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${scene.projectId}, ${member.id}, ${role}, ${scene.owner.id})
  `;
  return member;
}

/**
 * Read a project's instructions.
 * @param projectId - Project to read.
 * @param cookie - Session cookie, or undefined to arrive signed out.
 * @returns The raw response.
 */
async function getInstructions(projectId: string, cookie?: string): Promise<Response> {
  return app.request(`/api/v1/chat/instructions?project_id=${projectId}`, {
    method: "GET",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

/**
 * Save a project's instructions.
 * @param projectId - Project to write.
 * @param text - Instructions text, sent as is.
 * @param cookie - Session cookie, or undefined to arrive signed out.
 * @returns The raw response.
 */
async function putInstructions(projectId: string, text: string, cookie?: string): Promise<Response> {
  return app.request("/api/v1/chat/instructions", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ project_id: projectId, text }),
  });
}

/**
 * Read the `data` of a successful response.
 * @param res - A 200 response from either route.
 * @returns The instructions view.
 */
async function viewOf(res: Response): Promise<View> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: View }).data;
}

/** A stored row, deleted or not. */
interface Row {
  content: string;
  updated_by_user_id: string;
  updated_at: Date;
  deleted_at: Date | null;
}

/**
 * Every row stored for a project, soft-deleted ones included.
 * @param projectId - Project to look up.
 * @returns The rows.
 */
async function rowsOf(projectId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT content, updated_by_user_id, updated_at, deleted_at
    FROM project_agent_instructions WHERE project_id = ${projectId}
  `;
}

const EMPTY: View = { text: "", updatedBy: null, updatedAt: null };

describe("GET / PUT /chat/instructions — who may read and write", () => {
  it("lets the owner save and read the instructions", async () => {
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "Answer in English.", s.owner.cookie));
    const view = await viewOf(await getInstructions(s.projectId, s.owner.cookie));
    expect(view.text).toBe("Answer in English.");
  });

  it("lets an editor save and read the instructions", async () => {
    const s = await seedProject();
    const editor = await addMember(s, "editor");
    await viewOf(await putInstructions(s.projectId, "Warm colours only.", editor.cookie));
    const view = await viewOf(await getInstructions(s.projectId, editor.cookie));
    expect(view.text).toBe("Warm colours only.");
    expect(view.updatedBy).toBe(editor.name);
  });

  it("refuses a viewer with 403 on both, and writes nothing", async () => {
    const s = await seedProject();
    const viewer = await addMember(s, "viewer");
    await viewOf(await putInstructions(s.projectId, "owner's", s.owner.cookie));

    expect((await getInstructions(s.projectId, viewer.cookie)).status).toBe(403);
    expect((await putInstructions(s.projectId, "viewer's", viewer.cookie)).status).toBe(403);

    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("owner's");
  });

  it("answers a non-member with 404 on both, and writes nothing", async () => {
    // The owner's save comes first so a missing route (also 404) cannot pass
    // this case.
    const s = await seedProject();
    const stranger = await insertPerson();
    await viewOf(await putInstructions(s.projectId, "owner's", s.owner.cookie));

    expect((await getInstructions(s.projectId, stranger.cookie)).status).toBe(404);
    expect((await putInstructions(s.projectId, "stranger's", stranger.cookie)).status).toBe(404);
    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("owner's");
  });

  it("answers a signed-out caller with 401 on both", async () => {
    // `/chat/*` answers 401 before routing, so the owner's save first is what
    // proves the route exists.
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "owner's", s.owner.cookie));
    expect((await getInstructions(s.projectId)).status).toBe(401);
    expect((await putInstructions(s.projectId, "anyone's")).status).toBe(401);
    expect((await rowsOf(s.projectId))[0]!.content).toBe("owner's");
  });
});

describe("GET / PUT /chat/instructions — what is stored", () => {
  it("reads empty when nothing was ever saved", async () => {
    const s = await seedProject();
    expect(await viewOf(await getInstructions(s.projectId, s.owner.cookie))).toEqual(EMPTY);
  });

  it("keeps the text verbatim and says who saved it and when", async () => {
    const s = await seedProject();
    const text = "  \n  Always answer in English.\n\n  Keep it short.  \n";
    const before = Date.now();

    const saved = await viewOf(await putInstructions(s.projectId, text, s.owner.cookie));
    expect(saved.text).toBe(text);

    const read = await viewOf(await getInstructions(s.projectId, s.owner.cookie));
    expect(read.text).toBe(text);
    expect(read.updatedBy).toBe(s.owner.name);
    expect(read.updatedAt).not.toBeNull();
    expect(new Date(read.updatedAt!).toISOString()).toBe(read.updatedAt);
    expect(new Date(read.updatedAt!).getTime()).toBeGreaterThanOrEqual(before - 5_000);

    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(text);
    expect(rows[0]!.updated_by_user_id).toBe(s.owner.id);
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it("shows the email local part for an editor with no personal studio yet, as the member list does", async () => {
    const s = await seedProject();
    const editor = await addMember(s, "editor");
    await sql`DELETE FROM studios WHERE created_by_user_id = ${editor.id} AND type = 'personal'`;
    const [user] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${editor.id}`;

    await viewOf(await putInstructions(s.projectId, "x", editor.cookie));
    const view = await viewOf(await getInstructions(s.projectId, s.owner.cookie));
    expect(view.updatedBy).toBe(user!.email.split("@")[0]);
  });

  it("lets the last save win when two members save one after the other", async () => {
    const s = await seedProject();
    const editor = await addMember(s, "editor");

    await viewOf(await putInstructions(s.projectId, "first", s.owner.cookie));
    const first = await viewOf(await getInstructions(s.projectId, editor.cookie));
    await viewOf(await putInstructions(s.projectId, "second", editor.cookie));

    const view = await viewOf(await getInstructions(s.projectId, s.owner.cookie));
    expect(view.text).toBe("second");
    expect(view.updatedBy).toBe(editor.name);
    expect(new Date(view.updatedAt!).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt!).getTime());

    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updated_by_user_id).toBe(editor.id);
  });

  it("clears on a whitespace-only text, keeping the row soft-deleted", async () => {
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "something", s.owner.cookie));

    const cleared = await viewOf(await putInstructions(s.projectId, "  \n\t \n ", s.owner.cookie));
    expect(cleared).toEqual(EMPTY);
    expect(await viewOf(await getInstructions(s.projectId, s.owner.cookie))).toEqual(EMPTY);

    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeInstanceOf(Date);
  });

  it("clears on an empty text", async () => {
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "something", s.owner.cookie));
    expect(await viewOf(await putInstructions(s.projectId, "", s.owner.cookie))).toEqual(EMPTY);
    expect(await viewOf(await getInstructions(s.projectId, s.owner.cookie))).toEqual(EMPTY);
  });

  it("writes no row when clearing instructions that were never saved", async () => {
    const s = await seedProject();
    expect(await viewOf(await putInstructions(s.projectId, "   ", s.owner.cookie))).toEqual(EMPTY);
    expect(await rowsOf(s.projectId)).toHaveLength(0);
  });

  it("brings the instructions back on a save after a clear, in the same row", async () => {
    const s = await seedProject();
    const editor = await addMember(s, "editor");
    await viewOf(await putInstructions(s.projectId, "old", s.owner.cookie));
    await viewOf(await putInstructions(s.projectId, " ", s.owner.cookie));

    const restored = await viewOf(await putInstructions(s.projectId, "new", editor.cookie));
    expect(restored.text).toBe("new");
    expect(restored.updatedBy).toBe(editor.name);
    expect((await viewOf(await getInstructions(s.projectId, s.owner.cookie))).text).toBe("new");

    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeNull();
    expect(rows[0]!.content).toBe("new");
    expect(rows[0]!.updated_by_user_id).toBe(editor.id);
  });

  it("keeps one row per project however many saves and clears happen", async () => {
    const s = await seedProject();
    const editor = await addMember(s, "editor");
    for (const [text, who] of [
      ["a", s.owner],
      ["b", editor],
      ["", s.owner],
      ["c", editor],
    ] as const) {
      await viewOf(await putInstructions(s.projectId, text, who.cookie));
    }
    expect(await rowsOf(s.projectId)).toHaveLength(1);
  });

  it("never shows one project's instructions in another", async () => {
    const a = await seedProject();
    const b = await seedProject();
    await viewOf(await putInstructions(a.projectId, "only for A", a.owner.cookie));

    expect(await viewOf(await getInstructions(b.projectId, b.owner.cookie))).toEqual(EMPTY);
    expect(await rowsOf(b.projectId)).toHaveLength(0);
    expect(await agentInstructionsService.textFor(b.projectId)).toBeUndefined();
    expect(await agentInstructionsService.textFor(a.projectId)).toBe("only for A");
  });
});

describe("PUT /chat/instructions — the length limit", () => {
  it("saves exactly 10000 characters", async () => {
    const s = await seedProject();
    const text = "a".repeat(10_000);
    expect((await viewOf(await putInstructions(s.projectId, text, s.owner.cookie))).text).toBe(text);
  });

  it("refuses 10001 characters through the validator, and writes nothing", async () => {
    // `validate()` answers a value that does not satisfy its schema with 422
    // (`ValidationError`), the same answer every other route gives.
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "kept", s.owner.cookie));

    const res = await putInstructions(s.projectId, "a".repeat(10_001), s.owner.cookie);
    expect(res.status).toBe(422);

    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("kept");
  });

  it("refuses a project_id that is not a uuid", async () => {
    const s = await seedProject();
    expect((await getInstructions("not-a-uuid", s.owner.cookie)).status).toBe(422);
    expect((await putInstructions("not-a-uuid", "x", s.owner.cookie)).status).toBe(422);
  });
});

describe("PUT /chat/instructions — rate limit", () => {
  it("has its limit configured under agent-instructions", () => {
    expect(getRateLimit("agent-instructions").max).toBeGreaterThan(0);
  });

  it("answers 429 once a user goes past the configured number of saves", async () => {
    const s = await seedProject();
    const { max } = getRateLimit("agent-instructions");
    for (let i = 0; i < max; i++) {
      expect((await putInstructions(s.projectId, `save ${i}`, s.owner.cookie)).status).toBe(200);
    }
    expect((await putInstructions(s.projectId, "one too many", s.owner.cookie)).status).toBe(429);
  });
});

describe("on an archived project", () => {
  /**
   * Archive a project directly.
   * @param s - The project and the owner archiving it.
   */
  async function archive(s: Scene): Promise<void> {
    await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${s.owner.id} WHERE id = ${s.projectId}`;
  }

  /**
   * Restore an archived project directly.
   * @param s - The project to restore.
   */
  async function restore(s: Scene): Promise<void> {
    await sql`UPDATE projects SET archived_at = null, archived_by_user_id = null WHERE id = ${s.projectId}`;
  }

  it("refuses saving with 403, as opening chat there is refused, and keeps the saved text", async () => {
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "before archive", s.owner.cookie));
    await archive(s);

    const openChat = await app.request("/api/v1/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: s.owner.cookie },
      body: JSON.stringify({ project_id: s.projectId }),
    });
    expect(openChat.status).toBe(403);

    expect((await putInstructions(s.projectId, "after archive", s.owner.cookie)).status).toBe(openChat.status);
    const rows = await rowsOf(s.projectId);
    expect(rows[0]!.content).toBe("before archive");
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it("refuses reading with 403, as opening chat there is refused", async () => {
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "before archive", s.owner.cookie));
    await archive(s);
    expect((await getInstructions(s.projectId, s.owner.cookie)).status).toBe(403);
  });

  it("reads and saves again once the project is restored", async () => {
    const s = await seedProject();
    await viewOf(await putInstructions(s.projectId, "before archive", s.owner.cookie));
    await archive(s);
    await restore(s);

    expect((await viewOf(await getInstructions(s.projectId, s.owner.cookie))).text).toBe("before archive");
    expect((await viewOf(await putInstructions(s.projectId, "after restore", s.owner.cookie))).text).toBe(
      "after restore",
    );
  });
});

describe("agentInstructionsService", () => {
  it("textFor returns the saved text verbatim, without an access check", async () => {
    const s = await seedProject();
    const text = "  keep the spaces \n";
    await viewOf(await putInstructions(s.projectId, text, s.owner.cookie));
    expect(await agentInstructionsService.textFor(s.projectId)).toBe(text);
  });

  it("textFor returns undefined when nothing was saved and after a clear", async () => {
    const s = await seedProject();
    expect(await agentInstructionsService.textFor(s.projectId)).toBeUndefined();
    await viewOf(await putInstructions(s.projectId, "x", s.owner.cookie));
    await viewOf(await putInstructions(s.projectId, "\n \n", s.owner.cookie));
    expect(await agentInstructionsService.textFor(s.projectId)).toBeUndefined();
  });

  it("read and save check editor access the way the routes do", async () => {
    const s = await seedProject();
    const viewer = await addMember(s, "viewer");
    const stranger = await insertPerson();

    await expect(agentInstructionsService.save(s.projectId, viewer.id, "x")).rejects.toMatchObject({ statusCode: 403 });
    await expect(agentInstructionsService.read(s.projectId, viewer.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(agentInstructionsService.save(s.projectId, stranger.id, "x")).rejects.toMatchObject({ statusCode: 404 });
    await expect(agentInstructionsService.read(s.projectId, stranger.id)).rejects.toMatchObject({ statusCode: 404 });

    const saved = await agentInstructionsService.save(s.projectId, s.owner.id, " direct ");
    expect(saved.text).toBe(" direct ");
    expect(saved.updatedBy).toBe(s.owner.name);
    expect(await agentInstructionsService.read(s.projectId, s.owner.id)).toEqual(saved);
  });
});

describe("agent-instructions.repo", () => {
  it("upserts, clears and upserts again in one row", async () => {
    const repo = await import("@server/modules/conversation/agent-instructions.repo.js");
    const s = await seedProject();
    const editor = await addMember(s, "editor");

    expect(await repo.findActive(s.projectId)).toBeFalsy();
    await repo.upsert(s.projectId, s.owner.id, "one");
    expect(await repo.findActive(s.projectId)).toMatchObject({ content: "one" });

    await repo.clear(s.projectId);
    expect(await repo.findActive(s.projectId)).toBeFalsy();
    expect((await rowsOf(s.projectId))[0]!.deleted_at).toBeInstanceOf(Date);

    await repo.upsert(s.projectId, editor.id, "two");
    expect(await repo.findActive(s.projectId)).toMatchObject({ content: "two" });
    const rows = await rowsOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeNull();
    expect(rows[0]!.updated_by_user_id).toBe(editor.id);
  });
});
