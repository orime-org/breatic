// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Opening chat in a project: `POST /chat/open`.
 *
 * Acceptance items 1, 11 and 60. This one request is everything the panel needs
 * to render — the user's conversations in this project, plus the messages of
 * whichever one they used last — and it is the only place a conversation is
 * created automatically. The client holds the conversation id from here on and
 * sends it with every message, which is what lets two tabs sit on two different
 * conversations without either one landing a message in the other.
 *
 * It is a POST because it creates. Judging it by write access rather than read
 * access matters for the same reason: a view-only member must not be able to
 * leave a conversation behind in a project they may only look at.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed so this suite needs no API key and makes no provider
// request. Without the stub, CI — which sets no key anywhere — would get an
// AI_LoadAPIKeyError delivered as an `error` stream part: the stream still
// ends cleanly and every assertion still passes, so the suite would quietly
// stop covering what it appears to cover. A machine that does have a key
// would issue a real request instead.
//
// This suite is one that does call a model: the three POSTs to /chat/message
// below each run `agent.chat()`, which reaches `streamText`. So the stub here
// is load-bearing, and nothing but this comment says so — every assertion
// passes with or without it.
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
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import type { Hono } from "hono";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const PG_DRIVER_LOCAL = "chat-open-test-driver";

type OpenResponse = {
  data: {
    conversations: Array<{ id: string; title: string }>;
    current: {
      conversation: { id: string } | null;
      messages: Array<{ role: string; content: string }>;
    };
  };
};

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
 * Seed a studio with a project and an owner who is signed in.
 * @returns Ids plus an authenticating Cookie header for the owner.
 */
async function seedProject(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}> {
  const tag = `co-${seq++}`;
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
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'private') RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  await sql`
    INSERT INTO credit_balances (user_id, balance) VALUES (${user!.id}, 100000)
    ON CONFLICT (user_id) DO UPDATE SET balance = 100000
  `;
  return {
    userId: user!.id,
    studioId: studio!.id,
    projectId: project!.id,
    cookie: await loginCookie(user!.id),
  };
}

/**
 * Insert a registered user with no memberships anywhere.
 * @returns The new user's id.
 */
async function insertOutsider(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`co-out-${seq++}@example.com`}, true) RETURNING id
  `;
  return user!.id;
}

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
 * Call the open endpoint.
 * @param projectId - Project to open chat in.
 * @param cookie - Caller's session cookie.
 * @returns The raw response, for callers that assert on status.
 */
async function open(projectId: string, cookie: string): Promise<Response> {
  return app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ project_id: projectId }),
  });
}

/**
 * Count conversations attached to a project, deleted ones included.
 * @param projectId - Project to count against.
 * @returns The row count.
 */
async function conversationCount(projectId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM conversations WHERE project_id = ${projectId}
  `;
  return Number(rows[0]!.n);
}

describe("POST /chat/open — creating on first entry", () => {
  it("creates one conversation in a project that has none, and returns it", async () => {
    const { projectId, cookie } = await seedProject();
    expect(await conversationCount(projectId)).toBe(0);

    const res = await open(projectId, cookie);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as OpenResponse;

    expect(await conversationCount(projectId)).toBe(1);
    expect(payload.data.current.conversation).not.toBeNull();
    expect(payload.data.current.messages).toEqual([]);
    expect(payload.data.conversations).toHaveLength(1);
    expect(payload.data.conversations[0]!.id).toBe(payload.data.current.conversation!.id);
  });

  it("does not create a second one when opened again", async () => {
    const { projectId, cookie } = await seedProject();

    const first = (await (await open(projectId, cookie)).json()) as OpenResponse;
    const second = (await (await open(projectId, cookie)).json()) as OpenResponse;

    expect(await conversationCount(projectId)).toBe(1);
    expect(second.data.current.conversation!.id).toBe(first.data.current.conversation!.id);
  });

  it("creates one, not two, when two tabs open the same empty project at once", async () => {
    const { projectId, cookie } = await seedProject();

    // Reading the list and creating when it is empty has a gap between the two
    // steps. Two tabs arriving together both see nothing and both create,
    // leaving the user looking at a list with two empty conversations in it.
    //
    // Firing both with Promise.all does not reproduce that: the pool hands the
    // second request the connection the first just gave back, so they run one
    // after the other and the test passes with no lock at all — measured, both
    // locks removed and this test stayed green. So the interleaving is built
    // here instead. A gate holds the project row, which is what the creating
    // branch reaches for last:
    //
    //   tab A  takes the advisory lock, finds nothing, parks on the project row
    //   tab B  parks on the advisory lock A is holding
    //
    // Each lock therefore has its own observation: without the project lock A
    // never parks, without the advisory lock B parks on the project row rather
    // than on an advisory lock, and either way a probe below goes unanswered.
    let announceHeld: () => void = () => {};
    const gateHolds = new Promise<void>((r) => {
      announceHeld = r;
    });
    let releaseGate: () => void = () => {};
    const gateReleased = new Promise<void>((r) => {
      releaseGate = r;
    });

    const gate = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM projects WHERE id = ${projectId} FOR UPDATE`;
      announceHeld();
      await gateReleased;
    });
    await gateHolds;

    const tabA = open(projectId, cookie);
    await waitUntilBlockedOn(sql, ["projects", "for update"]);

    const tabB = open(projectId, cookie);
    await waitUntilBlockedOn(sql, ["pg_advisory_xact_lock"]);

    releaseGate();
    await gate;

    const [a, b] = await Promise.all([tabA, tabB]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const first = (await a.json()) as OpenResponse;
    const second = (await b.json()) as OpenResponse;
    expect(await conversationCount(projectId)).toBe(1);
    // The one that waited must hand back what the other created, not a second
    // conversation and not nothing.
    expect(second.data.current.conversation!.id).toBe(
      first.data.current.conversation!.id,
    );
  });
});

describe("POST /chat/open — what comes back", () => {
  it("returns the conversation the user spoke in most recently", async () => {
    const { projectId, cookie, userId } = await seedProject();
    const first = (await (await open(projectId, cookie)).json()) as OpenResponse;
    const spokenIn = first.data.current.conversation!.id;

    // A second conversation, created AFTER the first — but never spoken in.
    // The two orderings disagree here on purpose: newest-by-creation says this
    // one, newest-by-speech says the other. Only the second is what the user
    // means by "where I was".
    const [quiet] = await sql<{ id: string }[]>`
      INSERT INTO conversations (user_id, title, project_id)
      VALUES (${userId}, 'never used', ${projectId}) RETURNING id
    `;

    const said = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "the only thing anyone said",
        project_id: projectId,
        conversation_id: spokenIn,
      }),
    });
    await said.text();

    // Touch the quiet conversation's updated_at AFTER the message was sent.
    // Ordering by updated_at would now pick it; ordering by "when did anyone
    // last speak here" still picks the other. Renaming a conversation does
    // exactly this, which is why the two are not interchangeable.
    await sql`UPDATE conversations SET updated_at = now() WHERE id = ${quiet!.id}`;

    const payload = (await (await open(projectId, cookie)).json()) as OpenResponse;
    expect(payload.data.current.conversation!.id).toBe(spokenIn);
    expect(payload.data.current.conversation!.id).not.toBe(quiet!.id);
    expect(
      payload.data.current.messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual(["the only thing anyone said"]);
  });

  it("lists only this user's conversations in this project", async () => {
    const { projectId, cookie, studioId, userId } = await seedProject();
    const mine = (await (await open(projectId, cookie)).json()) as OpenResponse;

    // Another member of the same studio, with their own conversation here.
    // This is what the "only this user's" half is about.
    const other = await insertOutsider();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${other}, 'maintainer')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${other}, 'editor', null)
    `;
    await open(projectId, await loginCookie(other));

    // And the SAME user, in a second project of their own. This is the "in this
    // project" half, and without it the name is wider than the test: measured,
    // dropping the project condition from listConversations left every case in
    // this file green, because no caller had a conversation anywhere else.
    const [elsewhere] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
      VALUES (${studioId}, ${userId}, 'elsewhere', ${`elsewhere-${seq++}`}, 'private') RETURNING id
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${elsewhere!.id}, ${userId}, 'owner', null)
    `;
    const away = (await (await open(elsewhere!.id, cookie)).json()) as OpenResponse;

    const payload = (await (await open(projectId, cookie)).json()) as OpenResponse;
    // Two conversations exist in this project; this caller sees one of them,
    // and none of their own from the other project.
    expect(await conversationCount(projectId)).toBe(2);
    expect(payload.data.conversations.map((c) => c.id)).toEqual([
      mine.data.current.conversation!.id,
    ]);
    expect(payload.data.conversations.map((c) => c.id)).not.toContain(
      away.data.current.conversation!.id,
    );
  });

  it("hands back the messages in the order they were written", async () => {
    const { projectId, cookie } = await seedProject();
    const opened = (await (await open(projectId, cookie)).json()) as OpenResponse;
    const conversationId = opened.data.current.conversation!.id;

    // Two turns, so the order is something an assertion can be wrong about.
    // The repository reads newest-first and reverses; a single message never
    // shows which way round that came out.
    for (const text of ["first thing", "second thing"]) {
      const res = await app.request("/api/v1/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ message: text, project_id: projectId, conversation_id: conversationId }),
      });
      await res.text();
    }

    const payload = (await (await open(projectId, cookie)).json()) as OpenResponse;
    expect(
      payload.data.current.messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual(["first thing", "second thing"]);
  });

  it("leaves a soft-deleted conversation out of the list", async () => {
    const { projectId, cookie } = await seedProject();
    const first = (await (await open(projectId, cookie)).json()) as OpenResponse;
    const firstId = first.data.current.conversation!.id;

    await app.request(`/api/v1/chat/conversations/${firstId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    const payload = (await (await open(projectId, cookie)).json()) as OpenResponse;
    expect(payload.data.conversations.map((c) => c.id)).not.toContain(firstId);
    // With the only conversation gone, opening creates a fresh one.
    expect(payload.data.current.conversation).not.toBeNull();
    expect(payload.data.current.conversation!.id).not.toBe(firstId);
  });
});

describe("POST /chat/open — who may open it", () => {
  it("refuses an unauthenticated caller", async () => {
    const { projectId } = await seedProject();

    const res = await app.request("/api/v1/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    });

    expect(res.status).toBe(401);
  });

  it("hides a project the caller has no part in, and creates nothing", async () => {
    const { projectId } = await seedProject();
    const outsider = await insertOutsider();
    const before = await conversationCount(projectId);

    const res = await open(projectId, await loginCookie(outsider));

    expect(res.status).toBe(404);
    expect(await conversationCount(projectId)).toBe(before);
  });

  it("refuses to open chat in a project that has been deleted", async () => {
    const { projectId, cookie } = await seedProject();

    await sql`UPDATE projects SET deleted_at = now() WHERE id = ${projectId}`;

    const res = await open(projectId, cookie);

    expect(res.status).toBe(404);
    expect(await conversationCount(projectId)).toBe(0);
  });

  it("creates nothing when the project is deleted while it is opening", async () => {
    const { projectId, cookie } = await seedProject();

    // The case above never reaches the lock: the project is already dead when
    // the request arrives, so the access check turns it away. What the lock is
    // for is the window AFTER that check — the project is alive when the
    // caller looks, and gone by the time it would commit. Parking a lock on
    // the project row holds that window open on purpose.
    let announceHeld: () => void = () => {};
    const gateHolds = new Promise<void>((r) => {
      announceHeld = r;
    });
    let releaseGate: () => void = () => {};
    const gateReleased = new Promise<void>((r) => {
      releaseGate = r;
    });

    const gate = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM projects WHERE id = ${projectId} FOR UPDATE`;
      announceHeld();
      await gateReleased;
      // The delete lands while the opener is parked behind this lock.
      await tx`UPDATE projects SET deleted_at = now() WHERE id = ${projectId}`;
    });
    await gateHolds;

    const opening = open(projectId, cookie);
    // The opener must be waiting on the project row. If it is not, it is
    // creating a conversation while holding nothing, which is the defect: the
    // delete then sweeps past it and a live conversation is left on a dead
    // project, unreachable through chat and left behind by a delete that
    // believed it had swept the project clean.
    await waitUntilBlockedOn(sql, ["projects", "for update"]);

    releaseGate();
    await gate;

    const res = await opening;
    expect(res.status).toBe(404);
    expect(await conversationCount(projectId)).toBe(0);
  });

  it("refuses a view-only member, and creates nothing", async () => {
    const { projectId, studioId } = await seedProject();
    const viewer = await insertOutsider();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${viewer}, 'guest')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${viewer}, 'viewer', null)
    `;
    const before = await conversationCount(projectId);

    const res = await open(projectId, await loginCookie(viewer));

    // Opening chat creates a conversation, so it is a write, and reading the
    // project is not enough to do it.
    expect(res.status).toBe(403);
    expect(await conversationCount(projectId)).toBe(before);
  });
});
