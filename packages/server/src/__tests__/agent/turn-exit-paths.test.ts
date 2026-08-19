// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a turn hands the model, and what it leaves behind however it ends.
 *
 * Two subjects, and they meet in the same place: both are things that are
 * true of a turn from the outside, and neither is visible in what it streams.
 * A turn that reached the model with no tools looks, on the wire, exactly
 * like one whose model chose not to call any. A turn that was stopped
 * half-way looks, on a reload, exactly like one that finished with little to
 * say -- unless the record says otherwise.
 *
 * Stopping is driven by a signal here rather than by anything the model
 * produces, because that is how it happens: the reader presses stop or the
 * page goes, the route raises the signal, and the SDK ends the turn. There is
 * no part a model can send that means "the user left".
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 5.1.3, 5.1.4. Acceptance A13, A15.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type { MockLanguageModelV4 } from "ai/test";
import { FINISHED, finishedSpending } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async (..._args: unknown[]) => undefined);
const buildAgentConfig = vi.hoisted(() => vi.fn());

/**
 * What the model produces, and the model it produced it on.
 *
 * `endsOnItsOwn` is false for the cases about stopping: a stream that closes
 * has already decided how the turn ends, and what those cases are about is a
 * turn ended from outside while the model still had more to say.
 */
const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  endsOnItsOwn: true,
  model: undefined as MockLanguageModelV4 | undefined,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
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
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  const { MockLanguageModelV4 } = await import("ai/test");
  // Wrapped rather than replaced: what goes into the factory is what these
  // cases read, and what comes out is still the real thing.
  buildAgentConfig.mockImplementation(actual.buildAgentConfig);
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    buildAgentConfig,
    creditService: { deductOnce },
    resolveProvider: () => "test",
    getModel: () => {
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream({
            start(controller) {
              for (const part of thisCase.parts) controller.enqueue(part as never);
              if (thisCase.endsOnItsOwn) {
                controller.close();
                return;
              }
              // Left open, and closed by the stop instead. A provider's
              // connection ends when the request is aborted, and a double
              // that ignored the signal would leave the turn waiting on a
              // stream nothing can end.
              abortSignal?.addEventListener("abort", () => {
                controller.close();
              });
            },
          }),
        }),
      });
      thisCase.model = model;
      return model;
    },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages,
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/**
 * One step of prose, with the tokens it spent.
 * @param text - What the model says.
 * @param spent - Output tokens for the step.
 * @returns The parts of one finished step.
 */
function saidAndSpent(text: string, spent: number): ModelStreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finishedSpending(spent),
  ];
}

/**
 * Run one turn to the end of its stream.
 * @param parts - What the model produces.
 */
async function runTurn(parts: ModelStreamPart[]): Promise<void> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  thisCase.parts = parts;
  thisCase.endsOnItsOwn = true;
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const _chunk of await new MainAgent().chat("hi")) {
      // drained
    }
  });
}

/**
 * Run one skill command to the end of its stream.
 * @param skillName - Which skill was asked for.
 */
async function runSkillTurn(skillName: string): Promise<void> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  thisCase.parts = saidAndSpent("hi", 100);
  thisCase.endsOnItsOwn = true;
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const _chunk of await new MainAgent().handleSkillCommand(skillName, "go")) {
      // drained
    }
  });
}

/**
 * Run one turn and stop it from outside, part way through.
 *
 * The model is left with more to say, which is the situation being recorded:
 * a stream that had already closed would make the stop arrive after the fact.
 * @param parts - What the model produces before the stop.
 * @param stopOnce - Press stop once a chunk of this type has arrived, or
 *   straight away when absent.
 */
async function runAndStop(parts: ModelStreamPart[], stopOnce?: string): Promise<void> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  thisCase.parts = parts;
  thisCase.endsOnItsOwn = false;

  const stop = new AbortController();
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const reader = (await new MainAgent().chat("hi", stop.signal)).getReader();
    // Waited for by what arrived rather than by how many, because how many
    // chunks stand between the start of a stream and its first word is the
    // protocol's business and changes with it.
    if (stopOnce !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((value as { type: string }).type === stopOnce) break;
      }
    }
    stop.abort();
    // Read on to the end: the stream is ending because of the stop, and what
    // the turn does about it happens as it finishes.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
}

/**
 * The assistant messages a turn wrote as its wrap-up.
 * @returns The wrap-up messages, in the order they were written.
 */
function wrapUpMessages(): Array<Record<string, unknown>> {
  return addMessage.mock.calls.map(([, msg]) => msg).filter((msg) => msg.role === "assistant");
}

beforeEach(() => {
  [addMessage, consolidateIfNeeded, deductOnce, buildAgentConfig].forEach((m) => {
    m.mockClear();
  });
});

describe("what a plain chat turn hands the model", () => {
  // Read off the model's own call rather than off the argument to
  // `streamText`. The defect being fixed was that `chat()` passed an empty
  // tool set, and where that shows is at the far end: a tool set that never
  // made it that far is a tool the model cannot call.
  it("gives it the six baseline tools, and only those", async () => {
    await runTurn(saidAndSpent("hi", 100));

    const called = thisCase.model?.doStreamCalls[0];
    const names = (called?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "ask_user_choice",
      "ask_user_question",
      "propose_canvas_action",
      "show_search_results",
      "web_fetch",
      "web_search",
    ]);
  });

  it("marks the turn interactive, which is what keeps the interaction tools in", async () => {
    // The reason rather than the outcome, and the two are not the same test:
    // the interaction tools would still be in that set if the filter stopped
    // applying altogether, so asserting on the set cannot tell the two apart.
    await runTurn(saidAndSpent("hi", 100));
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({ interactive: true });
  });
});

describe("what a skill command hands the model", () => {
  // The other of the two entry points, and the one with nothing watching it:
  // deleting `skillName` from its factory call left every test and typecheck
  // green, because `skillName` is optional and the route tests stop at
  // 403/404.
  // The factory itself is stubbed for these two: the real one would look the
  // fixture skill up in a registry that has no skills under the test root.
  const stubConfig = { modelId: "m", instructions: "s", tools: {} };

  it("names the skill it was asked for", async () => {
    buildAgentConfig.mockReturnValueOnce(stubConfig);
    await runSkillTurn("creative_research");
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({
      skillName: "creative_research",
    });
  });

  it("marks it interactive and passes the caller's prompt and memory", async () => {
    // All four arguments, so dropping any one of them goes red here. The
    // skill path used to assemble its own instructions and drifted from chat
    // on every value; passing them is what stopped that.
    buildAgentConfig.mockReturnValueOnce(stubConfig);
    await runSkillTurn("creative_research");
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({
      skillName: "creative_research",
      interactive: true,
      basePrompt: "system",
    });
  });
});

describe("a turn that failed", () => {
  it("records that it failed, so a reload does not read it as a finished answer", async () => {
    // A stopped turn leaves a mark on the stored reply. A failed one has to
    // as well, or the two look identical once the page is reloaded: half an
    // answer that simply stops, with nothing to say it never got to finish.
    await runTurn([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Half a sen" },
      { type: "text-end", id: "t1" },
      { type: "error", error: new Error("401 expired key") },
      FINISHED,
    ]);

    const parts = wrapUpMessages().at(-1)?.parts as Array<{ type: string }> | undefined;
    expect(parts?.map((p) => p.type)).toContain("failed");
  });

  it("stores a turn that failed before the model said anything", async () => {
    // Nothing was written, so there is nothing but the mark -- and without it
    // no message is stored at all, leaving what the user said sitting alone
    // with no answer and no explanation.
    await runTurn([{ type: "error", error: new Error("401 expired key") }, FINISHED]);

    expect(wrapUpMessages()).toHaveLength(1);
  });

  it("does not make the user wait for memory consolidation", async () => {
    // Consolidation is an LLM call of its own, seconds long, and nobody is
    // waiting for it -- the user is waiting for the turn to be over. Putting
    // it in front of the ending leaves the panel spinning on a reply that
    // has already finished streaming.
    //
    // The race is the assertion: a consolidation that never finishes must not
    // hold the ending. Everything else in this path is mocked, so the only
    // thing that can take 200ms is an await on that promise.
    consolidateIfNeeded.mockReturnValueOnce(new Promise<undefined>(() => {}));
    await Promise.race([
      runTurn(saidAndSpent("hi", 100)),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(new Error("the turn waited for consolidation"));
        }, 200),
      ),
    ]);
    expect(consolidateIfNeeded).toHaveBeenCalled();
  });
});

describe("a turn the user stopped", () => {
  it("keeps what was generated even when no prose was streamed yet", async () => {
    // Storing nothing here is what makes a stop look, to the user coming
    // back, exactly like a turn that never happened.
    await runAndStop([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "half a s" },
    ]);

    const wrapUps = wrapUpMessages();
    expect(wrapUps).toHaveLength(1);
    expect(wrapUps[0]?.parts).toContainEqual({ type: "interrupted" });
  });

  it("keeps the prose it had already written", async () => {
    await runAndStop(
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "half a s" },
      ],
      "text-delta",
    );

    const stored = wrapUpMessages()[0];
    expect(stored?.parts).toContainEqual({ type: "text", text: "half a s" });
    expect(stored?.parts).toContainEqual({ type: "interrupted" });
  });

  it("survives a stop that lands before any step finished", async () => {
    // The earliest possible stop. `result.totalUsage` rejects with an
    // AbortError in this case, so a turn that awaited it anywhere would end
    // on an unhandled rejection instead of an ending. Nothing here reads it,
    // and this is what says so.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await runAndStop([{ type: "text-start", id: "t1" }]);

      // Nothing finished, so nothing is owed.
      expect(deductOnce).not.toHaveBeenCalled();
      // Still a record: the turn happened, and it was stopped.
      expect(wrapUpMessages()).toHaveLength(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
