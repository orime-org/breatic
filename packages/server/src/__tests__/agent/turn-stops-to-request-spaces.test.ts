// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn that asks to read Spaces stops there and waits, the way a turn that
 * asks a questionnaire does (inner#1552).
 *
 * `request_space_content` has no `execute`, so the SDK stops the step at the
 * call. The tools a turn waits on the reader for are one named set
 * (`AWAITS_READER`): of every such call in one step only the first is put to
 * the reader, whichever tool made it, and the rest are turned away -- each
 * told so under its own tool's name, since a result filed under another
 * tool's name is a result the provider pairs with nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

/** What the reply-time settle callback hands back for one waiting call. */
type Settle = (toolCallId: string, toolName: string) => { output: unknown; forModel: unknown };

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 1);
const settles = vi.hoisted(() => ({ last: null as Settle | null }));
const foldIfTooLong = vi.fn(async () => "none");
const logInfo = vi.fn();

const modelSays = vi.hoisted(() => ({
  perCall: [] as unknown[][],
  calls: 0,
}));

/** The Spaces this turn lists for the model. */
const SPACES = vi.hoisted(() => [
  { id: "d1", name: "Storyboard", kind: "document" as const },
  { id: "c1", name: "Cast", kind: "canvas" as const },
]);

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    history: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  const logger = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: actual.getAgentConfig,
    logger: { ...logger, child: () => logger },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");

  // The real tools, so a call the schema refuses is refused as in production.
  const tools = await import("../../../../domain/src/agent/tools/index.js");

  return {
    ...base,
    ASK_USER: actual.ASK_USER,
    REQUEST_SPACE_CONTENT: actual.REQUEST_SPACE_CONTENT,
    AWAITS_READER: actual.AWAITS_READER,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: { base: "system" },
      tools: {
        ask_user: tools.makeAskUserTool({ mediaUrlAllowed: () => false }),
        request_space_content: tools.makeRequestSpaceContentTool({ spaces: SPACES }),
      },
    }),
    // The real one, so the reply is stored the way production stores it.
    finalizeTurn: actual.finalizeTurn,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async () => {
          const script = modelSays.perCall[modelSays.calls] ?? [FINISHED];
          modelSays.calls += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of script) controller.enqueue(part as never);
                controller.close();
              },
            }),
          };
        },
      }),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addReaderMessage: async (id: string, msg: Record<string, unknown>, settle: Settle) => {
    settles.last = settle;
    return { turnIndex: await addMessage(id, msg), closedAsks: [] };
  },
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");
const { SECOND_QUESTION_TURNED_AWAY } = await import("@server/agent/ask-result.js");

/** A call each real tool accepts. */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  ask_user: { questions: [{ header: "Style", question: "Which style?", options: [{ label: "Calm" }, { label: "Busy" }] }] },
  request_space_content: { reason: "To read the cast list.", spaces: [{ id: "c1" }] },
};

/**
 * One tool call, named `call-<tool>`.
 * @param toolName - Which tool.
 * @param input - Its arguments; the valid ones by default.
 * @returns The part.
 */
function callOf(toolName: string, input: Record<string, unknown> = VALID_INPUT[toolName]!): ModelStreamPart {
  return { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) };
}

/** What a model would say if it were given a second turn at the wheel. */
const carriesOn: ModelStreamPart[] = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Here is what I found." },
  { type: "text-end", id: "t1" },
  FINISHED,
];

/** What one turn did. */
interface Ran {
  modelCalls: number;
  chunks: Array<Record<string, unknown>>;
  reply: { parts: Array<Record<string, unknown>>; forModel: { messages: ModelMessage[] } } | undefined;
}

/**
 * Run one turn on a given script.
 * @param perCall - What the model produces, one entry per call.
 * @returns How many times the model was asked, every chunk sent, and the reply as stored.
 */
async function runTurn(perCall: ModelStreamPart[][]): Promise<Ran> {
  modelSays.perCall = perCall;
  modelSays.calls = 0;
  const chunks: Array<Record<string, unknown>> = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("what is in the cast list?", undefined, [], "UTC", { spaces: SPACES, spaces_total: 2 });
    for await (const chunk of turn) chunks.push(chunk);
  });
  const stored = addMessage.mock.calls.find((c) => (c[1] as { role?: string }).role === "assistant");
  return {
    modelCalls: modelSays.calls,
    chunks,
    reply: stored === undefined ? undefined : { parts: (stored[1] as { parts: Array<Record<string, unknown>> }).parts, forModel: stored[2] as { messages: ModelMessage[] } },
  };
}

/**
 * The stored tool part for one call.
 * @param ran - The turn.
 * @param toolCallId - The call.
 * @returns The part.
 * @throws {Error} When the reply holds no such part.
 */
function partOf(ran: Ran, toolCallId: string): Record<string, unknown> {
  const part = ran.reply?.parts.find((p) => p.type === "tool" && p.toolCallId === toolCallId);
  if (part === undefined) throw new Error(`no stored part for ${toolCallId}`);
  return part;
}

/**
 * Every tool result the stored reply keeps for the model.
 * @param ran - The turn.
 * @returns The results, in order.
 */
function keptResults(ran: Ran): Array<Record<string, unknown>> {
  return (ran.reply?.forModel.messages ?? []).flatMap((m) =>
    m.role === "tool" && Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, unknown>>) : [],
  );
}

describe("a turn that asked to read Spaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settles.last = null;
  });

  it("stops at the card instead of talking past it, and names the card on the wire", async () => {
    const ran = await runTurn([[callOf("request_space_content"), FINISHED_ASKING_FOR_A_TOOL], carriesOn]);

    expect(ran.modelCalls).toBe(1);
    expect(ran.chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "call-request_space_content" } }));
    expect(ran.chunks.some((c) => c.type === "tool-output-available")).toBe(false);
    expect(partOf(ran, "call-request_space_content")).toMatchObject({ toolName: "request_space_content", status: "awaiting" });
  });

  it("goes on when the request was refused for its arguments, so the model can read why", async () => {
    const ran = await runTurn([
      [callOf("request_space_content", { reason: "To read it.", spaces: [{ id: "not-listed" }] }), FINISHED_ASKING_FOR_A_TOOL],
      carriesOn,
    ]);

    expect(ran.modelCalls).toBe(2);
    expect(ran.chunks.some((c) => c.type === "data-ask-awaiting")).toBe(false);
  });
});

describe("two cards in one step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a questionnaire asked first and turns the Space request away under its own name", async () => {
    const ran = await runTurn([[callOf("ask_user"), callOf("request_space_content"), FINISHED_ASKING_FOR_A_TOOL], carriesOn]);

    expect(ran.modelCalls).toBe(1);
    expect(ran.chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "call-ask_user" } }));
    expect(ran.chunks).not.toContainEqual(
      expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "call-request_space_content" } }),
    );
    expect(partOf(ran, "call-ask_user")).toMatchObject({ status: "awaiting" });
    expect(partOf(ran, "call-request_space_content")).toMatchObject({ status: "error", failure: { kind: "turned_away", forModel: SECOND_QUESTION_TURNED_AWAY } });
    expect(keptResults(ran)).toEqual([
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "call-request_space_content",
        toolName: "request_space_content",
        output: expect.objectContaining({ type: "error-text" }),
      }),
    ]);
  });

  it("keeps a Space request asked first and turns the questionnaire away under its own name", async () => {
    const ran = await runTurn([[callOf("request_space_content"), callOf("ask_user"), FINISHED_ASKING_FOR_A_TOOL], carriesOn]);

    expect(ran.modelCalls).toBe(1);
    expect(ran.chunks).toContainEqual(
      expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "call-request_space_content" } }),
    );
    expect(partOf(ran, "call-request_space_content")).toMatchObject({ status: "awaiting" });
    expect(partOf(ran, "call-ask_user")).toMatchObject({ status: "error", failure: { kind: "turned_away", forModel: SECOND_QUESTION_TURNED_AWAY } });
    expect(keptResults(ran)).toEqual([
      expect.objectContaining({ type: "tool-result", toolCallId: "call-ask_user", toolName: "ask_user" }),
    ]);
  });
});

describe("a message written while a card waits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settles.last = null;
  });

  it("closes each waiting call with a result filed under that call's own tool", async () => {
    await runTurn([carriesOn]);
    const settle = settles.last;
    if (settle === null) throw new Error("the turn handed the store no settle callback");

    expect(settle("call-r", "request_space_content")).toEqual({
      output: { repliedInChat: true },
      forModel: {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-r", toolName: "request_space_content", output: { type: "json", value: { repliedInChat: true } } },
        ],
      },
    });
    expect(settle("call-a", "ask_user")).toEqual({
      output: { repliedInChat: true },
      forModel: {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-a", toolName: "ask_user", output: { type: "json", value: { repliedInChat: true } } },
        ],
      },
    });
  });
});
