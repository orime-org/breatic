// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Listing a project's conversations, a page at a time.
 *
 * A list with no second page is a list with a ceiling, and a ceiling nobody
 * declared: the reader sees the newest N and is told nothing about the rest.
 * So every answer here says whether anything comes after it, and the offset
 * that fetches what does is part of the contract rather than a default buried
 * in the repository.
 *
 * The project filter is checked here too. It travels as `project_id`, and a
 * caller that spells it any other way gets no filter at all -- which is not an
 * error, it is a list of every conversation the user has anywhere.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";

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

const PG_DRIVER_LOCAL = "conversation-paging-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 8,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Mint a real Redis session and return the authenticating Cookie header.
 * @param userId - The user to sign in.
 * @returns A `Cookie` header value carrying a live session token.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Seed a studio with two projects and an owner who is signed in.
 *
 * Two, because the filter cannot be tested with one: a list scoped to the only
 * project there is looks exactly like a list that was never scoped at all.
 * @returns Ids plus an authenticating Cookie header for the owner.
 */
async function seedTwoProjects(): Promise<{
  userId: string;
  projectId: string;
  otherProjectId: string;
  cookie: string;
}> {
  const tag = `cp-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  const made: string[] = [];
  for (const suffix of ["a", "b"]) {
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
      VALUES (${studio!.id}, ${user!.id}, ${`${tag}-${suffix}`}, ${`${tag}-${suffix}`}, 'private')
      RETURNING id
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${project!.id}, ${user!.id}, 'owner', null)
    `;
    made.push(project!.id);
  }
  return {
    userId: user!.id,
    projectId: made[0]!,
    otherProjectId: made[1]!,
    cookie: await loginCookie(user!.id),
  };
}

/**
 * Put conversations in a project, oldest first, one second apart.
 *
 * Spaced in time on purpose: the list is ordered by when each was last used,
 * and rows written in the same tick would come back in an order the database
 * is free to choose.
 * @param userId - Who owns them.
 * @param projectId - Where they live.
 * @param names - A title per conversation, oldest first.
 * @returns Their ids, in the same order as the names.
 */
async function seedConversations(
  userId: string,
  projectId: string,
  names: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, name] of names.entries()) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO conversations (user_id, title, project_id, updated_at)
      VALUES (${userId}, ${name}, ${projectId}, now() - ${`${names.length - i} seconds`}::interval)
      RETURNING id
    `;
    ids.push(row!.id);
  }
  return ids;
}

interface ListResponse {
  data: { conversations: Array<{ id: string; title: string | null }>; hasMore: boolean };
}

/**
 * Ask for one page of a project's conversations.
 * @param projectId - Project to scope to.
 * @param cookie - Authenticating cookie.
 * @param page - The window to ask for.
 * @param page.limit - How many rows.
 * @param page.offset - How many to skip.
 * @returns The parsed body.
 */
async function listPage(
  projectId: string,
  cookie: string,
  page: { limit: number; offset: number },
): Promise<ListResponse> {
  const query = `project_id=${projectId}&limit=${page.limit}&offset=${page.offset}`;
  const res = await app.request(`/api/v1/chat/conversations?${query}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ListResponse;
}

describe("a page of a project's conversations", () => {
  it("hands back exactly the window asked for, and says more follows", async () => {
    const { userId, projectId, cookie } = await seedTwoProjects();
    await seedConversations(userId, projectId, ["oldest", "middle", "newest"]);

    const first = await listPage(projectId, cookie, { limit: 2, offset: 0 });

    expect(first.data.conversations.map((c) => c.title)).toEqual(["newest", "middle"]);
    expect(first.data.hasMore).toBe(true);
  });

  it("continues where the last page stopped, and says nothing follows", async () => {
    const { userId, projectId, cookie } = await seedTwoProjects();
    await seedConversations(userId, projectId, ["oldest", "middle", "newest"]);

    const second = await listPage(projectId, cookie, { limit: 2, offset: 2 });

    expect(second.data.conversations.map((c) => c.title)).toEqual(["oldest"]);
    expect(second.data.hasMore).toBe(false);
  });

  it("counts what follows rather than guessing from a short page", async () => {
    // A page that came back full is not evidence there is more, and a page
    // that came back short is not evidence there is not: the only way to know
    // is to have looked one row past the end.
    const { userId, projectId, cookie } = await seedTwoProjects();
    await seedConversations(userId, projectId, ["one", "two"]);

    const exact = await listPage(projectId, cookie, { limit: 2, offset: 0 });

    expect(exact.data.conversations).toHaveLength(2);
    expect(exact.data.hasMore).toBe(false);
  });

  it("stays inside the project it was given", async () => {
    const { userId, projectId, otherProjectId, cookie } = await seedTwoProjects();
    await seedConversations(userId, projectId, ["here"]);
    await seedConversations(userId, otherProjectId, ["somewhere else"]);

    const page = await listPage(projectId, cookie, { limit: 50, offset: 0 });

    expect(page.data.conversations.map((c) => c.title)).toEqual(["here"]);
  });
});

describe("the first page, the one that arrives with the panel", () => {
  it("comes back with the answer about what follows it", async () => {
    const { userId, projectId, cookie } = await seedTwoProjects();
    // One more than a page holds, so there is something to say.
    await seedConversations(
      userId,
      projectId,
      Array.from({ length: 40 }, (_, i) => `c-${i}`),
    );

    const res = await app.request("/api/v1/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { conversations: unknown[]; hasMoreConversations: boolean };
    };

    expect(body.data.hasMoreConversations).toBe(true);
    expect(body.data.conversations.length).toBeLessThan(41);
  });
});
