// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A stored tool part always says how that use of the tool ended.
 *
 * `pending` means "still running", and a stored message is not running — it is
 * a record of something that already happened. A part left pending is a record
 * that lies, and the panel renders it as a spinner that never stops.
 *
 * Two things end a call without a result: the user stopping the turn while the
 * tool is in flight (the SDK then delivers no result for it), and the tool
 * itself failing.
 *
 * The model is the double here, and the tools are real: what these cases are
 * about is the state the SDK ends up reporting for a call, so a double for the
 * call itself would be this file deciding the answer it then checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { carrying } from "@breatic/shared";
import { z } from "zod";
import type * as CoreModule from "@breatic/core";
import { FINISHED_ASKING_FOR_A_TOOL, saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";
import type { MessagePart } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);

/** What the model produces, and how the tool behaves, for this case. */
const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  /** Raised from inside the tool, standing in for the user pressing stop. */
  stopper: undefined as AbortController | undefined,
  /** What the tool does when called. */
  toolDoes: "answers",
  /** How many times the model has been asked, this case. */
  modelCalls: 0,
  /** What the model produces from the second ask on, when a case sets it. */
  laterParts: undefined as unknown[] | undefined,
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

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: {
        web_fetch: tool({
          description: "取一个网页",
          inputSchema: z.object({ url: z.string().url() }),
          execute: async (_input: { url: string }, { abortSignal }) => {
            if (thisCase.toolDoes === "throws") {
              throw new Error("the site refused the connection");
            }
            if (thisCase.toolDoes === "throws a stop") {
              throw carrying(new Error("stopped"), {
                kind: "user_aborted",
                forModel: "the user stopped it",
                readerKey: "chat.tool.unfinished",
              });
            }
            if (thisCase.toolDoes === "throws with detail") {
              // What the real tools throw. The two halves differ on purpose:
              // a stored record that took the message would look right while
              // the carried detail was being dropped on the floor.
              throw carrying(new Error("the message"), {
                kind: "tool_failed",
                forModel: "the reason only the model gets",
                readerKey: "chat.tool.failure.upstream",
              });
            }
            if (thisCase.toolDoes === "fails, then the turn stops") {
              // The stop lands after this failure has been reported and
              // before the chunk carrying it reaches the stream. The abort is
              // queued rather than raised outright because the SDK awaits its
              // own notification between the two.
              queueMicrotask(() => thisCase.stopper?.abort());
              throw carrying(new Error("the site answered HTTP 503"), {
                kind: "tool_failed",
                forModel: "the site answered HTTP 503; do not fetch it again",
                readerKey: "chat.tool.failure.upstream",
              });
            }
            if (thisCase.toolDoes === "stops the turn") {
              thisCase.stopper?.abort();
              // Waits out the stop and then answers anyway. The already-raised
              // case is checked first because the stop above is synchronous --
              // a listener added after the fact waits for an event that has
              // been and gone.
              await new Promise<void>((resolve) => {
                if (abortSignal === undefined || abortSignal.aborted) {
                  resolve();
                  return;
                }
                abortSignal.addEventListener("abort", () => {
                  resolve();
                });
              });
            }
            return "两条链接";
          },
        }),
        // 会把这一轮停在那儿等人回答的那一类。参数要求跟真工具同形:至少两个
        // 选项,每个都得有 id 和 label —— 这是模型最容易写错的一个。
        ask_user_choice: tool({
          description: "问用户一个多选题",
          inputSchema: z.object({
            question: z.string(),
            choices: z.array(z.object({ id: z.string(), label: z.string() })).min(2),
          }),
          execute: async (input: { question: string }) => input,
        }),
      },
    }),
    finalizeTurn: async (opts: { steps: { persist?: () => Promise<void> } }) => {
      await opts.steps.persist?.();
      return [];
    },
    getModel: () =>
      modelProducing(() => {
        thisCase.modelCalls += 1;
        const later = thisCase.laterParts as ModelStreamPart[] | undefined;
        if (thisCase.modelCalls > 1 && later !== undefined) return later;
        return thisCase.parts as ModelStreamPart[];
      }),
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

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages,
}));
// The turn asks the conversation what it is called, so it can say so in the
// event that opens the turn. Answered with a name already set: these tests are
// about what a turn streams, not about how a conversation comes by its name.
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");


/** The model asking for the one tool this file registers. */
const asksForTheTool: ModelStreamPart = {
  type: "tool-call",
  toolCallId: "tc-1",
  toolName: "web_fetch",
  input: JSON.stringify({ url: "https://example.com" }),
};

/**
 * Run one turn and read back what was stored.
 * @param toolDoes - How the tool behaves this time.
 * @returns The parts of the stored assistant message, or an empty list.
 */
async function storedPartsWhenTool(
  toolDoes:
    | "answers"
    | "throws"
    | "throws with detail"
    | "throws a stop"
    | "stops the turn"
    | "fails, then the turn stops",
  input?: Record<string, unknown>,
): Promise<MessagePart[]> {
  thisCase.toolDoes = toolDoes;
  const asked =
    input === undefined
      ? asksForTheTool
      : { ...asksForTheTool, input: JSON.stringify(input) };
  thisCase.parts = [asked, FINISHED_ASKING_FOR_A_TOOL];
  const stopper = new AbortController();
  thisCase.stopper = stopper;

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("do something", stopper.signal);
    for await (const _chunk of turn) {
      // drained
    }
  });

  const reply = addMessage.mock.calls.map(([, msg]) => msg).find((m) => m.role === "assistant");
  return (reply?.parts as MessagePart[]) ?? [];
}

/**
 * The tool part of a stored message, narrowed.
 * @param parts - The stored parts
 * @returns The first tool part, or undefined
 */
function toolPart(parts: MessagePart[]): Extract<MessagePart, { type: "tool" }> | undefined {
  return parts.find((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");
}

// 每个用例都从同一个已知状态开始。继承上一个用例留下的设置,用例就到不了它
// 自己写的那个分支 —— 而它照样会绿。
beforeEach(() => {
  addMessage.mockClear();
  thisCase.modelCalls = 0;
  thisCase.laterParts = undefined;
  thisCase.stopper = undefined;
  thisCase.toolDoes = "answers";
  thisCase.parts = [];
});

describe("一次问用户的调用,参数没过 schema 的时候", () => {

  it("这一轮不停在那儿等人回答", async () => {
    // 会问用户的那两个工具,调用成功时这一轮就停下等人。判断「问过没有」用的
    // 若是「这一步有没有发起过这个调用」,那么参数被拒的那一次也算数 —— SDK 把
    // 被拒的调用照样放进 toolCalls,只是另外附一条错误。于是轮次当场结束:模型
    // 收不到那条「哪个字段不合规则」,而屏幕上没有任何东西可答。
    thisCase.parts = [
      {
        type: "tool-call",
        toolCallId: "tc-ask",
        toolName: "ask_user_choice",
        // 少了 choices,过不了 schema。
        input: JSON.stringify({ question: "要什么风格?" }),
      },
      FINISHED_ASKING_FOR_A_TOOL,
    ];
    thisCase.laterParts = saying("那我按默认的来");

    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("帮我做张海报");
      for await (const _chunk of turn) {
        // drained
      }
    });

    expect(thisCase.modelCalls).toBeGreaterThan(1);
  });
});

describe("how a tool use is recorded when it does not come back", () => {
  beforeEach(() => {
    addMessage.mockClear();
  });

  it("records a tool the SDK reported as failed", async () => {
    const parts = await storedPartsWhenTool("throws");

    const failed = toolPart(parts);
    expect(failed?.status).toBe("error");
    expect(failed?.failure?.kind).toBe("tool_failed");
    expect(failed?.failure?.forModel).toContain("refused");
  });

  it("keeps what a tool answered even when the turn was stopped around it", async () => {
    // 这个调用跑完了、也交出了答案,停止是随后落在整轮上的。SDK 先通报工具结束、
    // 再把那个 chunk 塞进流,而停在两者之间的一轮把 chunk 丢掉了 —— 于是这一格
    // 停在 pending,再没有别的时刻会把它收尾。
    //
    // 收尾时按已经拿到的答案记:这次调用花掉的东西已经花了,记成没跑过或者记成
    // 用户停掉的,下一轮都会被邀请再花一次。
    const parts = await storedPartsWhenTool("stops the turn");

    const answered = toolPart(parts);
    expect(answered).toBeDefined();
    expect(answered?.status).toBe("success");
    expect(answered?.output).toBe("两条链接");
    // 被停的是这一轮,不是这次调用,所以那件事记在轮上。少了它,回到会话里看到的
    // 是一个话说到一半、也不说为什么的答复。
    expect(parts.some((p) => p.type === "interrupted")).toBe(true);
  });

  it("records what the SDK said when it refused the call before running it", async () => {
    // The model shaped its arguments wrongly, so the SDK rejects the call at
    // `parseToolCall` and emits a tool-error itself -- `onToolExecutionEnd`
    // never fires, because nothing was executed. The reason still has to be
    // one the model can act on: it is the model's own mistake to fix.
    const parts = await storedPartsWhenTool("answers", { url: "example.com" });

    const refused = toolPart(parts);
    expect(refused?.status).toBe("error");
    expect(refused?.failure?.kind).toBe("tool_failed");
    // Something the model can act on. The wire carries the SDK's one masked
    // line for every error it streams, so a record built from that says only
    // that something went wrong -- which is the sentence this whole task
    // exists to stop the model being handed.
    expect(refused?.failure?.forModel).toMatch(/invalid|url|schema|input/i);
    expect(refused?.failure?.forModel).not.toMatch(/^An error occurred/);
    // And what it actually sent, so it can see what to correct.
    expect(refused?.input).toMatchObject({ url: "example.com" });
  });

  it("does not call a provider failure the user's doing", async () => {
    // The step ended between the model asking for the tool and the tool
    // running -- a dropped connection looks exactly like a stop from here.
    // Recording it as a stop tells the next turn the user did something they
    // never did, in the same message that also carries a `failed` mark.
    thisCase.toolDoes = "answers";
    thisCase.parts = [
      { type: "tool-input-start", id: "tc-9", toolName: "web_fetch" },
      { type: "tool-input-delta", id: "tc-9", delta: '{"url":"https://example.com"}' },
      { type: "error", error: new Error("provider connection dropped") },
    ];
    addMessage.mockClear();
    const stopper = new AbortController();
    thisCase.stopper = stopper;
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("do something", stopper.signal);
      for await (const _chunk of turn) {
        // drained
      }
    });
    const reply = addMessage.mock.calls.map(([, m]) => m).find((m) => m.role === "assistant");
    const parts = (reply?.parts as MessagePart[]) ?? [];

    expect(parts.some((p) => p.type === "failed")).toBe(true);
    expect(toolPart(parts)?.failure?.kind).not.toBe("user_aborted");
  });

  it("keeps both halves of what a tool threw, all the way to the record", async () => {
    // The joint between the two halves this file and the tool tests each
    // cover: the tool proves it throws the detail, storage proves a record
    // has one, and only this says the detail that arrives is the one thrown.
    const parts = await storedPartsWhenTool("throws with detail");

    const failed = toolPart(parts);
    expect(failed?.failure?.kind).toBe("tool_failed");
    expect(failed?.failure?.forModel).toBe("the reason only the model gets");
    expect(failed?.failure?.readerKey).toBe("chat.tool.failure.upstream");
  });

  it("carries which ending it was, not just the words", async () => {
    // The hop from the thrown detail into the record runs through `endingOf`,
    // and nothing else in the suite asks it about `kind` -- a version that
    // stamped every ending `tool_failed` passed everything.
    const parts = await storedPartsWhenTool("throws a stop");

    expect(toolPart(parts)?.failure?.kind).toBe("user_aborted");
  });

  it("keeps the tool's own reason when the stop lands after it failed", async () => {
    // The turn already knows why this call failed -- the tool reported it
    // before the stop. Recording the stop instead tells the next turn the
    // call never returned, and the model tries the same address again.
    const parts = await storedPartsWhenTool("fails, then the turn stops");

    const part = toolPart(parts);
    expect(part?.failure?.kind).toBe("tool_failed");
    expect(part?.failure?.forModel).toContain("503");
  });

  it("puts the reader's line on the wire, not a sentence in one language", async () => {
    // Until the turn is stored and read back, the wire is all the panel has.
    // The SDK's default fills this field with one fixed English sentence,
    // which is neither translatable nor specific.
    thisCase.toolDoes = "throws with detail";
    thisCase.parts = [asksForTheTool, FINISHED_ASKING_FOR_A_TOOL];
    const stopper = new AbortController();
    thisCase.stopper = stopper;

    const chunks: unknown[] = [];
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("do something", stopper.signal);
      for await (const chunk of turn) chunks.push(chunk);
    });

    const onWire = JSON.stringify(chunks);
    expect(onWire).toContain("chat.tool.failure.upstream");
    expect(onWire).not.toContain("An error occurred.");
  });

  it("still records a normal tool use as successful", async () => {
    const parts = await storedPartsWhenTool("answers");

    expect(toolPart(parts)?.status).toBe("success");
    expect(toolPart(parts)?.output).toBe("两条链接");
  });
});
