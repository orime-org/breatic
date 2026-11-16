// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A turn hands its tools the links the conversation holds (inner#1664,
 * design 6.0), as `toolContext.pageUrlFor` on the config it builds: the
 * spelling the conversation recorded for a link, or nothing when it holds
 * none (plan §9 A).
 *
 * Driven through `MainAgent` with a scripted model, because the wiring is
 * the point: the set has to read the whole conversation -- the turns the
 * memory watermark folded away, read once up to and including the watermark
 * (plan §9 C), and the turn's own history rows above it -- the message sent
 * this turn (which is not in that history), the paused reply a questionnaire
 * answer resumes (one turn further than a new message reads), and the results
 * this turn's own tools come back with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import type { MessageData } from "@breatic/shared";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

type Row = MessageData & { forModel: unknown };

/** Everything below the memory watermark is left out of the turn's history. */
const WATERMARK = 2;

const state = vi.hoisted(() => ({
  history: [] as Row[],
  perCall: [] as unknown[][],
  calls: 0,
  toolContexts: [] as Array<Record<string, unknown>>,
  projectInstructions: undefined as string | undefined,
}));

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 5);
const getMessagesForLlm = vi.fn(async (_id: string, from = 0, before?: number) =>
  state.history.filter((row) => row.turnIndex > from && (before === undefined || row.turnIndex < before)),
);

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async (_u: string, _c: string, _p: string, before: number) => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: state.history.filter((row) => row.turnIndex > WATERMARK && row.turnIndex < before),
    watermark: WATERMARK,
    projectInstructions: state.projectInstructions,
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");
  const { tool } = await import("ai");
  const { z } = await import("zod");

  // A search that finds one page per query: the page's address is the query
  // turned into a path under `found.example`, so a case reads which search
  // produced it.
  const webSearch = tool({
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }: { query: string }) => ({
      query,
      sources: [{ url: `https://found.example/${query}`, title: query, publisher: "Found", excerpts: ["text"], index: 1 }],
      sent: 1,
    }),
  });

  return {
    // The real names beneath the stub, so whatever tool name the turn reads
    // off the barrel is the one production reads.
    ...actual,
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: async (options: { toolContext: Record<string, unknown> }) => {
      state.toolContexts.push(options.toolContext);
      return { modelId: "test", instructions: { base: "system" }, tools: { web_search: webSearch } };
    },
    finalizeTurn: async () => [],
    provider: (await import("../helpers/fake-provider.js")).fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async () => {
          const script = state.perCall[state.calls] ?? [FINISHED];
          state.calls += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of script) controller.enqueue(part as never);
                controller.close();
              },
            }),
          };
        },
      })),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  setUserForModel: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
  getMessagesForLlm,
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * A stored user row.
 * @param text - What the model was sent.
 * @param turnIndex - Its turn.
 * @returns The row.
 */
function userRow(text: string, turnIndex: number): Row {
  return {
    role: "user",
    parts: [{ type: "text", text }],
    content: text,
    ts: "",
    turnIndex,
    forModel: { messages: [{ role: "user", content: text }] },
  };
}

/** One step of prose. */
const says = (text: string): ModelStreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  FINISHED,
];

/**
 * The turn's `pageUrlFor` as it was handed over, from the tool context it
 * built its config with.
 * @returns The lookup.
 * @throws {Error} When the turn built no config or handed no lookup.
 */
function handedLookup(): (url: string) => unknown {
  const context = state.toolContexts.at(-1);
  if (context === undefined) throw new Error("the turn built no agent config");
  const lookup = context.pageUrlFor;
  expect(lookup).toEqual(expect.any(Function));
  return lookup as (url: string) => unknown;
}

/**
 * The turn's `pageUrlFor`, awaited.
 * @returns The lookup.
 */
function pageUrlFor(): (url: string) => Promise<string | undefined> {
  const lookup = handedLookup();
  return async (url) => (await lookup(url)) as string | undefined;
}

/**
 * Whether the turn's set holds a link.
 * @param url - The link.
 * @returns True when the turn would read it.
 */
async function allowed(url: string): Promise<boolean> {
  return (await pageUrlFor()(url)) !== undefined;
}

/**
 * Run a turn opened by a message, to its end.
 * @param said - What the user typed.
 */
async function chat(said: string): Promise<void> {
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat(said);
    for await (const chunk of turn) void chunk;
  });
}

/**
 * Run the segment resumed by a questionnaire answer, to its end.
 * @param turnIndex - The turn that asked.
 */
async function answer(turnIndex: number): Promise<void> {
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().answer("ask-1", { answers: [{ index: 0, selected: ["Yes"] }] }, turnIndex, undefined, "UTC", {});
    for await (const chunk of turn) void chunk;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.history = [];
  state.perCall = [];
  state.calls = 0;
  state.toolContexts = [];
  state.projectInstructions = undefined;
});

describe("a turn opened by a message", () => {
  it("allows a link from the message itself and from every earlier turn, those under the memory watermark included", async () => {
    state.history = [
      userRow("Before the fold: https://folded.example/old please", 1),
      userRow("After the fold: https://recent.example/new please", 4),
    ];
    state.perCall = [says("Sure.")];

    await chat("Now read https://this-message.example/post please");

    expect(await allowed("https://this-message.example/post")).toBe(true);
    expect(await allowed("https://folded.example/old")).toBe(true);
    expect(await allowed("https://recent.example/new")).toBe(true);
    expect(await allowed("https://never-said.example/x")).toBe(false);
  });

  it("allows a link the Project Instructions hold, as text the user wrote (#1400)", async () => {
    state.projectInstructions = "Follow the brand guide at https://brand.example/guide in every reply.";
    state.perCall = [says("Sure.")];

    await chat("hello");

    expect(await allowed("https://brand.example/guide")).toBe(true);
    expect(await allowed("https://never-said.example/x")).toBe(false);
  });

  it("reads the conversation only up to and including the memory watermark, and takes the turns above it from the history (plan §9 C)", async () => {
    state.history = [
      userRow("Before the fold: https://folded.example/old please", 1),
      userRow("After the fold: https://recent.example/new please", 4),
    ];
    state.perCall = [says("Sure.")];

    await chat("hello");
    // A link the turn's own context does not hold is what reads the folded turns.
    await allowed("https://never-said.example/x");

    expect(getMessagesForLlm).toHaveBeenCalledWith("c1", 0, WATERMARK + 1);
    expect(getMessagesForLlm).not.toHaveBeenCalledWith("c1", 0, 5);
    // Turn 4 is above the watermark: only the history row can have added it.
    expect(await allowed("https://recent.example/new")).toBe(true);
    expect(await allowed("https://folded.example/old")).toBe(true);
  });

  it("answers the spelling the conversation recorded first, with https added to a bare host (plan §9 A)", async () => {
    state.history = [userRow("Look at example.org/news/today please", 1)];
    state.perCall = [says("Sure.")];

    await chat("and https://Docs.Example.com/guide/ too");

    expect(await pageUrlFor()("http://EXAMPLE.org/news/today#secret")).toBe("https://example.org/news/today");
    expect(await pageUrlFor()("https://docs.example.com/guide#x")).toBe("https://Docs.Example.com/guide/");
    expect(await pageUrlFor()("https://never-said.example/x")).toBeUndefined();
  });

  it("allows the source of a web_search this turn ran, for a later web_fetch in the same turn, never its query", async () => {
    state.perCall = [
      [{ type: "tool-call", toolCallId: "call-search", toolName: "web_search", input: JSON.stringify({ query: "brief" }) }, FINISHED_ASKING_FOR_A_TOOL],
      says("Found it."),
    ];

    await chat("Find the brief");

    // The search ran and the model was asked again with its result.
    expect(state.calls).toBe(2);
    expect(await allowed("https://found.example/brief")).toBe(true);
    expect(await allowed("https://never-found.example/brief")).toBe(false);
  });
});

// Plan §13.2 row 10: the turns under the memory watermark are read only when
// web_fetch first meets a link the turn's own context does not hold.
describe("when the folded turns are read", () => {
  it("hands the tools a lookup that answers asynchronously", async () => {
    state.perCall = [says("Sure.")];

    await chat("Now read https://this-message.example/post please");

    expect(handedLookup()("https://this-message.example/post")).toBeInstanceOf(Promise);
  });

  it("does not read them in a turn that never looks a link up", async () => {
    state.history = [userRow("Before the fold: https://folded.example/old please", 1)];
    state.perCall = [says("Sure.")];

    await chat("hello");

    expect(getMessagesForLlm).not.toHaveBeenCalledWith("c1", 0, WATERMARK + 1);
  });

  it("does not read them for a link the turn's own context holds", async () => {
    state.history = [
      userRow("Before the fold: https://folded.example/old please", 1),
      userRow("After the fold: https://recent.example/new please", 4),
    ];
    state.perCall = [says("Sure.")];

    await chat("Now read https://this-message.example/post please");

    expect(await allowed("https://this-message.example/post")).toBe(true);
    expect(await allowed("https://recent.example/new")).toBe(true);
    expect(getMessagesForLlm).not.toHaveBeenCalledWith("c1", 0, WATERMARK + 1);
  });

  it("reads them once, on the first link the turn's own context misses", async () => {
    state.history = [userRow("Before the fold: https://folded.example/old please", 1)];
    state.perCall = [says("Sure.")];

    await chat("Now read https://this-message.example/post please");

    expect(await allowed("https://folded.example/old")).toBe(true);
    expect(await allowed("https://never-said.example/x")).toBe(false);
    const folded = getMessagesForLlm.mock.calls.filter(([, from, before]) => from === 0 && before === WATERMARK + 1);
    expect(folded).toHaveLength(1);
  });
});

describe("a segment resumed by a questionnaire answer", () => {
  it("reads one turn further, so a search in the paused reply makes its source readable", async () => {
    const searchOutput = {
      query: "poster ideas",
      sources: [{ url: "https://paused-search.example/ideas", title: "Ideas", publisher: "Paused", excerpts: ["x"], index: 1 }],
      sent: 1,
    };
    const askInput = { questions: [{ header: "Go", question: "Read it?", options: [{ label: "Yes" }, { label: "No" }] }] };
    const asked: ModelMessage = { role: "user", content: "make me a poster" };
    state.history = [
      userRow("make me a poster", 3),
      {
        role: "assistant",
        content: "",
        ts: "",
        turnIndex: 3,
        parts: [
          {
            type: "tool",
            toolCallId: "call-search",
            toolName: "web_search",
            input: { query: "poster ideas" },
            status: "success",
            output: searchOutput,
            forModel: { type: "text", value: "Results for: poster ideas" },
          },
          { type: "tool", toolCallId: "ask-1", toolName: "ask_user", input: askInput, status: "success", output: { answers: [{ index: 0, selected: ["Yes"] }] } },
        ],
        forModel: {
          messages: [
            asked,
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-search", toolName: "web_search", input: { query: "poster ideas" } }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "call-search", toolName: "web_search", output: { type: "text", value: "Results for: poster ideas" } }] },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "ask-1", toolName: "ask_user", input: askInput }] },
            {
              role: "tool",
              content: [{ type: "tool-result", toolCallId: "ask-1", toolName: "ask_user", output: { type: "json", value: { answers: [{ index: 0, selected: ["Yes"] }] } } }],
            },
          ],
          prefixHash: "h",
          turnTokens: 1,
          endTokens: 1,
        },
      },
    ];
    state.perCall = [says("Reading it now.")];

    await answer(3);

    // The paused turn is above the watermark: it reaches the set through the history.
    expect(await allowed("https://paused-search.example/ideas")).toBe(true);
    expect(await allowed("https://never-found.example/ideas")).toBe(false);
    expect(getMessagesForLlm).toHaveBeenCalledWith("c1", 0, WATERMARK + 1);
  });
});
