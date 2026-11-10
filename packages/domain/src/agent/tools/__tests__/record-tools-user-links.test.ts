// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links the user wrote in conversations the record tools read back
 * (inner#1664 §6.0).
 *
 * `read_conversation` and `search_conversations` can read the user's other
 * conversations in this project, and a link the user wrote there is one
 * `web_fetch` may read in a later turn. So their output carries the links
 * found in messages the user wrote -- only those: a link the Agent wrote is
 * the model's own text and must not become readable by passing through a
 * record tool. What the model reads of these tools does not change.
 */
import { describe, expect, it, vi } from "vitest";
import type { Tool } from "ai";

import { TOOL_MAP } from "@domain/agent/tools/index.js";
import type { ConversationTurns, ProjectRecords } from "@domain/agent/tools/project-records.js";

const SEARCH = "search_conversations";
const READ = "read_conversation";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";

const USER_LINK = "https://user.example/brief";
const OTHER_USER_LINK = "https://moodboard.example/board/42";
const AGENT_LINK = "https://agent.example/found";

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
 * Call a record tool as a turn would.
 * @param name - The tool.
 * @param input - What the model sent.
 * @param recs - The turn's records.
 * @returns The tool, and what it answered.
 */
async function call(name: string, input: Record<string, unknown>, recs: ProjectRecords): Promise<{ tool: Tool; output: unknown }> {
  const build = TOOL_MAP[name];
  if (!build) throw new Error(`${name} is not registered`);
  const tool = build();
  if (!tool.execute) throw new Error(`${name} has no execute`);
  const output: unknown = await tool.execute(input, { toolCallId: "t1", messages: [], context: { records: recs } } as never);
  return { tool, output };
}

/**
 * The text the model reads of a tool's answer: through its `toModelOutput`
 * when it declares one, as the SDK does, and the answer itself when it is a
 * string the SDK hands over as it is.
 * @param tool - The tool.
 * @param output - What it answered.
 * @returns The text.
 * @throws {Error} When neither gives text.
 */
async function modelText(tool: Tool, output: unknown): Promise<string> {
  const convert = tool.toModelOutput as
    | ((arg: { toolCallId: string; input: unknown; output: unknown }) => unknown)
    | undefined;
  if (convert === undefined) {
    if (typeof output === "string") return output;
    throw new Error("the answer is not text and the tool declares no toModelOutput");
  }
  const converted = (await convert({ toolCallId: "t1", input: {}, output })) as { type?: unknown; value?: unknown };
  if (converted.type !== "text" || typeof converted.value !== "string") throw new Error("toModelOutput gave no text");
  return converted.value;
}

/** A conversation of one turn: the user's message with two links, the Agent's with one. */
const TURNS: ConversationTurns = {
  conversationId: CONVERSATION,
  title: "Poster ideas",
  totalTurns: 1,
  current: true,
  messages: [
    {
      role: "user",
      turnIndex: 1,
      createdAt: "2026-10-18T09:00:00.000Z",
      parts: [{ type: "text", text: `Use ${USER_LINK} and ${OTHER_USER_LINK} please` }],
    },
    {
      role: "assistant",
      turnIndex: 1,
      createdAt: "2026-10-18T09:00:30.000Z",
      parts: [{ type: "text", text: `I also found ${AGENT_LINK} for you` }],
    },
  ],
};

/** What read_conversation has always written for TURNS. */
const TURNS_TEXT = [
  `Conversation ${CONVERSATION} "Poster ideas" (this conversation).`,
  [
    "Turn 1 · 2026-10-18T09:00:00.000Z",
    `user: Use ${USER_LINK} and ${OTHER_USER_LINK} please`,
    `assistant: I also found ${AGENT_LINK} for you`,
  ].join("\n"),
  "turns 1–1 of 1.",
].join("\n\n");

/** Two hits, one in a message the user wrote and one in the Agent's. */
const HITS = {
  hits: [
    {
      conversationId: CONVERSATION,
      conversationTitle: "Poster ideas",
      turnIndex: 3,
      role: "user" as const,
      createdAt: "2026-10-16T10:00:00.000Z",
      body: `the brief is at ${USER_LINK}`,
    },
    {
      conversationId: CONVERSATION,
      conversationTitle: "Poster ideas",
      turnIndex: 3,
      role: "assistant" as const,
      createdAt: "2026-10-16T10:00:30.000Z",
      body: `the brief also cites ${AGENT_LINK}`,
    },
  ],
  total: 2,
  nextCursor: null,
};

/** What search_conversations has always written for HITS searched for "brief". */
const HITS_TEXT = [
  '2 messages hold every one of "brief"; this page holds 2, newest first.',
  `- conversation ${CONVERSATION} "Poster ideas" · turn 3 · user · 2026-10-16T10:00:00.000Z: the brief is at ${USER_LINK}`,
  `- conversation ${CONVERSATION} "Poster ideas" · turn 3 · assistant · 2026-10-16T10:00:30.000Z: the brief also cites ${AGENT_LINK}`,
].join("\n");

describe("read_conversation", () => {
  it("answers with its text and the links the user wrote, not the ones the Agent wrote", async () => {
    const { output } = await call(READ, {}, records({ readConversation: vi.fn().mockResolvedValue(TURNS) }));

    expect(output).toEqual({ text: TURNS_TEXT, userLinks: [USER_LINK, OTHER_USER_LINK] });
  });

  it("hands the model the same text it always has", async () => {
    const { tool, output } = await call(READ, {}, records({ readConversation: vi.fn().mockResolvedValue(TURNS) }));

    expect(await modelText(tool, output)).toBe(TURNS_TEXT);
  });

  it("carries no links when the user wrote none", async () => {
    const agentOnly: ConversationTurns = {
      ...TURNS,
      messages: [
        { ...TURNS.messages[0]!, parts: [{ type: "text", text: "Make it warmer" }] },
        TURNS.messages[1]!,
      ],
    };

    const { output } = await call(READ, {}, records({ readConversation: vi.fn().mockResolvedValue(agentOnly) }));

    expect((output as { userLinks?: unknown }).userLinks).toEqual([]);
  });
});

describe("search_conversations", () => {
  it("answers with its text and the links in hits the user wrote, not in the Agent's", async () => {
    const { output } = await call(SEARCH, { query: "brief" }, records({ searchMessages: vi.fn().mockResolvedValue(HITS) }));

    expect(output).toEqual({ text: HITS_TEXT, userLinks: [USER_LINK] });
  });

  it("hands the model the same text it always has", async () => {
    const { tool, output } = await call(SEARCH, { query: "brief" }, records({ searchMessages: vi.fn().mockResolvedValue(HITS) }));

    expect(await modelText(tool, output)).toBe(HITS_TEXT);
  });

  it("carries no links when it lists conversations rather than searching them", async () => {
    const recs = records({
      listConversations: vi.fn().mockResolvedValue({
        conversations: [{ id: CONVERSATION, title: `See ${USER_LINK}`, updatedAt: "2026-10-16T10:00:00.000Z", turns: 2, current: true }],
        total: 1,
        nextCursor: null,
      }),
    });

    const { output } = await call(SEARCH, {}, recs);

    expect((output as { userLinks?: unknown }).userLinks).toEqual([]);
  });
});
