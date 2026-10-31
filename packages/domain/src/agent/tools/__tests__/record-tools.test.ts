// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The four tools that read the user's records (inner#1469): their
 * conversations in this project, a canvas node's tasks and versions, and the
 * project's activity feed.
 *
 * The reads themselves are the server's, handed over for the turn as
 * `ProjectRecords`; these cases stand in for them and check what each tool
 * asks for and what it writes back for the model -- every page saying how
 * much is left and how to get it, and every refusal ending the way the
 * reader is meant to see it.
 */
import { describe, it, expect, vi } from "vitest";
import type { Tool } from "ai";
import { getAgentConfig } from "@breatic/core";
import { toolFailureOf, type NodeHistoryEntity, type ProjectActivityEntry } from "@breatic/shared";
import { TOOL_MAP, BASELINE_TOOLS } from "@domain/agent/tools/index.js";
import {
  MAX_TURN_INDEX,
  RecordsRefused,
  type ConversationTurns,
  type NodeTaskRecord,
  type ProjectRecords,
} from "@domain/agent/tools/project-records.js";

const SEARCH = "search_conversations";
const READ = "read_conversation";
const NODE = "read_node_history";
const ACTIVITY = "list_project_activity";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const SPACE = "33333333-3333-4333-8333-333333333333";

/** The length of each filler message in the paging cases: under every per-part cap. */
const CHUNK = 900;

/**
 * The cap on a version's prompt and text content.
 * @returns The configured number of characters.
 */
function versionMax(): number {
  return getAgentConfig().records_version_text_max_chars;
}

/**
 * Records that answer nothing until a case says otherwise.
 * @param over - The reads a case answers.
 * @returns The records.
 */
function records(over: Partial<ProjectRecords> = {}): ProjectRecords {
  return {
    listConversations: vi.fn().mockResolvedValue({ conversations: [], total: 0, nextCursor: null }),
    searchMessages: vi.fn().mockResolvedValue({ hits: [], total: 0, nextCursor: null }),
    readConversation: vi.fn().mockResolvedValue({ conversationId: CONVERSATION, title: null, totalTurns: 0, current: true, messages: [] }),
    nodeRecords: vi.fn().mockResolvedValue({ tasks: { rows: [], total: 0 }, versions: { rows: [], total: 0 } }),
    activity: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
    spaceName: vi.fn().mockReturnValue(undefined),
    ...over,
  };
}

/**
 * Call one of the record tools as a turn would.
 * @param name - The tool.
 * @param input - What the model sent.
 * @param recs - The turn's records.
 * @returns What the tool answered.
 * @throws {Error} When the tool is not registered, or when the call fails.
 */
async function call(name: string, input: Record<string, unknown>, recs: ProjectRecords): Promise<string> {
  const build = TOOL_MAP[name];
  if (!build) throw new Error(`${name} is not registered`);
  const tool: Tool = build();
  if (!tool.execute) throw new Error(`${name} has no execute`);
  const answer: unknown = await tool.execute(input, { toolCallId: "t1", messages: [], context: { records: recs } } as never);
  if (typeof answer !== "string") throw new Error(`${name} answered with ${typeof answer}`);
  return answer;
}

/**
 * What a failed call carries.
 * @param pending - The call.
 * @returns Its failure.
 * @throws {Error} When the call succeeded.
 */
async function failureOf(pending: Promise<unknown>): Promise<ReturnType<typeof toolFailureOf>> {
  const err = await pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: unknown) => e,
  );
  return toolFailureOf(err);
}

describe("the record tools", () => {
  it("are offered on every turn, whatever is open", () => {
    for (const name of [SEARCH, READ, NODE, ACTIVITY]) {
      expect(TOOL_MAP).toHaveProperty(name);
      expect(BASELINE_TOOLS).toContain(name);
    }
  });

  it("each say in words what is happening while they run", () => {
    const lines = Object.fromEntries(
      [SEARCH, READ, NODE, ACTIVITY].map((name) => [name, (TOOL_MAP[name]!().metadata as { runningLine?: string } | undefined)?.runningLine]),
    );

    expect(lines).toEqual({
      [SEARCH]: "chat.tool.searchingConversations",
      [READ]: "chat.tool.readingConversation",
      [NODE]: "chat.tool.readingNodeHistory",
      [ACTIVITY]: "chat.tool.readingActivity",
    });
  });

  it.each([
    [SEARCH, {}, "listConversations"],
    [READ, {}, "readConversation"],
    [NODE, { node_id: NODE_ID }, "nodeRecords"],
    [ACTIVITY, {}, "activity"],
  ] as const)("%s tells the reader they are no longer a member when the server says so", async (name, input, read) => {
    const recs = records({ [read]: vi.fn().mockRejectedValue(new RecordsRefused("not_member")) });

    expect(await failureOf(call(name, input, recs))).toMatchObject({
      kind: "tool_failed",
      readerKey: "chat.tool.failure.notMember",
    });
  });

  it.each([
    [SEARCH, {}, "listConversations"],
    [READ, {}, "readConversation"],
    [NODE, { node_id: NODE_ID }, "nodeRecords"],
    [ACTIVITY, {}, "activity"],
  ] as const)("%s says the fault is ours when the read itself fails", async (name, input, read) => {
    const recs = records({ [read]: vi.fn().mockRejectedValue(new Error("connection reset")) });

    expect(await failureOf(call(name, input, recs))).toMatchObject({
      kind: "tool_failed",
      readerKey: "chat.tool.failure.ourFault",
    });
  });

  it.each([
    [SEARCH, { query: "poster", conversation_id: CONVERSATION }, "searchMessages"],
    [READ, { conversation_id: CONVERSATION }, "readConversation"],
  ] as const)("%s turns the model away from a conversation that is not one of the user's here", async (name, input, read) => {
    const recs = records({ [read]: vi.fn().mockRejectedValue(new RecordsRefused("unknown_conversation")) });

    const failure = await failureOf(call(name, input, recs));

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure?.forModel).toContain(CONVERSATION);
  });
});

describe("a cursor the tools did not give", () => {
  it.each([
    [SEARCH, { cursor: "garbled" }, "listConversations"],
    [SEARCH, { query: "poster", cursor: "garbled" }, "searchMessages"],
    [ACTIVITY, { cursor: "garbled" }, "activity"],
  ] as const)("%s turns the model away rather than starting over", async (name, input, read) => {
    const recs = records({ [read]: vi.fn().mockRejectedValue(new RecordsRefused("bad_cursor")) });

    const failure = await failureOf(call(name, input, recs));

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure?.forModel).toMatch(/cursor/i);
  });
});

describe("a refused cursor", () => {
  it.each([
    [SEARCH, { cursor: "garbled" }, "listConversations"],
    [SEARCH, { query: "poster", cursor: "garbled" }, "searchMessages"],
    [ACTIVITY, { cursor: "garbled" }, "activity"],
  ] as const)("%s states the rule: a cursor goes on only with the list, query or filter it came from", async (name, input, read) => {
    const recs = records({ [read]: vi.fn().mockRejectedValue(new RecordsRefused("bad_cursor")) });

    const said = (await failureOf(call(name, input, recs)))?.forModel ?? "";

    expect(said).toMatch(/same query/i);
    expect(said).toMatch(/filter/i);
    expect(said).toMatch(/unchanged|as (it was )?(written|given)/i);
    expect(said).not.toMatch(/not one a page of this tool gave/);
  });
});

describe("search_conversations without a query", () => {
  it("lists the user's conversations here, marking the one this turn is in", async () => {
    const recs = records({
      listConversations: vi.fn().mockResolvedValue({
        conversations: [
          { id: CONVERSATION, title: "Poster ideas", updatedAt: "2026-10-18T09:00:00.000Z", turns: 12, current: true },
          { id: "44444444-4444-4444-8444-444444444444", title: null, updatedAt: "2026-10-17T08:00:00.000Z", turns: 3, current: false },
        ],
        total: 2,
        nextCursor: null,
      }),
    });

    const answer = await call(SEARCH, {}, recs);

    expect(recs.listConversations).toHaveBeenCalledWith(undefined);
    expect(answer).toContain(CONVERSATION);
    expect(answer).toContain("Poster ideas");
    expect(answer).toContain("(this conversation)");
    expect(answer).toContain("untitled");
    expect(answer).toMatch(/\b12 turns\b/);
    expect(answer).toContain("2026-10-17T08:00:00.000Z");
  });

  it("says how many there are in all and how to get the next page", async () => {
    const recs = records({
      listConversations: vi.fn().mockResolvedValue({
        conversations: [{ id: CONVERSATION, title: "One", updatedAt: "2026-10-18T09:00:00.000Z", turns: 1, current: false }],
        total: 57,
        nextCursor: "CURSOR-NEXT",
      }),
    });

    const answer = await call(SEARCH, { cursor: "CURSOR-PREV" }, recs);

    expect(recs.listConversations).toHaveBeenCalledWith("CURSOR-PREV");
    expect(answer).toContain("57");
    expect(answer).toContain("cursor=CURSOR-NEXT");
  });
});

describe("search_conversations with a query", () => {
  it("searches for each word the query holds, up to the configured number of them", async () => {
    const max = getAgentConfig().records_search_max_terms;
    const words = Array.from({ length: max + 2 }, (_, i) => `w${String(i)}`);
    const recs = records();

    await call(SEARCH, { query: `  ${words.join("   ")} ` }, recs);

    expect(recs.searchMessages).toHaveBeenCalledWith(words.slice(0, max), { conversationId: undefined, cursor: undefined });
  });

  it("keeps to the one conversation named", async () => {
    const recs = records();

    await call(SEARCH, { query: "poster", conversation_id: CONVERSATION, cursor: "C1" }, recs);

    expect(recs.searchMessages).toHaveBeenCalledWith(["poster"], { conversationId: CONVERSATION, cursor: "C1" });
  });

  it("gives each hit's conversation, turn, speaker, time, and the words around the match", async () => {
    const around = getAgentConfig().records_snippet_chars;
    const far = "FARAWAY";
    const body = `${far}${"a".repeat(around * 3)} the warm palette we chose ${"b".repeat(around * 3)}${far}`;
    const recs = records({
      searchMessages: vi.fn().mockResolvedValue({
        hits: [
          { conversationId: CONVERSATION, conversationTitle: "Poster ideas", turnIndex: 4, role: "user", createdAt: "2026-10-16T10:00:00.000Z", body },
        ],
        total: 1,
        nextCursor: null,
      }),
    });

    const answer = await call(SEARCH, { query: "Warm" }, recs);

    expect(answer).toContain(CONVERSATION);
    expect(answer).toContain("Poster ideas");
    expect(answer).toMatch(/\bturn 4\b/);
    expect(answer).toMatch(/\buser\b/);
    expect(answer).toContain("2026-10-16T10:00:00.000Z");
    expect(answer).toContain("the warm palette we chose");
    expect(answer).not.toContain(far);
  });

  it("says how many messages match in all and how to get the next page", async () => {
    const recs = records({
      searchMessages: vi.fn().mockResolvedValue({
        hits: [{ conversationId: CONVERSATION, conversationTitle: null, turnIndex: 1, role: "assistant", createdAt: "2026-10-16T10:00:00.000Z", body: "poster" }],
        total: 31,
        nextCursor: "NEXT-HITS",
      }),
    });

    const answer = await call(SEARCH, { query: "poster" }, recs);

    expect(answer).toContain("31");
    expect(answer).toContain("cursor=NEXT-HITS");
  });
});

describe("search_conversations given a cursor and an empty page", () => {
  it("says there is nothing more after that cursor, and gives no total", async () => {
    const recs = records({ searchMessages: vi.fn().mockResolvedValue({ hits: [], total: 0, nextCursor: null }) });

    const answer = await call(SEARCH, { query: "poster", cursor: "search.PREV" }, recs);

    expect(answer).toMatch(/no more messages after this cursor/i);
    expect(answer).not.toMatch(/\b0 messages hold\b/);
  });
});

/**
 * A conversation's turns, one user and one assistant message each.
 * @param turns - The words of each turn, user then assistant.
 * @param total - How many turns the conversation holds.
 * @returns What the read answers.
 */
function turnsOf(turns: Array<[string, string]>, total = turns.length, current = true): ConversationTurns {
  return {
    conversationId: CONVERSATION,
    title: "Poster ideas",
    totalTurns: total,
    current,
    messages: turns.flatMap(([said, answered], i) => [
      { role: "user" as const, turnIndex: i + 1, createdAt: `2026-10-18T09:0${String(i % 10)}:00.000Z`, parts: [{ type: "text" as const, text: said }] },
      { role: "assistant" as const, turnIndex: i + 1, createdAt: `2026-10-18T09:0${String(i % 10)}:30.000Z`, parts: [{ type: "text" as const, text: answered }] },
    ]),
  };
}

describe("read_conversation", () => {
  it("reads the current conversation when none is named, from the first turn", async () => {
    const recs = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([["Make a poster", "Sure."]])) });

    const answer = await call(READ, {}, recs);

    expect(recs.readConversation).toHaveBeenCalledWith(undefined, { fromTurn: undefined, toTurn: undefined });
    expect(answer).toContain("Turn 1");
    expect(answer).toContain("user: Make a poster");
    expect(answer).toContain("assistant: Sure.");
  });

  it("marks the conversation as this one when the server says it is, however it was named", async () => {
    const named = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([["hi", "hello"]], 1, true)) });
    const other = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([["hi", "hello"]], 1, false)) });

    expect(await call(READ, { conversation_id: CONVERSATION }, named)).toContain("(this conversation)");
    expect(await call(READ, {}, other)).not.toContain("(this conversation)");
  });

  it("takes no turn number past what a turn index can hold", () => {
    const schema = TOOL_MAP[READ]!().inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };

    expect(MAX_TURN_INDEX).toBe(2147483647);
    expect(schema.safeParse({ from_turn: MAX_TURN_INDEX }).success).toBe(true);
    expect(schema.safeParse({ to_turn: MAX_TURN_INDEX }).success).toBe(true);
    expect(schema.safeParse({ from_turn: MAX_TURN_INDEX + 1 }).success).toBe(false);
    expect(schema.safeParse({ to_turn: MAX_TURN_INDEX + 1 }).success).toBe(false);
    expect(schema.safeParse({ from_turn: 2147483647 }).success).toBe(true);
    expect(schema.safeParse({ from_turn: 2147483648 }).success).toBe(false);
    expect(schema.safeParse({ to_turn: 2147483648 }).success).toBe(false);
  });

  it("asks for the turns named", async () => {
    const recs = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([])) });

    await call(READ, { conversation_id: CONVERSATION, from_turn: 3, to_turn: 7 }, recs);

    expect(recs.readConversation).toHaveBeenCalledWith(CONVERSATION, { fromTurn: 3, toTurn: 7 });
  });

  it("cuts a message longer than a page and says how much was cut", async () => {
    const max = getAgentConfig().records_page_max_chars;
    const tail = "END-OF-THE-LONG-MESSAGE";
    const long = "x".repeat(max + 500) + tail;
    const recs = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([[long, "ok"]])) });

    const answer = await call(READ, {}, recs);

    expect(answer).not.toContain(tail);
    expect(answer).toContain(`[${String(500 + tail.length)} more characters cut]`);
  });

  it("stops at a whole turn when the page is full, and says where to go on from", async () => {
    const pageMax = getAgentConfig().records_page_max_chars;
    // Each turn holds enough messages to fill more than half a page, so two
    // turns cannot share one.
    const half = Math.ceil(pageMax / 2 / CHUNK) + 1;
    const filler = (turn: number): ConversationTurns["messages"] =>
      Array.from({ length: half }, (_, i) => ({
        role: "user" as const,
        turnIndex: turn,
        createdAt: "2026-10-18T09:00:00.000Z",
        parts: [{ type: "text" as const, text: `T${String(turn)}M${String(i)} ` + "y".repeat(CHUNK - 10) }],
      }));
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: CONVERSATION,
        title: null,
        totalTurns: 3,
        current: true,
        messages: [...filler(1), ...filler(2), ...filler(3)],
      }),
    });

    const answer = await call(READ, {}, recs);

    expect(answer).toContain("T1M0");
    expect(answer).not.toContain("T2M0");
    expect(answer).toContain("from_turn=2");
    expect(answer).toContain("of 3");
  });

  it("still gives a whole turn that alone is longer than a page", async () => {
    const pageMax = getAgentConfig().records_page_max_chars;
    const many = Math.ceil(pageMax / CHUNK) + 2;
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: CONVERSATION,
        title: null,
        totalTurns: 2,
        current: true,
        messages: [
          ...Array.from({ length: many }, (_, i) => ({
            role: "assistant" as const,
            turnIndex: 1,
            createdAt: "2026-10-18T09:00:00.000Z",
            parts: [{ type: "text" as const, text: `BIG${String(i)} ` + "z".repeat(CHUNK - 10) }],
          })),
          { role: "user" as const, turnIndex: 2, createdAt: "2026-10-18T09:05:00.000Z", parts: [{ type: "text" as const, text: "SECOND-TURN" }] },
        ],
      }),
    });

    const answer = await call(READ, {}, recs);

    expect(answer).toContain("BIG0");
    expect(answer).toContain(`BIG${String(many - 1)}`);
    expect(answer).not.toContain("SECOND-TURN");
    expect(answer).toContain("from_turn=2");
  });
});

/**
 * Three turns, each filling more than half a page, so a page holds only the first.
 * @returns What the read answers.
 */
function threeFullTurns(): ConversationTurns {
  const pageMax = getAgentConfig().records_page_max_chars;
  const half = Math.ceil(pageMax / 2 / CHUNK) + 1;
  const filler = (turn: number): ConversationTurns["messages"] =>
    Array.from({ length: half }, (_, i) => ({
      role: "user" as const,
      turnIndex: turn,
      createdAt: "2026-10-18T09:00:00.000Z",
      parts: [{ type: "text" as const, text: `T${String(turn)}M${String(i)} ` + "y".repeat(CHUNK - 10) }],
    }));
  return { conversationId: CONVERSATION, title: null, totalTurns: 3, current: true, messages: [...filler(1), ...filler(2), ...filler(3)] };
}

describe("read_conversation given a last turn", () => {
  it("passes the last turn on in the next-page line while the next page is still within it", async () => {
    const recs = records({ readConversation: vi.fn().mockResolvedValue(threeFullTurns()) });

    const answer = await call(READ, { conversation_id: CONVERSATION, from_turn: 1, to_turn: 3 }, recs);
    const tail = answer.split("\n").at(-1) ?? "";

    expect(tail).toContain(`conversation_id=${CONVERSATION}`);
    expect(tail).toContain("from_turn=2");
    expect(tail).toContain("to_turn=3");
  });

  it("writes the next-page line as before when no last turn was given", async () => {
    const recs = records({ readConversation: vi.fn().mockResolvedValue(threeFullTurns()) });

    const answer = await call(READ, { conversation_id: CONVERSATION, from_turn: 1 }, recs);

    expect(answer.split("\n").at(-1)).toBe(`turns 1–1 of 3; call again with conversation_id=${CONVERSATION} from_turn=2`);
  });
});

/**
 * A task on the node.
 * @param over - What differs from a finished generation.
 * @returns The task.
 */
function task(over: Partial<NodeTaskRecord>): NodeTaskRecord {
  return {
    id: "t-1",
    projectId: "p",
    spaceId: SPACE,
    nodeId: NODE_ID,
    kind: "image",
    action: "generate",
    status: "done",
    startedByUserId: "u-1",
    startedByName: "Ada",
    startedAt: new Date("2026-10-18T08:00:00.000Z"),
    settledAt: new Date("2026-10-18T08:01:00.000Z"),
    budgetMs: 7_200_000,
    label: "Flux Pro",
    errorMessage: null,
    nodeHistoryId: null,
    content: null,
    coverUrl: null,
    mediaWidth: null,
    mediaHeight: null,
    duration: null,
    mimeType: null,
    size: null,
    ...over,
  };
}

/**
 * A version of the node.
 * @param over - What differs from a successful generation.
 * @returns The version.
 */
function version(over: Partial<NodeHistoryEntity>): NodeHistoryEntity {
  return {
    id: "h-1",
    projectId: "p",
    nodeId: NODE_ID,
    userId: "u-1",
    operatorName: "Ada",
    entryType: "generation",
    status: "success",
    content: "https://cdn.example/a.png",
    thumbnailUrl: null,
    errorMessage: null,
    taskId: "task-1",
    metadata: { model: "flux-pro", credits: 12, params: { prompt: "a warm cafe at dawn", aspect_ratio: "9:16" } },
    mediaWidth: 1024,
    mediaHeight: 1820,
    duration: null,
    mimeType: "image/png",
    size: 1000,
    createdAt: new Date("2026-10-18T08:01:00.000Z"),
    ...over,
  };
}

describe("read_node_history", () => {
  it("asks for the node's records from where the model said", async () => {
    const recs = records();

    await call(NODE, { node_id: NODE_ID, versions_offset: 20, tasks_offset: 10 }, recs);

    expect(recs.nodeRecords).toHaveBeenCalledWith(NODE_ID, { versionsOffset: 20, tasksOffset: 10 });
  });

  it("writes a version's credits to at most two decimals, rounded up (inner#1666)", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: { rows: [version({ metadata: { model: "flux-pro", credits: 3.4512 } })], total: 1 },
      }),
    });

    expect(await call(NODE, { node_id: NODE_ID }, recs)).toMatch(/\b3\.46 credits\b/);
  });

  it("writes each version's prompt, model, credits, result, and who made it", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({ tasks: { rows: [], total: 0 }, versions: { rows: [version({})], total: 1 } }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).toContain("a warm cafe at dawn");
    expect(answer).toContain("flux-pro");
    expect(answer).toMatch(/\b12 credits\b/);
    expect(answer).toContain("https://cdn.example/a.png");
    expect(answer).toContain("Ada");
    expect(answer).toContain("9:16");
  });

  it("takes the prompt from the text parameter when there is no prompt one", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: { rows: [version({ metadata: { model: "tts-1", params: { text: "Hello there, listener" } } })], total: 1 },
      }),
    });

    expect(await call(NODE, { node_id: NODE_ID }, recs)).toContain("Hello there, listener");
  });

  it("names the mini-tool a version came from, by the field the history panel reads", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: { rows: [version({ metadata: { model: "x", toolId: "rotate", params: {} } })], total: 1 },
      }),
    });

    expect(await call(NODE, { node_id: NODE_ID }, recs)).toContain("mini-tool rotate");
  });

  it("writes why a failed version failed", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: { rows: [version({ status: "failed", content: null, errorMessage: "no_result" })], total: 1 },
      }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).toContain("failed");
    expect(answer).toContain("no_result");
  });

  it("writes each task's kind, label, state and who started it", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [task({ status: "failed", errorMessage: "over_cap", action: "upload", label: "cover.png" })], total: 1 },
        versions: { rows: [], total: 0 },
      }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).toContain("upload");
    expect(answer).toContain("cover.png");
    expect(answer).toContain("failed");
    expect(answer).toContain("over_cap");
    expect(answer).toContain("Ada");
  });

  it("calls a task past its time limit expired, as the panel does, and one within it running", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: {
          rows: [
            task({ id: "late", label: "LATE-ONE", status: "running", settledAt: null, startedAt: new Date(Date.now() - 3 * 3_600_000), budgetMs: 7_200_000 }),
            task({ id: "live", label: "LIVE-ONE", status: "running", settledAt: null, startedAt: new Date(Date.now() - 60_000), budgetMs: 7_200_000 }),
          ],
          total: 2,
        },
        versions: { rows: [], total: 0 },
      }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);
    const late = answer.split("\n").find((line) => line.includes("LATE-ONE"));
    const live = answer.split("\n").find((line) => line.includes("LIVE-ONE"));

    expect(late).toContain("expired");
    expect(live).toContain("running");
  });

  it("says how many of each there are and where the next page of each starts", async () => {
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [task({})], total: 41 },
        versions: { rows: [version({})], total: 63 },
      }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).toContain("41");
    expect(answer).toContain("63");
    expect(answer).toContain("tasks_offset=1");
    expect(answer).toContain("versions_offset=1");
  });

  it("says plainly when nothing is recorded for the node here", async () => {
    expect(await call(NODE, { node_id: NODE_ID }, records())).toContain(
      "no task or version recorded for this node in this project",
    );
  });
});

/**
 * An activity entry.
 * @param over - What differs from a generation that succeeded.
 * @returns The entry.
 */
function entry(over: Partial<ProjectActivityEntry>): ProjectActivityEntry {
  return {
    id: "a-1",
    projectId: "p",
    actorUserId: "u-1",
    actorName: "Ada",
    type: "generation:succeeded",
    spaceId: SPACE,
    nodeId: NODE_ID,
    taskId: "task-1",
    payload: { source: "task", model: "flux-pro", credits: 12, fileUrl: "https://cdn.example/a.png" },
    restored: false,
    createdAt: Date.parse("2026-10-18T08:01:00.000Z"),
    ...over,
  };
}

describe("list_project_activity", () => {
  it("asks for the Space, by its name, and the page the model named", async () => {
    const recs = records();

    await call(ACTIVITY, { space: "Cover", cursor: "C2" }, recs);

    expect(recs.activity).toHaveBeenCalledWith({ spaceName: "Cover", cursor: "C2" });
  });

  it("turns the model away from a Space the message does not name", async () => {
    const recs = records({ activity: vi.fn().mockRejectedValue(new RecordsRefused("unknown_space")) });

    const failure = await failureOf(call(ACTIVITY, { space: "Nowhere" }, recs));

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure?.forModel).toContain("Nowhere");
  });

  it("calls a member who removed themselves one who left, as the panel does", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({
        items: [
          entry({ id: "left", type: "member:removed", nodeId: null, actorName: "Bob", actorUserId: "u-bob", payload: { targetUserId: "u-bob", previousRole: "editor" } }),
          entry({ id: "removed", type: "member:removed", nodeId: null, actorName: "Ada", actorUserId: "u-ada", payload: { targetUserId: "u-bob", previousRole: "editor" } }),
        ],
        total: 2,
        nextCursor: null,
      }),
    });

    const lines = (await call(ACTIVITY, {}, recs)).split("\n");
    const bob = lines.find((line) => line.includes("Bob"));
    const ada = lines.find((line) => line.includes("Ada"));

    expect(bob).toContain("left the project");
    expect(bob).not.toContain("member:removed");
    expect(ada).toContain("member:removed");
  });

  it("names the medium a generation made", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({
        items: [entry({ payload: { source: "task", model: "kling", kind: "video", credits: 40 } })],
        total: 1,
        nextCursor: null,
      }),
    });

    expect(await call(ACTIVITY, {}, recs)).toMatch(/\bvideo\b/);
  });

  it("writes who did what, where, on which node, and what it cost", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({ items: [entry({})], total: 1, nextCursor: null }),
      spaceName: vi.fn().mockReturnValue("Cover"),
    });

    const answer = await call(ACTIVITY, {}, recs);

    expect(answer).toContain("Ada");
    expect(answer).toContain("generation:succeeded");
    expect(answer).toContain(SPACE);
    expect(answer).toContain("Cover");
    expect(answer).toContain(NODE_ID);
    expect(answer).toContain("flux-pro");
    expect(answer).toMatch(/\b12 credits\b/);
    expect(answer).toContain("2026-10-18T08:01:00.000Z");
  });

  it("writes an event's credits to at most two decimals, rounded up (inner#1666)", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({
        items: [entry({ payload: { source: "task", model: "flux-pro", credits: 3.4512 } })],
        total: 1,
        nextCursor: null,
      }),
    });

    expect(await call(ACTIVITY, {}, recs)).toMatch(/\b3\.46 credits\b/);
  });

  it("names a Space by what the event recorded before what the message lists", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({
        items: [entry({ type: "space:deleted", nodeId: null, payload: { spaceName: "Old storyboard" } })],
        total: 1,
        nextCursor: null,
      }),
      spaceName: vi.fn().mockReturnValue("Something else"),
    });

    const answer = await call(ACTIVITY, {}, recs);

    expect(answer).toContain("Old storyboard");
    expect(answer).not.toContain("Something else");
  });

  it("writes both names of a renamed Space", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({
        items: [entry({ type: "space:renamed", nodeId: null, payload: { spaceName: "New name", oldSpaceName: "Old name" } })],
        total: 1,
        nextCursor: null,
      }),
    });

    const answer = await call(ACTIVITY, {}, recs);

    expect(answer).toContain("New name");
    expect(answer).toContain("Old name");
  });

  it("names a Space by the message's list when the event recorded no name", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({ items: [entry({})], total: 1, nextCursor: null }),
      spaceName: vi.fn().mockReturnValue("Cover"),
    });

    expect(await call(ACTIVITY, {}, recs)).toContain("Cover");
    expect(recs.spaceName).toHaveBeenCalledWith(SPACE);
  });

  it("gives only the id of a Space nothing names", async () => {
    const recs = records({ activity: vi.fn().mockResolvedValue({ items: [entry({})], total: 1, nextCursor: null }) });

    expect(await call(ACTIVITY, {}, recs)).toContain(SPACE);
  });

  it("says how many entries there are in all and how to get the next page", async () => {
    const recs = records({
      activity: vi.fn().mockResolvedValue({ items: [entry({})], total: 208, nextCursor: "OLDER" }),
    });

    const answer = await call(ACTIVITY, {}, recs);

    expect(answer).toContain("208");
    expect(answer).toContain("cursor=OLDER");
  });
});

/**
 * Whether a string holds no lone surrogate (`String.prototype.isWellFormed`,
 * which the ES2023 lib does not declare).
 * @param s - The string.
 * @returns True when every surrogate is paired.
 */
function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

describe("read_conversation cuts each part on its own", () => {
  it("keeps the end of a short text part that follows several long tool calls", async () => {
    const pageMax = getAgentConfig().records_page_max_chars;
    const toolMax = getAgentConfig().records_tool_text_max_chars;
    // Enough cut tool lines that, together, they already pass a page.
    const calls = Math.ceil(pageMax / toolMax) + 1;
    const end = "END-OF-THE-FINAL-TEXT";
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: CONVERSATION,
        title: null,
        totalTurns: 1,
        current: true,
        messages: [
          {
            role: "assistant" as const,
            turnIndex: 1,
            createdAt: "2026-10-18T09:00:00.000Z",
            parts: [
              ...Array.from({ length: calls }, (_, i) => ({
                type: "tool" as const,
                toolCallId: `t${String(i)}`,
                toolName: "web_search",
                input: { query: "q".repeat(toolMax * 2) },
                status: "success" as const,
              })),
              { type: "text" as const, text: `Here is the plan. ${end}` },
            ],
          },
        ],
      }),
    });

    const answer = await call(READ, {}, recs);

    expect(answer).toContain(end);
    expect(answer).not.toMatch(/more characters cut/);
  });

  it("cuts a long text part after a tool call and counts only what that part lost", async () => {
    const max = getAgentConfig().records_page_max_chars;
    const tail = "END-OF-THE-LONG-MESSAGE";
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: CONVERSATION,
        title: null,
        totalTurns: 1,
        current: true,
        messages: [
          {
            role: "assistant" as const,
            turnIndex: 1,
            createdAt: "2026-10-18T09:00:00.000Z",
            parts: [
              { type: "tool" as const, toolCallId: "t", toolName: "web_search", input: { query: "cafe" }, status: "success" as const },
              { type: "text" as const, text: "x".repeat(max + 500) + tail },
            ],
          },
        ],
      }),
    });

    const answer = await call(READ, {}, recs);

    expect(answer).toContain("[called web_search] cafe");
    expect(answer).not.toContain(tail);
    expect(answer).toContain(`[${String(500 + tail.length)} more characters cut]`);
  });
});

describe("a search hit's snippet", () => {
  it.each([
    ["starts", (around: number) => `${"x".repeat(10)}\u{1F600}${"y".repeat(around - 1)}needle${"z".repeat(10)}`],
    ["ends", (around: number) => `${"x".repeat(10)}needle${"z".repeat(around - 1)}\u{1F600}${"w".repeat(10)}`],
  ] as const)("never splits an emoji where the window %s", async (_where, bodyFor) => {
    const body = bodyFor(getAgentConfig().records_snippet_chars);
    const recs = records({
      searchMessages: vi.fn().mockResolvedValue({
        hits: [{ conversationId: CONVERSATION, conversationTitle: null, turnIndex: 1, role: "user", createdAt: "2026-10-16T10:00:00.000Z", body, current: false }],
        total: 1,
        nextCursor: null,
      }),
    });

    const answer = await call(SEARCH, { query: "needle" }, recs);

    expect(answer).toContain("needle");
    expect(wellFormed(answer)).toBe(true);
  });
});

describe("search_conversations hits in this conversation", () => {
  it("are marked as this conversation, and the others are not", async () => {
    const other = "44444444-4444-4444-8444-444444444444";
    const recs = records({
      searchMessages: vi.fn().mockResolvedValue({
        hits: [
          { conversationId: CONVERSATION, conversationTitle: "Here", turnIndex: 2, role: "user", createdAt: "2026-10-16T10:00:00.000Z", body: "apricot", current: true },
          { conversationId: other, conversationTitle: "There", turnIndex: 3, role: "user", createdAt: "2026-10-15T10:00:00.000Z", body: "apricot", current: false },
        ],
        total: 2,
        nextCursor: null,
      }),
    });

    const lines = (await call(SEARCH, { query: "apricot" }, recs)).split("\n");
    const here = lines.find((line) => line.includes(CONVERSATION));
    const there = lines.find((line) => line.includes(other));

    expect(here).toContain("(this conversation)");
    expect(there).toBeDefined();
    expect(there).not.toContain("(this conversation)");
  });
});

describe("the conversation tools' descriptions", () => {
  it("read_conversation says the record tools' own calls come without their answers", () => {
    expect(TOOL_MAP[READ]!().description).toMatch(/without (their|its) answers?/i);
  });

  it("search_conversations says what the tools answered is not searched", () => {
    expect(TOOL_MAP[SEARCH]!().description).toMatch(/not what (the )?tools answered|tool results are not/i);
  });
});

describe("a version's text content", () => {
  it("is cut at the version text cap, not the tool text cap", async () => {
    const toolMax = getAgentConfig().records_tool_text_max_chars;
    const end = "VERSION-TEXT-END";
    const text = "t".repeat(toolMax + 200) + end;
    expect(text.length).toBeLessThan(versionMax());
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: { rows: [version({ entryType: "snapshot", content: text, metadata: {} })], total: 1 },
      }),
    });

    expect(await call(NODE, { node_id: NODE_ID }, recs)).toContain(text);
  });
});

describe("a version's content and prompt", () => {
  it("writes a text that starts with a link as text: cut, and on the version's one line", async () => {
    expect(versionMax()).toBeGreaterThan(0);
    const tail = "TEXT-AFTER-THE-LINK-TAIL";
    const content = `https://example.com/x\nSECOND-LINE-START ${"s".repeat(versionMax())}${tail}`;
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: { rows: [version({ entryType: "snapshot", content, metadata: {} })], total: 1 },
      }),
    });

    const lines = (await call(NODE, { node_id: NODE_ID }, recs)).split("\n");
    const line = lines.find((l) => l.includes("https://example.com/x"));

    expect(line).toBeDefined();
    expect(line).toContain("SECOND-LINE-START");
    expect(line).toMatch(/more characters cut/);
    expect(lines.some((l) => l.includes(tail))).toBe(false);
  });

  it("writes a content that is one link and nothing else as it is", async () => {
    const url = "https://cdn.example/only-a-link.png";
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({ tasks: { rows: [], total: 0 }, versions: { rows: [version({ content: url })], total: 1 } }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).toContain(`content ${url}`);
    expect(answer).not.toMatch(/more characters cut/);
  });

  it("cuts a prompt and a text content longer than the version text cap, saying how much each lost", async () => {
    expect(versionMax()).toBeGreaterThan(0);
    const promptTail = "PROMPT-TAIL-GONE";
    const contentTail = "CONTENT-TAIL-GONE-NOW";
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: {
          rows: [
            version({
              entryType: "generation",
              content: "c".repeat(versionMax()) + contentTail,
              metadata: { model: "gpt-text", params: { prompt: "p".repeat(versionMax()) + promptTail } },
            }),
          ],
          total: 1,
        },
      }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).not.toContain(promptTail);
    expect(answer).not.toContain(contentTail);
    expect(answer).toContain(`[${String(promptTail.length)} more characters cut]`);
    expect(answer).toContain(`[${String(contentTail.length)} more characters cut]`);
  });
});

describe("a next-page line", () => {
  it("list_project_activity names the Space filter it was read with, quoted, along with the cursor", async () => {
    const name = "Cover art";
    const recs = records({
      activity: vi.fn().mockResolvedValue({ items: [entry({})], total: 208, nextCursor: "activity.OLDER" }),
    });

    const answer = await call(ACTIVITY, { space: name }, recs);
    const tail = answer.split("\n").find((line) => line.includes("cursor=activity.OLDER"));

    expect(tail).toBeDefined();
    expect(tail).toContain("space");
    expect(tail).toContain(JSON.stringify(name));
  });

  it("search_conversations names the conversation it was kept to, along with the cursor", async () => {
    const recs = records({
      searchMessages: vi.fn().mockResolvedValue({
        hits: [{ conversationId: CONVERSATION, conversationTitle: null, turnIndex: 1, role: "user", createdAt: "2026-10-16T10:00:00.000Z", body: "poster", current: false }],
        total: 31,
        nextCursor: "search.NEXT-HITS",
      }),
    });

    const answer = await call(SEARCH, { query: "poster", conversation_id: CONVERSATION }, recs);
    const tail = answer.split("\n").find((line) => line.includes("cursor=search.NEXT-HITS"));

    expect(tail).toBeDefined();
    expect(tail).toContain(`conversation_id=${CONVERSATION}`);
  });

  it.each([
    ["this conversation", true],
    ["another conversation", false],
  ] as const)("read_conversation names the conversation it read, for %s, along with from_turn", async (_which, current) => {
    const id = current ? CONVERSATION : "55555555-5555-4555-8555-555555555555";
    const pageMax = getAgentConfig().records_page_max_chars;
    const half = Math.ceil(pageMax / 2 / CHUNK) + 1;
    const filler = (turn: number): ConversationTurns["messages"] =>
      Array.from({ length: half }, (_, i) => ({
        role: "user" as const,
        turnIndex: turn,
        createdAt: "2026-10-18T09:00:00.000Z",
        parts: [{ type: "text" as const, text: `T${String(turn)}M${String(i)} ` + "y".repeat(CHUNK - 10) }],
      }));
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: id,
        title: null,
        totalTurns: 2,
        current,
        messages: [...filler(1), ...filler(2)],
      }),
    });

    const answer = await call(READ, current ? {} : { conversation_id: id }, recs);
    const tail = answer.split("\n").find((line) => line.includes("from_turn=2"));

    expect(tail).toBeDefined();
    expect(tail).toContain(`conversation_id=${id}`);
  });
});

describe("list_project_activity given a cursor and an empty page", () => {
  it("says there is no more activity after that cursor, and gives no page head", async () => {
    const recs = records({ activity: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }) });

    const answer = await call(ACTIVITY, { cursor: "activity.PREV" }, recs);

    expect(answer).toMatch(/no more .*after this cursor/i);
    expect(answer).not.toMatch(/this page holds 0/);
  });
});

/**
 * The JSON string a version line writes after a label, read back.
 * @param line - The version's line.
 * @param label - The label before it, such as "prompt".
 * @returns The string the quotes hold, or undefined when there is none.
 */
function quotedAfter(line: string, label: string): string | undefined {
  const found = new RegExp(`${label} ("(?:[^"\\\\]|\\\\.)*")`).exec(line);
  return found ? (JSON.parse(found[1]!) as string) : undefined;
}

describe("a version's cut prompt and text", () => {
  it("quote only the part kept, and say how much was cut outside the quotes", async () => {
    const promptTail = "PROMPT-TAIL-GONE";
    const contentTail = "CONTENT-TAIL-GONE-NOW";
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({
        tasks: { rows: [], total: 0 },
        versions: {
          rows: [
            version({
              entryType: "generation",
              content: "c".repeat(versionMax()) + contentTail,
              metadata: { model: "gpt-text", params: { prompt: "p".repeat(versionMax()) + promptTail } },
            }),
          ],
          total: 1,
        },
      }),
    });

    const line = (await call(NODE, { node_id: NODE_ID }, recs)).split("\n").find((l) => l.includes("gpt-text")) ?? "";

    expect(line).toContain(`" [${String(promptTail.length)} more characters cut]`);
    expect(line).toContain(`" [${String(contentTail.length)} more characters cut]`);
    expect(quotedAfter(line, "prompt")).toBe("p".repeat(versionMax()));
    expect(quotedAfter(line, "content")).toBe("c".repeat(versionMax()));
  });
});

describe("a version's content that is one link", () => {
  it("is cut at the version text cap when it is longer, saying how much was cut", async () => {
    const tail = "LINK-TAIL-GONE.png";
    const url = `https://cdn.example/${"a".repeat(versionMax())}${tail}`;
    const recs = records({
      nodeRecords: vi.fn().mockResolvedValue({ tasks: { rows: [], total: 0 }, versions: { rows: [version({ content: url })], total: 1 } }),
    });

    const answer = await call(NODE, { node_id: NODE_ID }, recs);

    expect(answer).not.toContain(tail);
    expect(answer).toMatch(/more characters cut/);
  });
});
