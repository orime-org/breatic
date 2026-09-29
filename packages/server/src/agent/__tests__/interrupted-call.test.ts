// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DomainModule from "@breatic/domain";

const enqueueUsageLookup = vi.hoisted(() => vi.fn(async () => undefined));
const provider = vi.hoisted(() => ({ name: "openrouter" }));

vi.mock("@server/agent/usage-lookup-queue.js", () => ({ enqueueUsageLookup }));
vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, resolveProvider: () => provider.name };
});

import { watchInterruptedCall } from "@server/agent/interrupted-call.js";

const OPERATION = {
  model: "google/gemini-2.5-flash",
  operationKey: "turn:c1:2",
  feature: "chat_turn" as const,
  actorUserId: "u-1",
  projectId: "p-1",
  description: "Agent chat",
};

beforeEach(() => {
  enqueueUsageLookup.mockClear();
  provider.name = "openrouter";
});

describe("an OpenRouter call cut off before it reported its cost", () => {
  it("asks the stream for raw chunks", () => {
    expect(watchInterruptedCall(OPERATION).streamOptions.includeRawChunks).toBe(true);
  });

  it("hands the open generation to the later lookup", async () => {
    const watch = watchInterruptedCall(OPERATION);
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });

    await watch.handOff();

    expect(enqueueUsageLookup).toHaveBeenCalledWith({
      generationId: "gen-7",
      model: "google/gemini-2.5-flash",
      operationKey: "turn:c1:2",
      feature: "chat_turn",
      source: "model",
      actorUserId: "u-1",
      projectId: "p-1",
      description: "Agent chat",
    });
  });

  it("hands nothing off once the call ended and was recorded", async () => {
    const watch = watchInterruptedCall(OPERATION);
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });
    watch.ended();

    await watch.handOff();

    expect(enqueueUsageLookup).not.toHaveBeenCalled();
  });

  it("hands nothing off for a model reached directly", async () => {
    provider.name = "deepseek";
    const watch = watchInterruptedCall({ ...OPERATION, model: "deepseek/deepseek-v4-pro" });
    watch.streamOptions.onChunk({ chunk: { type: "raw", rawValue: { id: "gen-7" } } });

    await watch.handOff();

    expect(enqueueUsageLookup).not.toHaveBeenCalled();
  });

  it("ignores chunks that are not raw", async () => {
    const watch = watchInterruptedCall(OPERATION);
    watch.streamOptions.onChunk({ chunk: { type: "text-delta" } });

    await watch.handOff();

    expect(enqueueUsageLookup).not.toHaveBeenCalled();
  });
});
