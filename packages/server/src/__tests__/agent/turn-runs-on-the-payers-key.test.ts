// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A chat turn runs on the keys of whoever pays for the project's Studio (inner#1953): with that account's OpenRouter
 * key set, the turn's model calls go out on it, the usage rows are written under the key row's id at no credits, the
 * turn is not charged, and the reply records the key row's id beside the upstream that served it, never the key. A
 * segment resumed by an answer to its card runs on the key row the paused segment recorded; once that row is gone
 * (replaced or deleted), the segment ends failed, saying so, and is never moved to the deployment's key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type { MockLanguageModelV4 } from "ai/test";
import { finishedSpending } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const ACCOUNT_KEY = "sk-or-v1-account-key-never-stored";
const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? ACCOUNT_KEY : undefined) };
const DEPLOYMENT = { owner: "deployment" as const, keyOf: () => undefined };

const h = vi.hoisted(() => ({
  addMessage: vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 1),
  chargeOnce: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  resolveKeys: vi.fn(),
  keysById: vi.fn(),
  failWith: { value: undefined as Error | undefined },
  model: undefined as MockLanguageModelV4 | undefined,
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
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  const { modelProducing, modelFailingToStart } = await import("../helpers/model-double.js");
  const parts = (): ModelStreamPart[] => [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Done." },
    { type: "text-end", id: "t1" },
    finishedSpending(100),
  ];
  /**
   * The usage recorder as the real one counts: a row of a call on an account's key is no credits.
   * @param options - What the turn opens it with.
   * @returns The recorder.
   */
  const recorder = (options: { operationKey: string; feature: string; actorUserId: string; projectId: string | null; keyId?: string | null }): unknown => {
    let credits = 0;
    const { operationKey, feature, actorUserId, projectId } = options;
    return {
      operation: { operationKey, feature, actorUserId, projectId },
      recordModelCall: (call: { cost: { tokens?: { input: number; output: number } } }) => {
        if (options.keyId === undefined || options.keyId === null) credits += (call.cost.tokens?.input ?? 0) + (call.cost.tokens?.output ?? 0);
      },
      recordServiceCall: () => {},
      recordLookedUpCall: () => {},
      awaitingLookup: () => [],
      settle: async () => credits,
      settleForCharge: async () => ({ credits, writeFailures: [] }),
    };
  };
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    buildAgentConfig: async () => ({ modelId: "deepseek/deepseek-v4.1-flash-1017", instructions: { base: "system" }, tools: {} }),
    creditLotService: { chargeOnce: h.chargeOnce },
    createUsageRecorder: vi.fn(recorder),
    resolveKeys: h.resolveKeys,
    keysById: h.keysById,
    provider: (await import("../helpers/fake-provider.js")).fakeProvider(() => {
      h.model = h.failWith.value === undefined ? modelProducing(parts) : modelFailingToStart(h.failWith.value);
      return h.model;
    }),
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});
vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: h.addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await h.addMessage(id, msg), closedAsks: [] }),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  setUserForModel: vi.fn(async () => undefined),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");
const domain = await import("@breatic/domain");

/** What the turn put on the wire. */
const sent: Array<{ type: string; data?: unknown }> = [];

/**
 * Run a stream to its end.
 * @param open - Opens the turn.
 */
async function drain(open: () => Promise<ReadableStream<unknown>>): Promise<void> {
  sent.length = 0;
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const chunk of await open()) sent.push(chunk as { type: string });
  });
}

/**
 * The prepared call's arguments.
 * @returns The arguments `provider().llm.prepare` was last called with.
 */
function prepared(): unknown[] {
  const { llm } = domain.provider() as unknown as { llm: { prepare: { mock: { calls: unknown[][] } } } };
  return llm.prepare.mock.calls.at(-1) ?? [];
}

/**
 * What the reply was recorded with for the model.
 * @returns The reply's model-side record.
 */
function replyRecord(): Record<string, unknown> | undefined {
  const reply = h.addMessage.mock.calls.find((call) => call[1].role === "assistant");
  return reply?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.failWith.value = undefined;
  h.resolveKeys.mockResolvedValue({ keys: ACCOUNT, keyId: "key-1", route: { mode: "default" } });
  h.keysById.mockResolvedValue({ keys: ACCOUNT, accountId: "u-admin" });
});

describe("a chat turn on the payer's OpenRouter key", () => {
  it("asks for the payer's language-model keys and sends the turn on them", async () => {
    await drain(() => new MainAgent().chat("hi"));

    expect(h.resolveKeys).toHaveBeenCalledWith({ projectId: "p1" }, { kind: "llm" });
    expect(prepared()[3]).toBe(ACCOUNT);
  });

  it("records its usage under the key row and charges no credits", async () => {
    await drain(() => new MainAgent().chat("hi"));

    expect(vi.mocked(domain.createUsageRecorder)).toHaveBeenCalledWith(expect.objectContaining({ feature: "chat_turn", keyId: "key-1" }));
    expect(h.chargeOnce).not.toHaveBeenCalled();
  });

  it("records the key row's id in the reply, never the key", async () => {
    await drain(() => new MainAgent().chat("hi"));

    expect(replyRecord()).toMatchObject({ keyId: "key-1" });
    expect(JSON.stringify(h.addMessage.mock.calls)).not.toContain(ACCOUNT_KEY);
  });

  it("is charged, and records no key row, on the deployment's keys", async () => {
    h.resolveKeys.mockResolvedValue({ keys: DEPLOYMENT, keyId: null, route: { mode: "default" } });
    await drain(() => new MainAgent().chat("hi"));

    expect(h.chargeOnce).toHaveBeenCalledTimes(1);
    expect(replyRecord()).not.toHaveProperty("keyId");
  });

  it("ends failed, naming the account key's failure, when the payer's key is refused, and is not charged", async () => {
    h.failWith.value = Object.assign(new Error("Insufficient credits"), { kind: "account_key_failed", reason: "no_balance", upstream: "openrouter" });
    await drain(() => new MainAgent().chat("hi"));

    expect(sent).toContainEqual(expect.objectContaining({
      type: "data-failed",
      data: expect.objectContaining({ reason: "account_key_failed", upstream: "openrouter", keyReason: "no_balance" }),
    }));
    expect(h.chargeOnce).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toContain(ACCOUNT_KEY);
  });
});

describe("a segment resumed by an answer to its card", () => {
  it("runs on the key row the paused segment recorded, not on a fresh resolution", async () => {
    await drain(() => new MainAgent().answer("ask-1", { answers: [] }, 3, undefined, "UTC", {}, "deepseek/deepseek-v4.1-flash-1017", "openrouter", { resumeKeyId: "key-1" } as never));

    expect(h.keysById).toHaveBeenCalledWith("key-1");
    expect(h.resolveKeys).not.toHaveBeenCalled();
    expect(prepared()[3]).toBe(ACCOUNT);
    expect(replyRecord()).toMatchObject({ keyId: "key-1", servedUpstream: expect.any(String) });
  });

  it("ends failed with account_key_missing once that row is replaced or deleted, asking no model and using no other key", async () => {
    h.keysById.mockRejectedValue(Object.assign(new Error("the key row is gone"), { kind: "account_key_missing" }));
    await drain(() => new MainAgent().answer("ask-1", { answers: [] }, 3, undefined, "UTC", {}, "deepseek/deepseek-v4.1-flash-1017", "openrouter", { resumeKeyId: "key-1" } as never));

    expect(sent).toContainEqual(expect.objectContaining({ type: "data-failed", data: expect.objectContaining({ reason: "account_key_missing" }) }));
    expect(h.model?.doStreamCalls ?? []).toHaveLength(0);
    expect(h.resolveKeys).not.toHaveBeenCalled();
    expect(h.chargeOnce).not.toHaveBeenCalled();
  });
});
