// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reads a turn lends the record tools, against the real database
 * (inner#1469).
 *
 * Each read is bound to the turn's user, project, conversation and turn index,
 * and returns only what that user sees on screen: their own conversations in
 * this project and nothing deleted, and the node history, node tasks and
 * activity of a project they are still a member of. The invariant that
 * matters most -- nothing of another user's, another project's or anything
 * deleted ever comes back -- is checked over generated data as well as in
 * the cases below.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { initCore, getAgentConfig, loadLocales } from "@breatic/core";
import { RecordsRefused, TOOL_MAP, type ProjectRecords } from "@breatic/domain";
import type { ChatSpace } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let recordsFor: (turn: {
  userId: string;
  projectId: string;
  conversationId: string;
  turnIndex: number;
  spaces: ChatSpace[];
}) => ProjectRecords;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
  ({ projectRecordsFor: recordsFor } = await import("@server/agent/project-records.js"));
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * A user with a personal studio, so a name resolves for them.
 * @param name - Their display name.
 * @returns Their id.
 * @throws {Error} When an insert returns no row.
 */
async function seedUser(name: string): Promise<string> {
  const tag = `rec-${String(seq++)}-${crypto.randomBytes(3).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-me`}, 'personal', ${name})
  `;
  return user!.id;
}

/**
 * A project the user is a member of.
 * @param userId - Its owner.
 * @returns Its id.
 * @throws {Error} When an insert returns no row.
 */
async function seedProject(userId: string): Promise<string> {
  const tag = `recp-${String(seq++)}-${crypto.randomBytes(3).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${userId}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await addMember(project!.id, userId, "owner");
  return project!.id;
}

/**
 * Make someone a member of a project.
 * @param projectId - The project.
 * @param userId - Who.
 * @param role - With what role.
 */
async function addMember(projectId: string, userId: string, role: "owner" | "editor" | "viewer"): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${userId}, ${role}, null)
  `;
}

/**
 * A conversation.
 * @param userId - Its owner.
 * @param projectId - Its project.
 * @param opts - Its title, when it last changed, and whether it is deleted.
 * @returns Its id.
 * @throws {Error} When the insert returns no row.
 */
async function seedConversation(
  userId: string,
  projectId: string,
  opts: { title?: string | null; updatedAt?: string; deleted?: boolean } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, project_id, title, updated_at, deleted_at)
    VALUES (${userId}, ${projectId}, ${opts.title ?? null}, ${opts.updatedAt ?? new Date().toISOString()},
            ${opts.deleted === true ? new Date().toISOString() : null})
    RETURNING id
  `;
  return row!.id;
}

/**
 * A stored message.
 * @param conversationId - Where.
 * @param userId - The conversation's owner.
 * @param m - Its role, turn, position, parts, time and whether it is deleted.
 */
async function seedMessage(
  conversationId: string,
  userId: string,
  m: { role: "user" | "assistant"; turn: number; seq?: number; parts: unknown[]; at?: string; deleted?: boolean },
): Promise<void> {
  await sql`
    INSERT INTO conversation_messages (conversation_id, user_id, role, turn_index, seq, parts, created_at, deleted_at)
    VALUES (${conversationId}, ${userId}, ${m.role}, ${m.turn}, ${m.seq ?? (m.role === "user" ? 0 : 1)},
            ${sql.json(m.parts as never)}, ${m.at ?? new Date().toISOString()},
            ${m.deleted === true ? new Date().toISOString() : null})
  `;
}

/**
 * A text part.
 * @param text - Its words.
 * @returns The part.
 */
const said = (text: string): Record<string, unknown> => ({ type: "text", text });

/** A user, a project of theirs, and a conversation they are in this turn. */
interface Turn {
  userId: string;
  projectId: string;
  conversationId: string;
  turnIndex: number;
  spaces: ChatSpace[];
}

/**
 * A fresh user, project and current conversation at turn 5.
 * @returns The turn.
 */
async function newTurn(): Promise<Turn> {
  const userId = await seedUser("Ada");
  const projectId = await seedProject(userId);
  const conversationId = await seedConversation(userId, projectId, { title: "Current" });
  return { userId, projectId, conversationId, turnIndex: 5, spaces: [] };
}

/**
 * Collect every page of a paged read.
 * @param first - The first page.
 * @param next - How to read the page after a cursor.
 * @returns Every item, in order.
 */
async function allPages<T>(
  first: () => Promise<{ items: T[]; nextCursor: string | null }>,
  next: (cursor: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let page = await first();
  out.push(...page.items);
  while (page.nextCursor !== null) {
    page = await next(page.nextCursor);
    out.push(...page.items);
  }
  return out;
}

describe("the user's conversations", () => {
  it("are only theirs, in this project, and not deleted, each with its turn count", async () => {
    const turn = await newTurn();
    const other = await seedUser("Bob");
    await addMember(turn.projectId, other, "editor");
    const elsewhere = await seedProject(turn.userId);
    const mine = await seedConversation(turn.userId, turn.projectId, { title: "Mine" });
    await seedMessage(mine, turn.userId, { role: "user", turn: 1, parts: [said("one")] });
    await seedMessage(mine, turn.userId, { role: "user", turn: 7, parts: [said("seven")] });
    await seedConversation(other, turn.projectId, { title: "Bob's" });
    await seedConversation(turn.userId, elsewhere, { title: "Elsewhere" });
    await seedConversation(turn.userId, turn.projectId, { title: "Gone", deleted: true });

    const page = await recordsFor(turn).listConversations();

    expect(page.conversations.map((c) => c.title).sort()).toEqual(["Current", "Mine"]);
    expect(page.conversations.find((c) => c.id === mine)).toMatchObject({ turns: 7, current: false });
    expect(page.conversations.find((c) => c.id === turn.conversationId)).toMatchObject({ current: true });
    expect(page.total).toBe(2);
  });

  it("page through every one exactly once, newest first", async () => {
    const turn = await newTurn();
    const size = getAgentConfig().records_page_size;
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    // Some share an instant, which is what a keyset over time alone gets wrong.
    for (let i = 0; i < size + 3; i++) {
      await seedConversation(turn.userId, turn.projectId, {
        title: `c${String(i)}`,
        updatedAt: new Date(base + Math.floor(i / 2) * 1000).toISOString(),
      });
    }
    const records = recordsFor(turn);

    const first = await records.listConversations();
    const all = await allPages(
      async () => ({ items: first.conversations, nextCursor: first.nextCursor }),
      async (cursor) => {
        const p = await records.listConversations(cursor);
        return { items: p.conversations, nextCursor: p.nextCursor };
      },
    );

    expect(first.conversations).toHaveLength(size);
    expect(first.total).toBe(size + 4);
    expect(new Set(all.map((c) => c.id)).size).toBe(size + 4);
    expect(all).toHaveLength(size + 4);
  });
});

describe("searching the user's messages", () => {
  it("matches every word across the parts of one message, and gives that message once", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId, { title: "Poster ideas" });
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 2,
      parts: [
        said("The warm palette suits"),
        { type: "tool", toolCallId: "t", toolName: "search_images", input: { query: "cafe" }, status: "success", output: {} },
        said("a morning poster"),
      ],
    });

    const page = await recordsFor(turn).searchMessages(["warm", "poster"], {});

    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]).toMatchObject({ conversationId: other, conversationTitle: "Poster ideas", turnIndex: 2, role: "assistant" });
    expect(page.total).toBe(1);
  });

  it("finds what the user wrote on a questionnaire, and a proposal's prompt", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 1,
      parts: [
        {
          type: "tool",
          toolCallId: "ask-1",
          toolName: "ask_user",
          input: { questions: [{ header: "Mood", question: "Any mood?", options: [{ label: "Warm" }] }] },
          status: "success",
          output: { answers: [{ index: 0, selected: [], other: "暖色的午后光线" }] },
        },
      ],
    });
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 2,
      parts: [
        {
          type: "tool",
          toolCallId: "p-1",
          toolName: "propose_canvas_action",
          input: { segments: [{ text: "A lighthouse in heavy fog" }] },
          status: "success",
          output: {},
        },
      ],
    });
    const records = recordsFor(turn);

    expect((await records.searchMessages(["午后光线"], {})).hits.map((h) => h.turnIndex)).toEqual([1]);
    expect((await records.searchMessages(["LIGHTHOUSE"], {})).hits.map((h) => h.turnIndex)).toEqual([2]);
  });

  it("matches only words that reading the message would show", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    const max = getAgentConfig().records_tool_text_max_chars;
    await seedMessage(other, turn.userId, {
      role: "user",
      turn: 1,
      parts: [{ type: "attachment", chip: { id: "a1", type: "image", name: "portrait-ada.png", data_snapshot: {} } }],
    });
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 2,
      parts: [
        {
          type: "tool",
          toolCallId: "g",
          toolName: "get_product_guide",
          input: { topic: "canvas" },
          status: "success",
          output: { guide: "CATALOG-ONLY-WORD appears in the guide" },
        },
        {
          type: "tool",
          toolCallId: "w",
          toolName: "web_search",
          input: { query: "x".repeat(max) + " FAR-PAST-THE-CUT" },
          status: "success",
          output: {},
        },
        {
          type: "tool",
          toolCallId: "r",
          toolName: "read_conversation",
          input: { conversation_id: "c-1" },
          status: "success",
          output: "Turn 1 · user: ECHOED-WORD",
        },
        {
          type: "tool",
          toolCallId: "ask",
          toolName: "ask_user",
          input: { questions: [{ header: "Mood", question: "Which mood suits it?", options: [{ label: "UNPICKED-OPTION" }, { label: "Warm" }] }] },
          status: "success",
          output: { answers: [{ index: 0, selected: ["Warm"] }] },
        },
      ],
    });
    const records = recordsFor(turn);
    const turns = async (word: string): Promise<number[]> =>
      (await records.searchMessages([word], {})).hits.map((h) => h.turnIndex);

    expect(await turns("portrait-ada")).toEqual([1]);
    expect(await turns("mood suits")).toEqual([2]);
    expect(await turns("CATALOG-ONLY-WORD")).toEqual([]);
    expect(await turns("FAR-PAST-THE-CUT")).toEqual([]);
    expect(await turns("ECHOED-WORD")).toEqual([]);
    expect(await turns("UNPICKED-OPTION")).toEqual([]);
  });

  it("matches a text part up to the length reading writes it, and no further", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    const pageMax = getAgentConfig().records_page_max_chars;
    // Past the old 4000-character cap, still within a page: reading shows it.
    const shown = "SHOWN-PAST-FOUR-THOUSAND";
    const cut = "CUT-PAST-THE-PAGE";
    const text = `${"a".repeat(5000)} ${shown} ${"b".repeat(pageMax)} ${cut}`;
    await seedMessage(other, turn.userId, { role: "user", turn: 1, parts: [said(text)] });
    const records = recordsFor(turn);

    expect((await records.searchMessages([shown], {})).hits.map((h) => h.turnIndex)).toEqual([1]);
    expect((await records.searchMessages([cut], {})).hits).toEqual([]);
  });

  it("finds an old single-question card by its question and by an option", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 3,
      parts: [
        {
          type: "tool",
          toolCallId: "ask-old",
          toolName: "ask_user",
          input: { question: "Which aspect suits the banner?", options: ["Panoramic", "Portrait"] },
          status: "success",
          output: { question: "Which aspect suits the banner?" },
        },
      ],
    });
    const records = recordsFor(turn);

    expect((await records.searchMessages(["aspect suits the banner"], {})).hits.map((h) => h.turnIndex)).toEqual([3]);
    expect((await records.searchMessages(["Panoramic"], {})).hits.map((h) => h.turnIndex)).toEqual([3]);
  });

  it("finds a failed ask_user call that is no questionnaire by any string of its input, as other tools' calls", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 1,
      parts: [
        {
          type: "tool",
          toolCallId: "ask-err",
          toolName: "ask_user",
          input: { questions: [[{ header: "HEADER-ONLY-WORD", question: "Nested?" }]] },
          status: "error",
        },
      ],
    });

    expect((await recordsFor(turn).searchMessages(["HEADER-ONLY-WORD"], {})).hits.map((h) => h.turnIndex)).toEqual([1]);
  });

  it("does not match a failed ask_user call past the tool length", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    const max = getAgentConfig().records_tool_text_max_chars;
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 1,
      parts: [
        {
          type: "tool",
          toolCallId: "ask-err",
          toolName: "ask_user",
          input: { questions: [{ question: "x".repeat(max) + " FAR-PAST-THE-ASK-CUT" }] },
          status: "error",
        },
      ],
    });

    expect((await recordsFor(turn).searchMessages(["FAR-PAST-THE-ASK-CUT"], {})).hits).toEqual([]);
  });

  it("matches a failed ask_user call by exactly the words reading it shows", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    const max = getAgentConfig().records_tool_text_max_chars;
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 1,
      parts: [
        {
          type: "tool",
          toolCallId: "ask-err",
          toolName: "ask_user",
          input: {
            questions: [
              [{ header: "HEADER-ONLY-WORD", question: "NESTED-QUESTION-WORD" }],
              { question: "z".repeat(max) + " PAST-CUT-WORD" },
            ],
          },
          status: "error",
        },
      ],
    });
    const records = recordsFor(turn);
    const read = TOOL_MAP.read_conversation!();
    const shown = (await read.execute!({ conversation_id: other }, {
      toolCallId: "t1",
      messages: [],
      context: { records },
    } as never)) as string;
    const words = ["HEADER-ONLY-WORD", "NESTED-QUESTION-WORD", "PAST-CUT-WORD"];
    const found: string[] = [];
    for (const w of words) if ((await records.searchMessages([w], {})).hits.length > 0) found.push(w);

    expect(words.filter((w) => shown.includes(w))).toEqual(["HEADER-ONLY-WORD", "NESTED-QUESTION-WORD"]);
    expect(found).toEqual(words.filter((w) => shown.includes(w)));
  });

  it("marks the hits in the conversation this turn runs in, and only those", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(turn.conversationId, turn.userId, { role: "user", turn: 2, parts: [said("apricot here")] });
    await seedMessage(other, turn.userId, { role: "user", turn: 1, parts: [said("apricot there")] });

    const page = await recordsFor(turn).searchMessages(["apricot"], {});

    expect(page.hits).toHaveLength(2);
    expect(page.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: turn.conversationId, current: true }),
        expect.objectContaining({ conversationId: other, current: false }),
      ]),
    );
  });

  it("does not look into the model's thinking", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(other, turn.userId, {
      role: "assistant",
      turn: 1,
      parts: [{ type: "reasoning", text: "private-thought-xyz" }, said("Visible answer")],
    });

    expect((await recordsFor(turn).searchMessages(["private-thought-xyz"], {})).hits).toEqual([]);
  });

  it("takes % and _ as themselves", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(other, turn.userId, { role: "user", turn: 1, parts: [said("I am 100% sure")] });
    await seedMessage(other, turn.userId, { role: "user", turn: 2, parts: [said("I am 100 sure")] });
    await seedMessage(other, turn.userId, { role: "user", turn: 3, parts: [said("file_name here")] });
    await seedMessage(other, turn.userId, { role: "user", turn: 4, parts: [said("fileXname here")] });
    const records = recordsFor(turn);

    expect((await records.searchMessages(["100%"], {})).hits.map((h) => h.turnIndex)).toEqual([1]);
    expect((await records.searchMessages(["file_name"], {})).hits.map((h) => h.turnIndex)).toEqual([3]);
  });

  it("leaves out the turn now running, and keeps the turns before it", async () => {
    const turn = await newTurn();
    await seedMessage(turn.conversationId, turn.userId, { role: "user", turn: turn.turnIndex - 1, parts: [said("cyberpunk colours earlier")] });
    await seedMessage(turn.conversationId, turn.userId, { role: "user", turn: turn.turnIndex, parts: [said("did I say cyberpunk before?")] });

    const hits = (await recordsFor(turn).searchMessages(["cyberpunk"], {})).hits;

    expect(hits.map((h) => h.turnIndex)).toEqual([turn.turnIndex - 1]);
  });

  it("keeps to the conversation named, and refuses one that is not the user's here", async () => {
    const turn = await newTurn();
    const a = await seedConversation(turn.userId, turn.projectId);
    const b = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(a, turn.userId, { role: "user", turn: 1, parts: [said("lantern")] });
    await seedMessage(b, turn.userId, { role: "user", turn: 1, parts: [said("lantern")] });
    const stranger = await seedUser("Eve");
    const theirs = await seedConversation(stranger, await seedProject(stranger));
    const records = recordsFor(turn);

    expect((await records.searchMessages(["lantern"], { conversationId: a })).hits.map((h) => h.conversationId)).toEqual([a]);
    await expect(records.searchMessages(["lantern"], { conversationId: theirs })).rejects.toEqual(
      new RecordsRefused("unknown_conversation"),
    );
  });

  it("leaves out deleted messages and deleted conversations", async () => {
    const turn = await newTurn();
    const live = await seedConversation(turn.userId, turn.projectId);
    const gone = await seedConversation(turn.userId, turn.projectId, { deleted: true });
    await seedMessage(live, turn.userId, { role: "user", turn: 1, parts: [said("marmalade")] });
    await seedMessage(live, turn.userId, { role: "user", turn: 2, parts: [said("marmalade")], deleted: true });
    await seedMessage(gone, turn.userId, { role: "user", turn: 1, parts: [said("marmalade")] });

    const page = await recordsFor(turn).searchMessages(["marmalade"], {});

    expect(page.hits.map((h) => [h.conversationId, h.turnIndex])).toEqual([[live, 1]]);
    expect(page.total).toBe(1);
  });

  it("pages through every hit exactly once", async () => {
    const turn = await newTurn();
    const size = getAgentConfig().records_page_size;
    const other = await seedConversation(turn.userId, turn.projectId);
    const at = "2026-10-02T00:00:00.000Z";
    for (let i = 0; i < size + 5; i++) {
      // All at one instant: only the id keeps the order total.
      await seedMessage(other, turn.userId, { role: "user", turn: i + 1, parts: [said(`quince ${String(i)}`)], at });
    }
    const records = recordsFor(turn);

    const hits = await allPages(
      async () => {
        const p = await records.searchMessages(["quince"], {});
        return { items: p.hits, nextCursor: p.nextCursor };
      },
      async (cursor) => {
        const p = await records.searchMessages(["quince"], { cursor });
        return { items: p.hits, nextCursor: p.nextCursor };
      },
    );

    expect(hits.map((h) => h.turnIndex).sort((x, y) => x - y)).toEqual(Array.from({ length: size + 5 }, (_, i) => i + 1));
  });
});

describe("reading a conversation", () => {
  it("reads the current one up to the turn before this one, deleted messages left out", async () => {
    const turn = await newTurn();
    await seedMessage(turn.conversationId, turn.userId, { role: "user", turn: 1, parts: [said("first")] });
    await seedMessage(turn.conversationId, turn.userId, { role: "assistant", turn: 1, parts: [said("reply")] });
    await seedMessage(turn.conversationId, turn.userId, { role: "user", turn: 2, parts: [said("removed")], deleted: true });
    await seedMessage(turn.conversationId, turn.userId, { role: "user", turn: turn.turnIndex, parts: [said("running now")] });

    const read = await recordsFor(turn).readConversation(undefined, {});

    expect(read.conversationId).toBe(turn.conversationId);
    expect(read.current).toBe(true);
    expect((await recordsFor(turn).readConversation(turn.conversationId, {})).current).toBe(true);
    expect(read.messages.map((m) => [m.turnIndex, m.role])).toEqual([
      [1, "user"],
      [1, "assistant"],
    ]);
    // The highest turn there is to read: turn 2 is deleted and turn 5 is running.
    expect(read.totalTurns).toBe(1);
  });

  it("reads the turns asked for of another conversation of the user's", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId, { title: "Old" });
    for (let t = 1; t <= 6; t++) await seedMessage(other, turn.userId, { role: "user", turn: t, parts: [said(`t${String(t)}`)] });

    const read = await recordsFor(turn).readConversation(other, { fromTurn: 2, toTurn: 4 });

    expect(read).toMatchObject({ conversationId: other, title: "Old", totalTurns: 6, current: false });
    expect(read.messages.map((m) => m.turnIndex)).toEqual([2, 3, 4]);
  });

  it("reads an empty page from the highest turn a turn index can hold", async () => {
    const turn = await newTurn();
    const other = await seedConversation(turn.userId, turn.projectId);
    await seedMessage(other, turn.userId, { role: "user", turn: 1, parts: [said("only turn")] });
    const records = recordsFor(turn);

    await expect(records.readConversation(other, { fromTurn: 2147483647 })).resolves.toMatchObject({ messages: [], totalTurns: 1 });
    await expect(records.readConversation(undefined, { fromTurn: 2147483647 })).resolves.toMatchObject({ messages: [] });
  });

  it("refuses a conversation that is someone else's, in another project, or deleted", async () => {
    const turn = await newTurn();
    const stranger = await seedUser("Eve");
    await addMember(turn.projectId, stranger, "editor");
    const theirs = await seedConversation(stranger, turn.projectId);
    const elsewhere = await seedConversation(turn.userId, await seedProject(turn.userId));
    const deleted = await seedConversation(turn.userId, turn.projectId, { deleted: true });
    const records = recordsFor(turn);

    for (const id of [theirs, elsewhere, deleted, crypto.randomUUID()]) {
      await expect(records.readConversation(id, {})).rejects.toEqual(new RecordsRefused("unknown_conversation"));
    }
  });
});

/**
 * A node history row.
 * @param projectId - Its project.
 * @param userId - Who made it.
 * @param nodeId - The node.
 * @param opts - Its time and metadata.
 */
async function seedVersion(
  projectId: string,
  userId: string,
  nodeId: string,
  opts: { at: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await sql`
    INSERT INTO node_history (project_id, node_id, user_id, entry_type, status, content, metadata, created_at)
    VALUES (${projectId}, ${nodeId}, ${userId}, 'generation', 'success', ${`https://cdn.example/${crypto.randomUUID()}.png`},
            ${sql.json((opts.metadata ?? {}) as never)}, ${opts.at})
  `;
}

/**
 * A node task row.
 * @param projectId - Its project.
 * @param userId - Who started it.
 * @param nodeId - The node.
 * @param opts - Its label, state, start and budget.
 */
async function seedTask(
  projectId: string,
  userId: string,
  nodeId: string,
  opts: { label: string; status?: string; startedAt?: string; budgetMs?: number },
): Promise<void> {
  await sql`
    INSERT INTO node_tasks (project_id, space_id, node_id, kind, status, started_by_user_id, budget_ms, label, action, started_at)
    VALUES (${projectId}, ${crypto.randomUUID()}, ${nodeId}, 'image', ${opts.status ?? "done"}, ${userId},
            ${opts.budgetMs ?? 7_200_000}, ${opts.label}, 'generate', ${opts.startedAt ?? new Date().toISOString()})
  `;
}

describe("a node's records", () => {
  it("are this project's only, with each task's starter named", async () => {
    const turn = await newTurn();
    const node = crypto.randomUUID();
    const elsewhere = await seedProject(turn.userId);
    await seedVersion(turn.projectId, turn.userId, node, { at: "2026-10-03T00:00:00.000Z", metadata: { model: "here" } });
    await seedVersion(elsewhere, turn.userId, node, { at: "2026-10-03T00:00:00.000Z", metadata: { model: "elsewhere" } });
    await seedTask(turn.projectId, turn.userId, node, { label: "here-task" });
    await seedTask(elsewhere, turn.userId, node, { label: "elsewhere-task" });

    const recs = await recordsFor(turn).nodeRecords(node, {});

    expect(recs.versions.rows.map((v) => v.metadata["model"])).toEqual(["here"]);
    expect(recs.versions.total).toBe(1);
    expect(recs.tasks.rows.map((t) => [t.label, t.startedByName])).toEqual([["here-task", "Ada"]]);
    expect(recs.tasks.total).toBe(1);
  });

  it("page each list from its own offset", async () => {
    const turn = await newTurn();
    const node = crypto.randomUUID();
    const size = getAgentConfig().records_page_size;
    for (let i = 0; i < size + 2; i++) {
      await seedVersion(turn.projectId, turn.userId, node, { at: new Date(Date.parse("2026-10-04T00:00:00.000Z") + i * 1000).toISOString() });
      await seedTask(turn.projectId, turn.userId, node, {
        label: `task-${String(i)}`,
        startedAt: new Date(Date.parse("2026-10-04T00:00:00.000Z") + i * 1000).toISOString(),
      });
    }
    const records = recordsFor(turn);

    const first = await records.nodeRecords(node, {});
    const rest = await records.nodeRecords(node, { versionsOffset: size, tasksOffset: size });

    expect(first.versions.rows).toHaveLength(size);
    expect(first.tasks.rows).toHaveLength(size);
    expect(rest.versions.rows).toHaveLength(2);
    expect(rest.tasks.rows).toHaveLength(2);
    expect(first.versions.total).toBe(size + 2);
    expect(first.tasks.total).toBe(size + 2);
  });

  it("leave a task past its time limit as it is stored", async () => {
    const turn = await newTurn();
    const node = crypto.randomUUID();
    await seedTask(turn.projectId, turn.userId, node, {
      label: "late",
      status: "running",
      startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      budgetMs: 7_200_000,
    });

    await recordsFor(turn).nodeRecords(node, {});

    const [row] = await sql<{ status: string }[]>`SELECT status FROM node_tasks WHERE node_id = ${node}`;
    expect(row!.status).toBe("running");
  });
});

/**
 * An activity row.
 * @param projectId - Its project.
 * @param actor - Who did it.
 * @param opts - Its Space, time and type.
 */
async function seedActivity(
  projectId: string,
  actor: string,
  opts: { spaceId?: string; at?: string; type?: string },
): Promise<void> {
  await sql`
    INSERT INTO project_activities (project_id, actor_user_id, type, space_id, payload, created_at)
    VALUES (${projectId}, ${actor}, ${opts.type ?? "space:created"}, ${opts.spaceId ?? null},
            ${sql.json({ spaceName: "S" })}, ${opts.at ?? new Date().toISOString()})
  `;
}

describe("the project's activity", () => {
  it("keeps to the Spaces this turn's message gives that name, and says how many there are", async () => {
    const turn = await newTurn();
    const cover = crypto.randomUUID();
    const coverToo = crypto.randomUUID();
    const other = crypto.randomUUID();
    await seedActivity(turn.projectId, turn.userId, { spaceId: cover });
    await seedActivity(turn.projectId, turn.userId, { spaceId: coverToo });
    await seedActivity(turn.projectId, turn.userId, { spaceId: other });
    await seedActivity(await seedProject(turn.userId), turn.userId, { spaceId: cover });
    const records = recordsFor({
      ...turn,
      spaces: [
        { id: cover, name: "Cover", kind: "canvas" },
        { id: coverToo, name: "Cover", kind: "document" },
        { id: other, name: "Storyboard", kind: "canvas" },
      ],
    });

    const inCover = await records.activity({ spaceName: "Cover" });
    const all = await records.activity({});

    expect(new Set(inCover.items.map((i) => i.spaceId))).toEqual(new Set([cover, coverToo]));
    expect(inCover.total).toBe(2);
    expect(all.total).toBe(3);
  });

  it("refuses a Space name this turn's message does not give", async () => {
    const turn = await newTurn();

    await expect(recordsFor(turn).activity({ spaceName: "Nowhere" })).rejects.toEqual(new RecordsRefused("unknown_space"));
  });

  it("pages through every entry once", async () => {
    const turn = await newTurn();
    const count = getAgentConfig().records_page_size + 4;
    for (let i = 0; i < count; i++) {
      await seedActivity(turn.projectId, turn.userId, { at: new Date(Date.parse("2026-10-05T00:00:00.000Z") + Math.floor(i / 3)).toISOString() });
    }
    const records = recordsFor(turn);

    const items = await allPages(
      async () => records.activity({}),
      async (cursor) => records.activity({ cursor }),
    );

    expect(new Set(items.map((i) => i.id)).size).toBe(count);
  });
});

describe("a cursor that no page gave", () => {
  it("is refused by every paged read", async () => {
    const turn = await newTurn();
    const records = recordsFor(turn);
    const refused = new RecordsRefused("bad_cursor");

    await expect(records.listConversations("not-a-cursor")).rejects.toEqual(refused);
    await expect(records.searchMessages(["x"], { cursor: "not-a-cursor" })).rejects.toEqual(refused);
    await expect(records.activity({ cursor: "not-a-cursor" })).rejects.toEqual(refused);
  });

  it("is refused when it was given by another list", async () => {
    const turn = await newTurn();
    const size = getAgentConfig().records_page_size;
    for (let i = 0; i < size + 1; i++) {
      const id = await seedConversation(turn.userId, turn.projectId, { title: `plum ${String(i)}` });
      await seedMessage(id, turn.userId, { role: "user", turn: 1, parts: [said(`plum ${String(i)}`)] });
    }
    const records = recordsFor(turn);
    const refused = new RecordsRefused("bad_cursor");
    const listCursor = (await records.listConversations()).nextCursor;
    const searchCursor = (await records.searchMessages(["plum"], {})).nextCursor;
    expect(listCursor).not.toBeNull();
    expect(searchCursor).not.toBeNull();

    await expect(records.searchMessages(["plum"], { cursor: listCursor! })).rejects.toEqual(refused);
    await expect(records.activity({ cursor: listCursor! })).rejects.toEqual(refused);
    await expect(records.listConversations(searchCursor!)).rejects.toEqual(refused);
  });
});

describe("a cursor passed with another query or filter", () => {
  it("is refused by search when the query or the conversation differs, and pages on with the same ones", async () => {
    const turn = await newTurn();
    const size = getAgentConfig().records_page_size;
    const a = await seedConversation(turn.userId, turn.projectId);
    const b = await seedConversation(turn.userId, turn.projectId);
    for (let i = 0; i < size + 1; i++) {
      await seedMessage(a, turn.userId, { role: "user", turn: i + 1, parts: [said(`damson pie ${String(i)}`)] });
    }
    const records = recordsFor(turn);
    const refused = new RecordsRefused("bad_cursor");
    const cursor = (await records.searchMessages(["damson"], {})).nextCursor;
    const inA = (await records.searchMessages(["damson"], { conversationId: a })).nextCursor;
    expect(cursor).not.toBeNull();
    expect(inA).not.toBeNull();

    await expect(records.searchMessages(["pie"], { cursor: cursor! })).rejects.toEqual(refused);
    await expect(records.searchMessages(["damson", "pie"], { cursor: cursor! })).rejects.toEqual(refused);
    await expect(records.searchMessages(["damson"], { conversationId: a, cursor: cursor! })).rejects.toEqual(refused);
    await expect(records.searchMessages(["damson"], { conversationId: b, cursor: inA! })).rejects.toEqual(refused);
    await expect(records.searchMessages(["damson"], { cursor: inA! })).rejects.toEqual(refused);
    await expect(records.searchMessages(["damson"], { cursor: cursor! })).resolves.toMatchObject({ hits: [expect.anything()] });
    await expect(records.searchMessages(["damson"], { conversationId: a, cursor: inA! })).resolves.toMatchObject({
      hits: [expect.anything()],
    });
  });

  it("is refused by the activity feed when the Space filter differs, and pages on with the same one", async () => {
    const turn = await newTurn();
    const { getActivityFeedPageLimits } = await import("@server/config/limits.js");
    const size = getActivityFeedPageLimits().default;
    const cover = crypto.randomUUID();
    const storyboard = crypto.randomUUID();
    for (let i = 0; i < size + 1; i++) {
      await seedActivity(turn.projectId, turn.userId, {
        spaceId: cover,
        at: new Date(Date.parse("2026-10-06T00:00:00.000Z") + i * 1000).toISOString(),
      });
    }
    await seedActivity(turn.projectId, turn.userId, { spaceId: storyboard });
    const records = recordsFor({
      ...turn,
      spaces: [
        { id: cover, name: "Cover", kind: "canvas" },
        { id: storyboard, name: "Storyboard", kind: "canvas" },
      ],
    });
    const refused = new RecordsRefused("bad_cursor");
    const inCover = (await records.activity({ spaceName: "Cover" })).nextCursor;
    const unfiltered = (await records.activity({})).nextCursor;
    expect(inCover).not.toBeNull();
    expect(unfiltered).not.toBeNull();

    await expect(records.activity({ cursor: inCover! })).rejects.toEqual(refused);
    await expect(records.activity({ spaceName: "Storyboard", cursor: inCover! })).rejects.toEqual(refused);
    await expect(records.activity({ spaceName: "Cover", cursor: unfiltered! })).rejects.toEqual(refused);
    const next = await records.activity({ spaceName: "Cover", cursor: inCover! });
    expect(next.items.map((i) => i.spaceId)).toEqual([cover]);
  });
});

describe("a user who is no longer a member", () => {
  it("is refused every read", async () => {
    const turn = await newTurn();
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${turn.projectId} AND user_id = ${turn.userId}`;
    const records = recordsFor(turn);
    const refused = new RecordsRefused("not_member");

    await expect(records.listConversations()).rejects.toEqual(refused);
    await expect(records.searchMessages(["x"], {})).rejects.toEqual(refused);
    await expect(records.readConversation(undefined, {})).rejects.toEqual(refused);
    await expect(records.nodeRecords(crypto.randomUUID(), {})).rejects.toEqual(refused);
    await expect(records.activity({})).rejects.toEqual(refused);
  });

  it("is still a member at viewer level, and may read", async () => {
    const owner = await seedUser("Owner");
    const projectId = await seedProject(owner);
    const viewer = await seedUser("Vi");
    await addMember(projectId, viewer, "viewer");
    const conversationId = await seedConversation(viewer, projectId);

    await expect(
      recordsFor({ userId: viewer, projectId, conversationId, turnIndex: 1, spaces: [] }).activity({}),
    ).resolves.toMatchObject({ total: 0 });
  });
});

describe("a Space's name", () => {
  it("comes from this turn's list", async () => {
    const turn = await newTurn();
    const records = recordsFor({ ...turn, spaces: [{ id: "s-1", name: "Cover", kind: "canvas" }] });

    expect(records.spaceName("s-1")).toBe("Cover");
    expect(records.spaceName("s-2")).toBeUndefined();
  });
});

describe("whatever the data, the user reads only their own, live conversations in this project", () => {
  it("holds over generated users, projects and deletions", async () => {
    const me = await seedUser("Me");
    const them = await seedUser("Them");
    const here = await seedProject(me);
    const there = await seedProject(me);
    await addMember(here, them, "editor");
    await addMember(there, them, "editor");
    const current = await seedConversation(me, here);
    const records = recordsFor({ userId: me, projectId: here, conversationId: current, turnIndex: 1, spaces: [] });
    const visible = new Set([current]);

    await fc.assert(
      fc.asyncProperty(
        fc.record({ mine: fc.boolean(), here: fc.boolean(), deleted: fc.boolean(), messageDeleted: fc.boolean() }),
        async (c) => {
          const owner = c.mine ? me : them;
          const id = await seedConversation(owner, c.here ? here : there, { deleted: c.deleted });
          await seedMessage(id, owner, { role: "user", turn: 1, parts: [said("shared-token")], deleted: c.messageDeleted });
          const live = c.mine && c.here && !c.deleted;
          if (live) visible.add(id);

          const listed = (await records.listConversations()).conversations.map((x) => x.id);
          const found = (await records.searchMessages(["shared-token"], {})).hits.map((h) => h.conversationId);

          expect(new Set(listed)).toEqual(visible);
          for (const f of found) expect(visible.has(f)).toBe(true);
          if (live && !c.messageDeleted) expect(found).toContain(id);
          if (!live) {
            await expect(records.readConversation(id, {})).rejects.toEqual(new RecordsRefused("unknown_conversation"));
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
