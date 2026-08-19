// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a conversation is called, and the two routes that write its record.
 *
 * A conversation takes its name from the first thing the user says in it. That
 * is the whole naming rule -- no model is asked to summarise, which would cost
 * a call, can fail, and would need a fallback for when it does.
 *
 * The rule has to be "has this been named yet", not "is this the first
 * message": a conversation whose history was emptied would be renamed over the
 * top of the name its owner chose.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// The SDK is stubbed. These tests POST to /chat/message, which runs a turn and
// reaches `streamText`; without this they would need a key and would talk to a
// vendor. The naming happens before any of that, but the turn still runs.
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
  getAgentConfig,
} from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const PG_DRIVER_LOCAL = "conversation-naming-test-driver";

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
  projectId: string;
  cookie: string;
}> {
  const tag = `cn-${seq++}`;
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
    projectId: project!.id,
    cookie: await loginCookie(user!.id),
  };
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
 * Open chat and return the conversation the panel would be showing.
 * @param projectId - Project to open chat in.
 * @param cookie - Caller's session cookie.
 * @returns The current conversation's id.
 */
async function openAndGetId(projectId: string, cookie: string): Promise<string> {
  const res = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ project_id: projectId }),
  });
  const payload = (await res.json()) as {
    data: { current: { conversation: { id: string } } };
  };
  return payload.data.current.conversation.id;
}

/**
 * Say something in a conversation and wait for the stream to close.
 * @param text - What the user typed.
 * @param projectId - Project the conversation is in.
 * @param conversationId - Conversation being written to.
 * @param cookie - Caller's session cookie.
 */
async function say(
  text: string,
  projectId: string,
  conversationId: string,
  cookie: string,
): Promise<void> {
  const res = await app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      message: text,
      project_id: projectId,
      conversation_id: conversationId,
    }),
  });
  await res.text();
}

/**
 * Read a conversation's stored title straight out of the table.
 * @param conversationId - Conversation to read.
 * @returns The title as stored, or null while it has none.
 */
async function storedTitle(conversationId: string): Promise<string | null> {
  const rows = await sql<{ title: string | null }[]>`
    SELECT title FROM conversations WHERE id = ${conversationId}
  `;
  return rows[0]!.title;
}

describe("A conversation takes its name from the first thing said in it", () => {
  it("names it after the first message", async () => {
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    // Nothing has been said in it yet, so it has no name of its own.
    expect(await storedTitle(conversationId)).toBeNull();

    await say("find me some cyberpunk reference images", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe(
      "find me some cyberpunk reference images",
    );
  });

  it("leaves the name alone on every message after the first", async () => {
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    await say("the first thing", projectId, conversationId, cookie);
    await say("something else entirely", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("the first thing");
  });

  it("never writes over a name the owner chose", async () => {
    // The rule is "has it been named", not "is this the first message". A
    // conversation renamed before anyone spoke in it is the case that tells
    // the two apart.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    const renamed = await app.request(
      `/api/v1/chat/conversations/${conversationId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ project_id: projectId, title: "Storyboard notes" }),
      },
    );
    expect(renamed.status).toBe(200);

    await say("the first thing anyone said here", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("Storyboard notes");
  });

  it("cuts a long first message to the configured length", async () => {
    // Measured against the configured limit, not against the message. The
    // repository truncates to 200 on its way to the column, so "shorter than
    // what was typed" passes with the naming code's own cut removed -- which
    // is what a mutation of that line showed.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const limit = getAgentConfig().conversation_title_max_chars;

    await say("a".repeat(500), projectId, conversationId, cookie);

    const title = await storedTitle(conversationId);
    expect(title).toHaveLength(limit);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("does not put an ellipsis on a title it did not cut", async () => {
    // 判断「够不够长」和执行截断必须用同一把尺。前者按 UTF-16 码元数、后者按
    // 码点数时，一句全是 emoji 的话会走进截断分支却一个字都切不掉，名字末尾
    // 凭空多一个表示「后面还有」的省略号。
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const limit = getAgentConfig().conversation_title_max_chars;
    // 码点数比上限少一个，码元数是它的两倍、比上限多。
    const said = "\u{1F600}".repeat(limit - 1);
    await say(said, projectId, conversationId, cookie);

    const title = await storedTitle(conversationId);
    expect(title).toBe(said);
  });

  it("never cuts an emoji in half", async () => {
    // A cut by code unit lands inside a surrogate pair, and half a pair is
    // stored -- and read back -- as the replacement character, permanently, in
    // the name of a conversation.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const limit = getAgentConfig().conversation_title_max_chars;
    // Put the emoji exactly where a cut by code unit would land.
    await say("a".repeat(limit - 2) + "\u{1F600} and more after it", projectId, conversationId, cookie);

    const title = await storedTitle(conversationId);
    expect(title).not.toContain("\uFFFD");
    expect(title!.endsWith("\u2026")).toBe(true);
  });

  it("keeps a first message that already fits, ellipsis and all", async () => {
    // The pair to the one above: without it, cutting everything to the limit
    // regardless of length would pass.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    await say("short enough", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("short enough");
  });

  it("folds a message typed across several lines into one", async () => {
    // A title with a newline in it shows only what came before the break.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    await say("first line\n\nsecond line", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("first line second line");
  });

  it("tells the client the name in the event that opens the turn", async () => {
    // Without this the list and the header go on showing the placeholder
    // until the reader leaves the project and comes back.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "name this conversation",
        project_id: projectId,
        conversation_id: conversationId,
      }),
    });
    const body = await res.text();

    const started = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { event: string; data: Record<string, unknown> })
      .find((e) => e.event === "chat_turn_started");

    expect(started).toBeDefined();
    expect(started!.data['title']).toBe("name this conversation");
  });
});

describe("POST /chat/conversations — starting one on purpose", () => {
  it("makes a second conversation in a project that already has one", async () => {
    const { projectId, cookie } = await seedProject();
    const first = await openAndGetId(projectId, cookie);

    const res = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { id: string; title: string } };
    expect(payload.data.id).not.toBe(first);
    expect(payload.data.title).toBeNull();

    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversations
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `;
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("refuses someone with no part in the project, and creates nothing", async () => {
    const { projectId } = await seedProject();
    const [outsider] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`cn-out-${seq++}@example.com`}, true) RETURNING id
    `;

    const res = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await loginCookie(outsider!.id),
      },
      body: JSON.stringify({ project_id: projectId }),
    });

    expect(res.status).toBe(404);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversations WHERE project_id = ${projectId}
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("what renaming does to when a conversation was last used", () => {
  it("leaves the timestamp alone", async () => {
    // `updated_at` is what orders the list and what each row shows as when the
    // conversation was last used. Renaming one is not using it: if this column
    // moves, a conversation nobody has spoken in for months jumps to the top
    // of the list wearing a "just now" label.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const before = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM conversations WHERE id = ${conversationId}
    `;

    const renamed = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId, title: "Storyboard notes" }),
    });
    expect(renamed.status).toBe(200);

    const after = await sql<{ updated_at: Date; title: string }[]>`
      SELECT updated_at, title FROM conversations WHERE id = ${conversationId}
    `;
    expect(after[0]!.title).toBe("Storyboard notes");
    expect(after[0]!.updated_at.getTime()).toBe(before[0]!.updated_at.getTime());
  });
});

describe("PATCH /chat/conversations/:id — who may name one", () => {
  it("answers 404 for a conversation belonging to someone else", async () => {
    // Not 403. A distinguishable answer would confirm the conversation exists.
    const mine = await seedProject();
    const theirs = await seedProject();
    const theirConversation = await openAndGetId(theirs.projectId, theirs.cookie);

    const res = await app.request(
      `/api/v1/chat/conversations/${theirConversation}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: mine.cookie },
        body: JSON.stringify({ project_id: theirs.projectId, title: "mine now" }),
      },
    );

    expect(res.status).toBe(404);
    expect(await storedTitle(theirConversation)).toBeNull();
  });

  it("answers 404 when the conversation is in a different project", async () => {
    const { projectId, cookie, userId } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
      SELECT studio_id, ${userId}, 'other', ${`cn-other-${seq++}`}, 'private'
      FROM projects WHERE id = ${projectId} RETURNING id
    `;

    const res = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: other!.id, title: "wrong project" }),
    });

    expect(res.status).toBe(404);
    expect(await storedTitle(conversationId)).toBeNull();
  });

  it("answers 404 for a conversation that has been deleted", async () => {
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${conversationId}`;

    const res = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId, title: "back from the dead" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("GET /chat/conversations/:id — reading one to switch into it", () => {
  it("says whether the conversation reaches back further than this page", async () => {
    // Switching conversations loads one this way. Without `hasMore` the panel
    // it lands in cannot know whether "load earlier" has anything to load.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    await say("something", projectId, conversationId, cookie);

    const res = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { messages: unknown[]; hasMore: boolean };
    };
    expect(payload.data.hasMore).toBe(false);
    expect(payload.data.messages.length).toBeGreaterThan(0);
  });
});

describe("a name whose characters do not fit in one code unit each", () => {
  it("stores it whole rather than cutting one in half", async () => {
    // 存的时候还有一道按列宽的裁剪,而它数的是 UTF-16 码元 —— 一个 emoji 占两个。
    // 命名那一步按码点裁到上限之内,码元数却可能是它的两倍,于是这道裁剪落在一对
    // 代理项中间,存进去的是一个替换字符,而首句命名(nameIfUnnamed)只在名字
    // 为空时写一次 —— 读者要摆脱它,只能自己去改名。
    const { projectId, cookie } = await seedProject();
    const id = await openAndGetId(projectId, cookie);
    const repo = await import("@server/modules/conversation/conversation.repo.js");
    // 上限那么多码点,而码元数几乎是两倍 —— 正是 titleForTurn 在上限调到 100
    // 以上时会交给它的东西。
    const named = "a" + "\u{1F600}".repeat(198) + "…";
    await repo.updateTitle(id, named);

    const [row] = await sql<{ title: string | null }[]>`
      SELECT title FROM conversations WHERE id = ${id}
    `;
    const stored = row?.title ?? "";
    expect(stored).not.toContain("�");
    expect([...stored].length).toBeLessThanOrEqual(200);
  });
});

describe("naming a conversation from its first message", () => {
  it("does not write over a name its owner has already given it", async () => {
    // 新建会话 → 在顶栏起名 → 立刻说第一句话。两个请求各跑各的,谁先提交由
    // 网络和库负载决定。首句命名是「读一次、写一次」,而读和写之间没有任何东西
    // 挡着 —— 读到「还没有名字」之后,不管这中间发生了什么都照写。这里把改名
    // 放在那两步中间(读返回的是改名之前的样子),正是那个顺序。
    const { projectId, cookie } = await seedProject();
    const id = await openAndGetId(projectId, cookie);
    const service = await import("@server/modules/conversation/conversation.service.js");
    const repo = await import("@server/modules/conversation/conversation.repo.js");

    const renamed = await app.request(`/api/v1/chat/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId, title: "我自己取的名字" }),
    });
    expect(renamed.status).toBe(200);

    // 这一轮的读发生在改名提交之前,所以它看到的是还没有名字。
    const asItWas = await repo.getConversation(id);
    const reading = vi
      .spyOn(repo, "getConversation")
      .mockResolvedValueOnce({ ...asItWas!, title: null });

    const answered = await service.titleForTurn(id, "帮我写一个分镜脚本");
    reading.mockRestore();

    const [row] = await sql<{ title: string | null }[]>`
      SELECT title FROM conversations WHERE id = ${id}
    `;
    expect(row?.title).toBe("我自己取的名字");
    // 而且回给这一轮的也得是它 —— 前端拿这个值画顶栏和列表行。
    expect(answered).toBe("我自己取的名字");
  });
});
