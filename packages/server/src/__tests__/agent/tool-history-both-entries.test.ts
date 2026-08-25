// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Both ways into a chat turn convert their history the same way.
 *
 * A conversation that had used a tool used to fail on its next turn: the
 * stored tool result went to the model as a string, which the SDK rejects
 * outright, and the whole turn died with it (task #75).
 *
 * There are two entry points, `chat()` and `handleSkillCommand()`, and the
 * line that assembled history was written out twice. Fixing the one that was
 * easy to find would have left the other failing exactly as before, with
 * nothing in the suite to say so — which is why each gets its own test here
 * rather than one test standing in for both.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { MessageData } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const streamTextRetry = vi.fn();

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    // The history is what this case is about: a turn now reads it itself,
    // after storing the message and answering the browser, so this is where
    // it comes from.
    compressedHistory: HISTORY,
  })),
}));
// The real `createUIMessageStream` and its helpers stay: they are what the
// turn's output is made of, and a double for them would leave these cases
// asserting on a shape nothing produces. Only the model call itself is
// replaced, which is what these files are actually holding still.
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(() => 40),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  return {
    ...base,
    // Which model and which tools a turn gets is decided elsewhere and tested
    // there. Using the real factory here would pull in the skill registry, and
    // the skill entry point would fail for want of a registered skill rather
    // than for anything this suite is about.
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: {} }),
    finalizeTurn: async () => [],
    streamTextRetry,
    getModel: () => ({ modelId: "test" }),
  };
});

/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that: the point of
 * the event is that the browser takes the server's version, and a version
 * with nothing in it is the version that gets out of the way.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({ addMessage, getMessages }));
// The turn asks the conversation what it is called, so it can say so in the
// event that opens the turn. Answered with a name already set: these tests are
// about what a turn streams, not about how a conversation comes by its name.
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));

// What the system prompt says is settled elsewhere and has its own tests; here
// it would only drag the skill registry in for a suite that asserts on history.
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * A model call that answers with nothing.
 *
 * The double is on the call here, not on the model, because what these cases
 * read is the argument it was given -- the history, on its way in. What comes
 * back is beside the point, so long as it ends: a stream that never closes
 * leaves the turn waiting on it forever.
 * @returns Something shaped like a `streamText` result.
 */
function saysNothing(): Record<string, unknown> {
  return {
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
  };
}

/** History of one turn where the agent searched and then answered. */
const HISTORY: MessageData[] = [
  {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "find me references" }],
    content: "find me references",
    ts: "2026-08-11T00:00:00Z",
    turnIndex: 1,
  },
  {
    id: "m2",
    role: "assistant",
    parts: [
      {
        type: "tool",
        toolCallId: "tc-1",
        toolName: "web_search",
        input: { query: "cyberpunk" },
        status: "success",
        output: "three links",
      },
      { type: "text", text: "Here is what I found." },
    ],
    content: "Here is what I found.",
    ts: "2026-08-11T00:00:01Z",
    turnIndex: 1,
  },
];

/**
 * Read the tool result out of what the model was given.
 * @returns The output field of the first tool message, or undefined when the
 *   history reached the model without one.
 */
function toolResultSentToModel(): unknown {
  const sent = streamTextRetry.mock.calls[0]?.[0] as
    | { messages: Array<{ role: string; content: unknown }> }
    | undefined;
  const toolMessage = sent?.messages.find((m) => m.role === "tool");
  return (toolMessage?.content as Array<{ output: unknown }> | undefined)?.[0]?.output;
}

/**
 * Drive one turn to completion through the given entry point.
 * @param run - Called with the agent; returns the stream to drain
 */
async function turn(
  run: (agent: InstanceType<typeof MainAgent>) => Promise<ReadableStream<unknown>>,
): Promise<void> {
  streamTextRetry.mockReturnValue(saysNothing());
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      projectId: "p1",
    },
    async () => {
      for await (const _ of await run(new MainAgent())) {
        // drained
      }
    },
  );
}

describe("a conversation that has used a tool", () => {
  beforeEach(() => {
    streamTextRetry.mockClear();
    addMessage.mockClear();
  });

  it("reaches the model in protocol form through the message entry point", async () => {
    await turn((agent) => agent.chat("and now what?"));

    expect(toolResultSentToModel()).toEqual({ type: "text", value: "three links" });
  });

  it("reaches the model in protocol form through the skill entry point", async () => {
    await turn((agent) => agent.handleSkillCommand("brainstorm", "and now what?"));

    expect(toolResultSentToModel()).toEqual({ type: "text", value: "three links" });
  });
});
