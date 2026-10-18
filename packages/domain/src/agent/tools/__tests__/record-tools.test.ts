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

/**
 * Records that answer nothing until a case says otherwise.
 * @param over - The reads a case answers.
 * @returns The records.
 */
function records(over: Partial<ProjectRecords> = {}): ProjectRecords {
  return {
    listConversations: vi.fn().mockResolvedValue({ conversations: [], total: 0, nextCursor: null }),
    searchMessages: vi.fn().mockResolvedValue({ hits: [], total: 0, nextCursor: null }),
    readConversation: vi.fn().mockResolvedValue({ conversationId: CONVERSATION, title: null, totalTurns: 0, messages: [] }),
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

/**
 * A conversation's turns, one user and one assistant message each.
 * @param turns - The words of each turn, user then assistant.
 * @param total - How many turns the conversation holds.
 * @returns What the read answers.
 */
function turnsOf(turns: Array<[string, string]>, total = turns.length): ConversationTurns {
  return {
    conversationId: CONVERSATION,
    title: "Poster ideas",
    totalTurns: total,
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

  it("asks for the turns named", async () => {
    const recs = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([])) });

    await call(READ, { conversation_id: CONVERSATION, from_turn: 3, to_turn: 7 }, recs);

    expect(recs.readConversation).toHaveBeenCalledWith(CONVERSATION, { fromTurn: 3, toTurn: 7 });
  });

  it("cuts a long message and says how much was cut", async () => {
    const max = getAgentConfig().records_message_max_chars;
    const tail = "END-OF-THE-LONG-MESSAGE";
    const long = "x".repeat(max + 500) + tail;
    const recs = records({ readConversation: vi.fn().mockResolvedValue(turnsOf([[long, "ok"]])) });

    const answer = await call(READ, {}, recs);

    expect(answer).not.toContain(tail);
    expect(answer).toContain(String(500 + tail.length));
  });

  it("stops at a whole turn when the page is full, and says where to go on from", async () => {
    const pageMax = getAgentConfig().records_page_max_chars;
    const msgMax = getAgentConfig().records_message_max_chars;
    // Each turn holds enough messages to fill more than half a page, so two
    // turns cannot share one.
    const half = Math.ceil(pageMax / 2 / msgMax) + 1;
    const filler = (turn: number): ConversationTurns["messages"] =>
      Array.from({ length: half }, (_, i) => ({
        role: "user" as const,
        turnIndex: turn,
        createdAt: "2026-10-18T09:00:00.000Z",
        parts: [{ type: "text" as const, text: `T${String(turn)}M${String(i)} ` + "y".repeat(msgMax - 10) }],
      }));
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: CONVERSATION,
        title: null,
        totalTurns: 3,
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
    const msgMax = getAgentConfig().records_message_max_chars;
    const many = Math.ceil(pageMax / msgMax) + 2;
    const recs = records({
      readConversation: vi.fn().mockResolvedValue({
        conversationId: CONVERSATION,
        title: null,
        totalTurns: 2,
        messages: [
          ...Array.from({ length: many }, (_, i) => ({
            role: "assistant" as const,
            turnIndex: 1,
            createdAt: "2026-10-18T09:00:00.000Z",
            parts: [{ type: "text" as const, text: `BIG${String(i)} ` + "z".repeat(msgMax - 10) }],
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
  it("asks for the Space and page the model named", async () => {
    const recs = records();

    await call(ACTIVITY, { space_id: SPACE, cursor: "C2" }, recs);

    expect(recs.activity).toHaveBeenCalledWith({ spaceId: SPACE, cursor: "C2" });
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
