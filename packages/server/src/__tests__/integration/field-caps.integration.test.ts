// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Field caps at the routes that write them (inner#1006 §6): F02, F04, F07,
 * F09 and the route half of F10.
 *
 * A value one past its cap is refused with the existing validation answer
 * (422, `server.error.validation`, no `error.reason`, since `too_big` judges a
 * value rather than the request's structure) and nothing is written. The
 * schema halves of these cases are in `packages/shared`.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
import type { Hono } from "hono";
import { getRedis, initCore, loadLocales, runWithLocale, sessionCookieName, setSession } from "@breatic/core";
import { t } from "@breatic/shared";
import { withPeer } from "../helpers/peer.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "field-caps-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** The validation answer, in English. */
function refused(): { error: { code: number; message: string } } {
  return { error: { code: 422, message: runWithLocale("en", () => t("server.error.validation")) } };
}

/**
 * A mailbox of exactly `length` characters (from 254 up), shaped like F01's.
 * @param length - The total length.
 * @returns The address.
 */
function mailbox(length: number): string {
  // "u"x64 "@" "a"x63 "." "b"x63 "." "c"xN ".com" = 197 + N characters.
  const address = `${"u".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(length - 197)}.com`;
  expect(address).toHaveLength(length);
  return address;
}

/** A signed-in owner of a project, with a conversation in it. */
interface Seeded {
  userId: string;
  studioId: string;
  projectId: string;
  conversationId: string;
  cookie: string;
}

/**
 * Seed an owner, signed in.
 * @returns The ids and the session cookie.
 */
async function seedOwner(): Promise<Seeded> {
  seq += 1;
  const tag = `fcap-${Date.now().toString(36)}-${seq}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`${tag}-s`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${userId}, ${`P ${tag}`}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${userId}, 'owner', null)
  `;
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, title, project_id) VALUES (${userId}, 'seeded', ${project!.id}) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId: studio!.id,
    projectId: project!.id,
    conversationId: conversation!.id,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * POST JSON to the app.
 * @param path - The route.
 * @param body - The body.
 * @param headers - Extra headers.
 * @returns The response.
 */
function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("F02: register refuses a mailbox past 254 characters", () => {
  it("a well-formed 256-character address is the validation answer and makes no account", async () => {
    const email = mailbox(256);

    // Register is rate limited by client address, which needs a connection.
    const res = await withPeer(app).request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password-123" }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused());
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email = ${email}`;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("F04: project create refuses a description past 2000 characters", () => {
  it("2001 characters is the validation answer and makes no project", async () => {
    const a = await seedOwner();

    const res = await post(
      "/api/v1/projects",
      { studioId: a.studioId, name: "Long description", slug: `fcap-long-${Date.now()}`, description: "d".repeat(2001) },
      { Cookie: a.cookie, "Idempotency-Key": crypto.randomUUID() },
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused());
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM projects WHERE studio_id = ${a.studioId}`;
    // Only the seeded project.
    expect(rows[0]!.n).toBe(1);
  });
});

describe("F07: canvas tasks refuse a task_type past 50 and a model past 100 characters", () => {
  it.each([
    ["task_type of 51", { task_type: "i".repeat(51), model: "test-model" }],
    ["model of 101", { task_type: "image", model: "m".repeat(101) }],
  ])("%s is the validation answer and writes no task", async (_name, fields) => {
    const a = await seedOwner();

    const res = await post(
      "/api/v1/canvas/tasks",
      {
        ...fields,
        params: { prompt: "a cat" },
        source: "task",
        project_id: a.projectId,
        space_id: crypto.randomUUID(),
        mode: "append",
      },
      { Cookie: a.cookie, "Idempotency-Key": crypto.randomUUID() },
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused());
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tasks WHERE project_id = ${a.projectId}`;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("F09: chat refuses an attachment name past 255 characters", () => {
  it("a 256-character name is the validation answer and writes no message", async () => {
    const a = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "hello",
        project_id: a.projectId,
        conversation_id: a.conversationId,
        attached_chips: [{ id: "node-1", type: "text", name: "n".repeat(256), data_snapshot: { text: "x" } }],
      },
      { Cookie: a.cookie },
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused());
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${a.conversationId}
    `;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("F10: caps that already hold stay where they are", () => {
  it("PATCH /projects/:id still takes 2000 characters of description and refuses 2001", async () => {
    const a = await seedOwner();
    /**
     * Send a description update.
     * @param description - The new description.
     * @returns The response.
     */
    const patch = (description: string): Promise<Response> =>
      Promise.resolve(
        app.request(`/api/v1/projects/${a.projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: a.cookie },
          body: JSON.stringify({ description }),
        }),
      );

    const atCap = await patch("d".repeat(2000));
    expect(atCap.status).toBe(200);
    const over = await patch("e".repeat(2001));
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual(refused());
    const rows = await sql<{ description: string }[]>`SELECT description FROM projects WHERE id = ${a.projectId}`;
    expect(rows[0]!.description).toBe("d".repeat(2000));
  });

  it("an account whose address is 254 characters can still be invited to a project", async () => {
    const a = await seedOwner();
    const email = mailbox(254);
    await sql`INSERT INTO users (email, email_verified) VALUES (${email}, true)`;

    const res = await post(`/api/v1/projects/${a.projectId}/invitations`, { email, role: "editor" }, { Cookie: a.cookie });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { ok: true, pendingSignup: false } });
  });
});
