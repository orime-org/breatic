// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A turn reads the messages the user sends while it runs (inner#1717).
 *
 * Before each step that may still be followed by another, the turn takes what
 * waits and puts each message at the end of that step's request, as a user
 * message of its own; the wire says so just before the step starts, and the
 * stored reply keeps it at that place, both in its parts and in the copy the
 * next turn replays. A run whose last step said its piece with something
 * still waiting runs one more stream inside the same reply. Here the model is
 * a double whose calls are scripted, and a case puts a message in the waiting
 * list from inside the model call it wants it to follow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { tool } from "ai";
import type { UIMessageChunk } from "ai";
import { z } from "zod";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL, type ModelStreamPart } from "../helpers/model-double.js";
import type { TakenMessage, TurnEnded } from "@server/agent/taken-message.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown, _rowId?: string) => 1);
const script = vi.hoisted(() => ({
  calls: [] as Array<() => unknown[]>,
  prompts: [] as unknown[][],
  onCall: [] as Array<(() => void) | undefined>,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({ ...(base.getAgentConfig as () => Record<string, unknown>)(), max_tool_iterations: 3 }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");
  let call = 0;
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: { base: "system" },
      tools: {
        look: tool({ description: "look", inputSchema: z.object({}), execute: async () => "seen" }),
      },
    }),
    finalizeTurn: async ({ steps }: { steps: { persist: () => Promise<void> } }) => {
      await steps.persist();
      return [];
    },
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const i = call++;
          script.prompts.push(asked.prompt);
          script.onCall[i]?.();
          const parts = (script.calls[i] ?? script.calls.at(-1)!)() as ModelStreamPart[];
          return {
            stream: new ReadableStream<ModelStreamPart>({
              start(controller) {
                for (const p of parts) controller.enqueue(p);
                controller.close();
              },
            }),
          };
        },
      }),
    __resetCalls: () => {
      call = 0;
    },
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  setUserForModel: vi.fn(async () => {}),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => "named"),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");
const domain = (await import("@breatic/domain")) as unknown as { __resetCalls: () => void };

/** A step that calls the tool. */
const callsTheTool = (id: string) => (): unknown[] => [
  { type: "tool-call", toolCallId: id, toolName: "look", input: "{}" },
  FINISHED_ASKING_FOR_A_TOOL,
];

/** A step that only says something. */
const says = (text: string) => (): unknown[] => [
  { type: "text-start", id: `t-${text}` },
  { type: "text-delta", id: `t-${text}`, delta: text },
  { type: "text-end", id: `t-${text}` },
  FINISHED,
];

/**
 * A message as the run hands it over.
 * @param id - Its id.
 * @param words - What the user typed.
 * @returns The message.
 */
function taken(id: string, words: string): TakenMessage {
  return { id, sentAt: "2026-11-12T08:00:00.000Z", message: words, chips: [], space: {} };
}

let waiting: TakenMessage[] = [];

/**
 * Run one turn to its end, taking in what waits.
 * @returns Every chunk the turn wrote.
 */
async function runTurn(): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("open", undefined, [], undefined, {}, undefined, {
      messageId: "m1",
      drain: async () => {
        const got = waiting;
        waiting = [];
        return got;
      },
    });
    for await (const chunk of turn) out.push(chunk);
  });
  return out;
}

/**
 * The words of the user messages at the end of a prompt, after its last assistant or tool message.
 * @param prompt - What the model was sent.
 * @returns Their text, in order.
 */
function trailingUserWords(prompt: unknown[]): string[] {
  const msgs = prompt as Array<{ role: string; content: unknown }>;
  const lastNonUser = msgs.map((m) => m.role).lastIndexOf("tool");
  return msgs
    .slice(lastNonUser + 1)
    .filter((m) => m.role === "user")
    .map((m) => (Array.isArray(m.content) ? (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("") : String(m.content)));
}

/** The stored reply, as the last `addMessage` for the assistant was given it. */
function storedReply(): { parts: Array<Record<string, unknown>>; forModel: { messages: Array<{ role: string; content: unknown }> } } {
  const call = addMessage.mock.calls.filter((c) => (c[1] as { role: string }).role === "assistant").at(-1)!;
  return { parts: (call[1] as { parts: Array<Record<string, unknown>> }).parts, forModel: call[2] as never };
}

beforeEach(() => {
  addMessage.mockClear();
  script.calls = [];
  script.prompts = [];
  script.onCall = [];
  waiting = [];
  domain.__resetCalls();
});

describe("a message sent while the turn runs", () => {
  it("goes at the end of the next step's request, and not the step it arrived during (PS-01)", async () => {
    script.calls = [callsTheTool("tc-1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("m2", "make it blue"));
    await runTurn();
    expect(script.prompts).toHaveLength(2);
    expect(JSON.stringify(script.prompts[0])).not.toContain("make it blue");
    expect(trailingUserWords(script.prompts[1]!).join(" ")).toContain("make it blue");
  });

  it("goes as one user message each, in the order sent (PS-02)", async () => {
    script.calls = [callsTheTool("tc-1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("a", "first"), taken("b", "second"), taken("c", "third"));
    await runTurn();
    const words = trailingUserWords(script.prompts[1]!);
    expect(words).toHaveLength(3);
    expect(words[0]).toContain("first");
    expect(words[1]).toContain("second");
    expect(words[2]).toContain("third");
  });

  it("is left waiting for the next run when the next step is the turn's last (PS-03)", async () => {
    script.calls = [callsTheTool("tc-1"), callsTheTool("tc-2"), callsTheTool("tc-3")];
    script.onCall[1] = () => waiting.push(taken("m3", "late one"));
    await runTurn();
    expect(script.prompts).toHaveLength(3);
    expect(JSON.stringify(script.prompts[2])).not.toContain("late one");
    expect(waiting.map((w) => w.id)).toEqual(["m3"]);
  });

  it("is said on the wire just before the step that reads it starts (PS-13)", async () => {
    script.calls = [callsTheTool("tc-1"), says("done")];
    script.onCall[0] = () => waiting.push({ ...taken("m2", "make it blue"), chips: [] });
    const chunks = await runTurn();
    const at = chunks.findIndex((c) => c.type === "data-user-message");
    expect(chunks[at]).toEqual({
      type: "data-user-message",
      data: { id: "m2", words: "make it blue", chips: [], sentAt: "2026-11-12T08:00:00.000Z" },
    });
    expect(chunks[at + 1]?.type).toBe("start-step");
    expect(chunks.filter((c) => c.type === "start-step").length).toBe(2);
  });

  it("is stored in the reply where it was read, in its parts and in the copy the next turn replays (PS-18)", async () => {
    script.calls = [callsTheTool("tc-1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("m2", "make it blue"));
    await runTurn();
    const { parts, forModel } = storedReply();
    const types = parts.map((p) => p.type);
    expect(types.indexOf("user-message")).toBeGreaterThan(types.indexOf("tool"));
    expect(types.indexOf("user-message")).toBeLessThan(types.lastIndexOf("text"));
    expect(parts.filter((p) => p.type === "user-message")).toEqual([
      { type: "user-message", id: "m2", sentAt: "2026-11-12T08:00:00.000Z", parts: [{ type: "text", text: "make it blue" }] },
    ]);
    const roles = forModel.messages.map((m) => m.role);
    const userAt = roles.indexOf("user");
    expect(userAt).toBeGreaterThan(roles.indexOf("tool"));
    expect(JSON.stringify(forModel.messages[userAt])).toContain("make it blue");
    expect(roles.slice(userAt + 1)).toContain("assistant");
  });
});

describe("the reply's id", () => {
  it("opens the stream and names the stored reply, once for a reply that carried on", async () => {
    script.calls = [says("first answer"), says("second answer")];
    script.onCall[0] = () => waiting.push(taken("m2", "and one more thing"));
    const chunks = await runTurn();
    const starts = chunks.filter((c) => c.type === "start");
    expect(starts).toHaveLength(1);
    expect(chunks[0]).toBe(starts[0]);
    const named = (starts[0] as { messageId?: string }).messageId;
    expect(named).toMatch(/^[0-9a-f-]{36}$/);
    const stored = addMessage.mock.calls.filter((c) => (c[1] as { role: string }).role === "assistant").at(-1)!;
    expect(stored[3]).toBe(named);
  });
});

describe("a turn that said its piece with something still waiting", () => {
  it("runs one more stream in the same reply for what arrived during its last step (PS-05)", async () => {
    script.calls = [says("first answer"), says("second answer")];
    script.onCall[0] = () => waiting.push(taken("m2", "and one more thing"));
    const chunks = await runTurn();
    expect(script.prompts).toHaveLength(2);
    expect(trailingUserWords(script.prompts[1]!).join(" ")).toContain("and one more thing");
    expect(addMessage.mock.calls.filter((c) => (c[1] as { role: string }).role === "assistant")).toHaveLength(1);
    expect(storedReply().parts.filter((p) => p.type === "user-message").map((p) => p.id)).toEqual(["m2"]);
    expect(chunks.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("sends the step before it as it was, thinking included, when it carries on", async () => {
    script.calls = [
      () => [
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "weighing it up" },
        { type: "reasoning-end", id: "r1" },
        ...says("first answer")(),
      ],
      says("second answer"),
    ];
    script.onCall[0] = () => waiting.push(taken("m2", "and one more thing"));
    await runTurn();
    expect(script.prompts).toHaveLength(2);
    expect(JSON.stringify(script.prompts[1])).toContain("weighing it up");
  });

  it("ends when nothing waits (PS-06)", async () => {
    script.calls = [says("only answer")];
    await runTurn();
    expect(script.prompts).toHaveLength(1);
  });
});

describe("a turn stopped while it takes a message in", () => {
  it("tells the run the message was not recorded, so it is not dropped as answered", async () => {
    const stop = new AbortController();
    const ended: TurnEnded[] = [];
    script.calls = [callsTheTool("tc-1"), says("never asked")];
    script.onCall[0] = () => waiting.push(taken("m2", "make it blue"));
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("open", stop.signal, [], undefined, {}, undefined, {
        messageId: "m1",
        // The stop lands after the message left the queue and before the
        // turn has written it anywhere.
        drain: async () => {
          const got = waiting;
          waiting = [];
          if (got.length > 0) stop.abort();
          return got;
        },
        onEnded: (e) => ended.push(e),
      });
      for await (const _ of turn) void _;
    });
    expect(ended).toHaveLength(1);
    expect(ended[0]?.recorded).toEqual(["m1"]);
    expect(storedReply().parts.filter((p) => p.type === "user-message")).toEqual([]);
  });

  it("names every message it recorded, the opening and those it took in", async () => {
    const ended: TurnEnded[] = [];
    script.calls = [callsTheTool("tc-1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("m2", "make it blue"));
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("open", undefined, [], undefined, {}, undefined, {
        messageId: "m1",
        drain: async () => {
          const got = waiting;
          waiting = [];
          return got;
        },
        onEnded: (e) => ended.push(e),
      });
      for await (const _ of turn) void _;
    });
    expect(ended[0]?.recorded).toEqual(["m1", "m2"]);
  });
});

describe("a turn stopped right after taking a message in", () => {
  it("keeps the message in the stored reply once, where it was taken (PS-12)", async () => {
    const stop = new AbortController();
    script.calls = [callsTheTool("tc-1"), () => {
      stop.abort();
      return [];
    }];
    script.onCall[0] = () => waiting.push(taken("m2", "make it blue"));
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("open", stop.signal, [], undefined, {}, undefined, {
        messageId: "m1",
        drain: async () => {
          const got = waiting;
          waiting = [];
          return got;
        },
      });
      for await (const _ of turn) void _;
    });
    expect(storedReply().parts.filter((p) => p.type === "user-message").map((p) => p.id)).toEqual(["m2"]);
  });
});
