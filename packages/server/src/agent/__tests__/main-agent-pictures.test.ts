// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool, wrapLanguageModel } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type * as Core from "@breatic/core";
import type { ChatAttachedChip, MessageData } from "@breatic/shared";
import type { AgentPicture, AgentPictureOutput, PreparedAgentPicture } from "@breatic/domain";
import type { RequestPrefix, ReplyForModel } from "@server/agent/history-replay.js";
import { prefixHash } from "@server/agent/history-replay.js";
import { FINISHED_ASKING_FOR_A_TOOL, saying } from "../../__tests__/helpers/model-double.js";
import type { ModelStreamPart } from "../../__tests__/helpers/model-double.js";

const h = vi.hoisted(() => ({
  prepare: vi.fn(), makePreparer: vi.fn(), fold: vi.fn(), context: vi.fn(),
  add: vi.fn(), setUser: vi.fn(),
  history: [] as Array<MessageData & { forModel: unknown }>,
  prompts: [] as unknown[], byCall: [] as unknown[][],
  tools: {}, maxPictures: 2, maxBytes: 20_971_520, sizes: new Map<number, number>(), turnIndex: 7,
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../../__tests__/helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof Core>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});
vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../../__tests__/helpers/mock-core.js");
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../../__tests__/helpers/model-double.js");
  return {
    ...actual,
    ...domainMock(),
    finalizeTurn: actual.finalizeTurn,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: async () => ({
      modelId: "test", instructions: { base: "system" }, tools: h.tools,
      seesPictures: true,
      picturePolicy: { seesPictures: true, maxPictures: h.maxPictures, maxBytes: h.maxBytes, pictureTokensEstimate: 1000 },
    }),
    getModel: () => wrapLanguageModel({
      model: modelProducing(
        () => (h.byCall[h.prompts.length - 1] ?? saying("done")) as ModelStreamPart[],
        (request) => h.prompts.push(request.prompt),
      ),
      middleware: actual.pictureMiddleware as Parameters<typeof wrapLanguageModel>[0]["middleware"],
    }),
  };
});
vi.mock("@server/agent/turn-context.js", () => ({ buildTurnContext: h.context }));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: h.fold }));
vi.mock("@server/agent/prepare-pictures.js", () => ({
  picturePreparerFor: h.makePreparer,
  pictureSourcesForTurn: (chips: readonly ChatAttachedChip[]) => chips.flatMap((chip, index) =>
    chip.type === "image" && typeof chip.data_snapshot.url === "string"
      ? [{ label: `Attachment ${String(index + 1)}: ${chip.name}`, sourceUrl: chip.data_snapshot.url }]
      : [],
  ),
}));
vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: h.add,
  addReaderMessage: async (id: string, message: Record<string, unknown>) => ({ turnIndex: await h.add(id, message), closedAsks: [] }),
  setUserForModel: h.setUser,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ titleForTurn: vi.fn(async () => null) }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/** Registered facts already confirmed by the ingest Worker. */
function picture(index: number): AgentPicture {
  return {
    label: `Attachment ${String(index + 1)}: photo ${String(index)}`,
    sourceUrl: `https://source.example/${String(index)}.bin`,
    url: `https://media.example/${String(index)}.agent-v1-1024-q85.jpg`,
    mediaType: "image/jpeg", sizeBytes: h.sizes.get(index) ?? 1000,
  };
}

/** The fixed request seed used by the mocked model factory. */
function prefix(): RequestPrefix {
  return {
    modelId: "test", instructions: { base: "system" }, tools: h.tools,
    picturePolicy: { seesPictures: true, maxPictures: h.maxPictures, maxBytes: h.maxBytes, pictureTokensEstimate: 1000 },
  };
}

/** One explicit uploaded picture attachment. */
function chip(index: number): ChatAttachedChip {
  return { id: `a${String(index)}`, type: "image", name: `photo ${String(index)}`, data_snapshot: { url: picture(index).sourceUrl } };
}

/** Run the actual MainAgent and SDK orchestration to completion. */
async function run(chips: ChatAttachedChip[] = [], signal?: AbortSignal): Promise<void> {
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const _chunk of await new MainAgent().chat("compare", signal, chips, "UTC")) void _chunk;
  });
}

/** The provider boundary's actual native image URLs, in occurrence order. */
function urls(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((message: { content?: unknown }) => Array.isArray(message.content)
    ? message.content.flatMap((part: { type?: string; mediaType?: string; data?: { type?: string; url?: unknown } }) =>
      part.type === "file" && part.mediaType?.startsWith("image/") && part.data?.type === "url" ? [String(part.data.url)] : [],
    )
    : [],
  );
}

/** What this turn actually persisted as its reply, including logical originals. */
function keptReply(): ReplyForModel {
  const written = h.add.mock.calls.find((call) => (call[1] as { role: string }).role === "assistant");
  if (written === undefined) throw new Error("no reply persisted");
  return written[2] as ReplyForModel;
}

/** A step with signed thinking, followed by one real SDK-executed tool call. */
function asks(id: string, thought: string): ModelStreamPart[] {
  return [
    { type: "reasoning-start", id: `reason-${id}` },
    { type: "reasoning-delta", id: `reason-${id}`, delta: thought },
    { type: "reasoning-end", id: `reason-${id}`, providerMetadata: { anthropic: { signature: id } } },
    { type: "tool-call", toolCallId: id, toolName: "lookup", input: "{}" },
    FINISHED_ASKING_FOR_A_TOOL,
  ];
}

beforeEach(() => {
  h.history = [];
  h.prompts = [];
  h.byCall = [];
  h.tools = {};
  h.maxPictures = 2;
  h.maxBytes = 20_971_520;
  h.sizes.clear();
  h.turnIndex = 7;
  h.add.mockReset().mockImplementation(async () => h.turnIndex);
  h.setUser.mockReset().mockResolvedValue(undefined);
  h.fold.mockReset().mockResolvedValue("none");
  h.context.mockReset().mockImplementation(async () => ({ memoryContext: { projectMemory: "", conversationMemory: "" }, history: h.history, watermark: 0 }));
  h.makePreparer.mockReset().mockReturnValue(h.prepare);
  h.prepare.mockReset().mockImplementation(async (sources: Array<{ label: string; sourceUrl: string }>): Promise<PreparedAgentPicture[]> => sources.map((source) => {
    const index = Number(new URL(source.sourceUrl).pathname.split("/").pop()?.split(".")[0]);
    return { status: "ready", ...picture(index), ...source };
  }));
});

describe("MainAgent picture preparation and each actual model request", () => {
  it("prepares attachments once before the model even when a fold reassembles the turn", async () => {
    h.fold.mockResolvedValueOnce("moved");

    await run([chip(0)]);

    expect(h.context).toHaveBeenCalledTimes(2);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.makePreparer).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(1);
    expect(urls(h.prompts[0])).toEqual([picture(0).url]);
    expect(h.prepare.mock.invocationCallOrder[0]).toBeLessThan(h.setUser.mock.invocationCallOrder[0]!);
  });

  it("starts no model request and accepts no late picture after stopping while preparation waits", async () => {
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let release: ((value: PreparedAgentPicture[]) => void) | undefined;
    h.prepare.mockImplementationOnce(async (_sources: unknown, signal?: AbortSignal) => {
      began?.();
      return new Promise<PreparedAgentPicture[]>((resolve, reject) => {
        release = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const running = run([chip(0)], controller.signal);
    await started;
    controller.abort();
    await running;
    release?.([{ status: "ready", ...picture(0) }]);
    await Promise.resolve();

    expect(h.prompts).toEqual([]);
    expect(h.setUser).not.toHaveBeenCalled();
  });

  it("drops old input pictures before checking an old reply's signed thinking", async () => {
    const oldPictures = [picture(0), picture(1)];
    const asked: ModelMessage = { role: "user", content: oldPictures.map((one) => ({ type: "file", mediaType: one.mediaType, data: one.url })) };
    const answered: ModelMessage = { role: "assistant", content: [
      { type: "reasoning", text: "old signed thought", providerOptions: { anthropic: { signature: "old" } } },
      { type: "text", text: "old answer" },
    ] };
    h.history = [
      { role: "user", content: "old", parts: [], ts: "", turnIndex: 6, forModel: { messages: [asked], pictures: oldPictures } },
      { role: "assistant", content: "old answer", parts: [], ts: "", turnIndex: 6, forModel: { messages: [answered], prefixHash: prefixHash(prefix(), [asked]), turnTokens: 2000, endTokens: 3000 } },
    ];
    const original = JSON.stringify(h.history);

    await run([chip(2)]);

    expect(urls(h.prompts[0])).toEqual([picture(1).url, picture(2).url]);
    expect(JSON.stringify(h.prompts[0])).not.toContain("old signed thought");
    expect(JSON.stringify(h.prompts[0])).not.toContain('"signature":"old"');
    expect(JSON.stringify(h.prompts[0])).toContain(picture(0).sourceUrl);
    expect(JSON.stringify(h.history)).toBe(original);
  });

  it("reprojects newly returned tool pictures before the next SDK step and preserves later valid thinking", async () => {
    const toolPictures = [picture(2), picture(3), picture(4)];
    let executed = 0;
    h.tools = {
      lookup: tool({
        description: "Look up pictures.", inputSchema: z.object({}),
        execute: async (): Promise<AgentPictureOutput | string> => {
          executed += 1;
          return executed === 1 ? { kind: "agent-pictures-v1", text: "three images", pictures: toolPictures } : "checked";
        },
        toModelOutput: ({ output }) => typeof output === "string" ? { type: "text", value: output } : { type: "json", value: output },
      }),
    };
    h.byCall = [asks("c1", "early thought becomes invalid"), asks("c2", "later thought remains valid"), saying("done")];

    await run([chip(0), chip(1)]);

    expect(h.prompts).toHaveLength(3);
    expect(urls(h.prompts[0])).toEqual([picture(0).url, picture(1).url]);
    expect(urls(h.prompts[1])).toEqual([picture(1).url, ...toolPictures.map((one) => one.url)]);
    expect(JSON.stringify(h.prompts[1])).not.toContain("early thought becomes invalid");
    expect(JSON.stringify(h.prompts[2])).not.toContain("early thought becomes invalid");
    expect(JSON.stringify(h.prompts[2])).toContain("later thought remains valid");
    const kept = keptReply();
    expect(JSON.stringify(kept.messages)).toContain("early thought becomes invalid");
    expect(kept.pictures).toEqual(toolPictures);
    expect(kept.steps?.map((step) => [step.messageStart, step.messageEnd])).toEqual([[0, 2], [2, 4], [4, 5]]);
    expect(kept.countCoverage).toEqual({ version: 1 });
  });

  it("keeps byte-omitted pictures omitted for the rest of the SDK turn and restores their originals next turn", async () => {
    h.maxPictures = 4;
    h.maxBytes = 100;
    h.sizes = new Map([[0, 15], [1, 15], [2, 20], [3, 20], [4, 20], [5, 20], [6, 1], [7, 1], [8, 1]]);
    const firstBatch = [2, 3, 4, 5].map(picture);
    const secondBatch = [6, 7, 8].map(picture);
    const batches = [firstBatch, secondBatch];
    let executed = 0;
    h.tools = {
      lookup: tool({
        description: "Look up pictures.", inputSchema: z.object({}),
        execute: async (): Promise<AgentPictureOutput> => ({ kind: "agent-pictures-v1", text: "results", pictures: batches[executed++]! }),
        toModelOutput: ({ output }) => ({ type: "json", value: output }),
      }),
    };
    h.byCall = [asks("c1", "before byte eviction"), asks("c2", "generated after byte eviction"), saying("done")];

    await run([chip(0), chip(1)]);

    expect(h.prompts).toHaveLength(3);
    expect(urls(h.prompts[0])).toEqual([picture(0).url, picture(1).url]);
    expect(urls(h.prompts[1])).toEqual([picture(4).url, picture(5).url]);
    expect(urls(h.prompts[2])).toEqual([4, 5, 6, 7, 8].map((index) => picture(index).url));
    expect(JSON.stringify(h.prompts[2])).toContain(picture(2).sourceUrl);
    expect(JSON.stringify(h.prompts[2])).toContain(picture(3).sourceUrl);
    expect(JSON.stringify(h.prompts[2])).not.toContain("before byte eviction");
    expect(JSON.stringify(h.prompts[2])).toContain("generated after byte eviction");
    const savedUser = h.setUser.mock.calls[0]![2] as { messages: ModelMessage[]; pictures: AgentPicture[] };
    const savedReply = keptReply();
    expect(savedReply.pictures).toEqual([...firstBatch, ...secondBatch]);
    expect(JSON.stringify(savedReply.messages)).toContain(picture(2).url);
    expect(JSON.stringify(savedReply.messages)).toContain(picture(3).url);
    expect(savedUser.pictures.map((one) => one.url)).toEqual([picture(0).url, picture(1).url]);

    h.history = [
      { role: "user", content: "compare", parts: [], ts: "", turnIndex: 7, forModel: JSON.parse(JSON.stringify(savedUser)) as unknown },
      { role: "assistant", content: "done", parts: [], ts: "", turnIndex: 7, forModel: JSON.parse(JSON.stringify(savedReply)) as unknown },
    ];
    h.maxPictures = 10;
    h.maxBytes = 1000;
    h.turnIndex = 8;
    h.prompts = [];
    h.byCall = [];
    h.add.mockClear();
    h.setUser.mockClear();

    await run();

    expect(urls(h.prompts[0])).toEqual(Array.from({ length: 9 }, (_, index) => picture(index).url));
  });

  it("does not resurrect omitted history at the default count when a later tool crosses the hard count threshold", async () => {
    h.maxPictures = 50;
    for (let index = 0; index < 110; index += 1) h.sizes.set(index, index < 50 ? 300_000 : index < 70 ? 400_000 : 10_000);
    const historyPictures = Array.from({ length: 50 }, (_, index) => picture(index));
    const historical: ModelMessage = {
      role: "user", content: historyPictures.map((one) => ({ type: "file", mediaType: one.mediaType, data: one.url })),
    };
    h.history = [{ role: "user", content: "earlier images", parts: [], ts: "", turnIndex: 6, forModel: { messages: [historical], pictures: historyPictures } }];
    const original = JSON.stringify(h.history);
    const batches = [50, 70, 90].map((start) => Array.from({ length: 20 }, (_, index) => picture(start + index)));
    let executed = 0;
    h.tools = {
      lookup: tool({
        description: "Look up pictures.", inputSchema: z.object({}),
        execute: async (): Promise<AgentPictureOutput> => ({ kind: "agent-pictures-v1", text: "results", pictures: batches[executed++]! }),
        toModelOutput: ({ output }) => ({ type: "json", value: output }),
      }),
    };
    h.byCall = [
      asks("c1", "before default byte eviction"),
      asks("c2", "after default byte eviction"),
      asks("c3", "after next small batch"),
      saying("done"),
    ];

    await run();

    expect(h.prompts).toHaveLength(4);
    expect(urls(h.prompts[0])).toEqual(historyPictures.map((one) => one.url));
    expect(urls(h.prompts[1])).toEqual(batches[0]!.map((one) => one.url));
    expect(urls(h.prompts[2])).toEqual(batches.slice(0, 2).flat().map((one) => one.url));
    expect(urls(h.prompts[3])).toEqual(batches.flat().map((one) => one.url));
    expect(JSON.stringify(h.prompts[3])).not.toContain("before default byte eviction");
    expect(JSON.stringify(h.prompts[3])).toContain("after default byte eviction");
    expect(JSON.stringify(h.prompts[3])).toContain("after next small batch");
    expect(keptReply().pictures).toEqual(batches.flat());
    expect(JSON.stringify(h.history)).toBe(original);
  });

  it("stores full user facts and restores an omitted picture when the next turn raises its count budget", async () => {
    await run([chip(0), chip(1), chip(2)]);
    expect(urls(h.prompts[0])).toEqual([picture(1).url, picture(2).url]);
    const keptUser = h.setUser.mock.calls[0]![2] as { messages: ModelMessage[]; pictures: AgentPicture[] };
    const reply = keptReply();
    expect(keptUser.pictures.map((one) => one.url)).toEqual([picture(0).url, picture(1).url, picture(2).url]);
    expect(JSON.stringify(keptUser.messages)).toContain(picture(0).url);
    h.history = [
      { role: "user", content: "compare", parts: [], ts: "", turnIndex: 7, forModel: JSON.parse(JSON.stringify(keptUser)) as unknown },
      { role: "assistant", content: "done", parts: [], ts: "", turnIndex: 7, forModel: JSON.parse(JSON.stringify(reply)) as unknown },
    ];
    h.maxPictures = 4;
    h.turnIndex = 8;
    h.prompts = [];
    h.add.mockClear();
    h.setUser.mockClear();

    await run();

    expect(urls(h.prompts[0])).toEqual([picture(0).url, picture(1).url, picture(2).url]);
  });

  it("records the actual generation prefix and count coverage for an unchanged complete one-step answer", async () => {
    await run([chip(0)]);
    const keptUser = h.setUser.mock.calls[0]![2] as { messages: ModelMessage[] };
    const reply = keptReply();

    expect(reply.steps).toEqual([{ messageStart: 0, messageEnd: 1, prefixHash: prefixHash(prefix(), keptUser.messages) }]);
    expect(reply.countCoverage).toEqual({
      version: 1,
      turnHash: prefixHash(prefix(), [...keptUser.messages, ...reply.messages]),
      endHash: prefixHash(prefix(), [...keptUser.messages, ...reply.messages]),
    });
  });
});
