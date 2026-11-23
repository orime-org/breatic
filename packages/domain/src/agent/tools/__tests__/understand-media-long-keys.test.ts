// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `understand_media` reading one long recording in batches does so on the turn's key set (inner#1953), as a short
 * reading does: the batched reading is handed the key set the turn runs on, so with the payer's OpenRouter key every
 * batch goes out on it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as understandModule from "@domain/understand/index.js";

const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? "sk-or-v1-account" : undefined) };

vi.mock("@domain/understand/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof understandModule>();
  return {
    ...actual,
    understandMediaAt: vi.fn(),
    understandMediaInBatches: vi.fn(),
    openLongMediaBatchOperation: vi.fn(async () => ({
      operationId: "operation-1",
      checkpoint: { load: async () => null, save: async () => undefined },
      signal: new AbortController().signal,
      complete: async () => undefined,
      release: async () => undefined,
    })),
    advanceLongMediaSegmentation: vi.fn(),
    cancelLongMediaSegmentation: vi.fn(),
  };
});

vi.mock("@domain/provider/instance.js", () => ({
  initProvider: () => undefined,
  provider: () => ({
    llm: { availability: () => ({ upstreams: [{ upstream: "openrouter", weight: 0, configured: true, envVar: "OPENROUTER_API_KEY" }] }) },
  }),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return { ...actual, env: new Proxy({}, { get: () => undefined }) };
});

const { getAgentConfig } = await import("@breatic/core");
const { buildToolSet } = await import("@domain/agent/tools/index.js");
const { UNDERSTAND_MEDIA } = await import("@domain/agent/tools/tool-names.js");
const { understandMediaInBatches, advanceLongMediaSegmentation } = await import("@domain/understand/index.js");
const { toolOptions, usageSpy } = await import("@domain/agent/__tests__/helpers/usage-spy.js");

beforeEach(() => {
  vi.mocked(understandMediaInBatches).mockReset();
  vi.mocked(advanceLongMediaSegmentation).mockReset();
  vi.mocked(advanceLongMediaSegmentation).mockResolvedValue({
    kind: "ready",
    segments: [{ url: "https://assets.example/audio/part.mp3", ledgerType: "audio/mpeg", sizeBytes: 900, startUs: "0", endUs: "60000000" }],
  });
  vi.mocked(understandMediaInBatches).mockResolvedValue({ text: "A greeting.", finishReason: "stop", kind: "audio", kinds: ["audio"] });
});

/**
 * Run the turn's copy of the tool on one source too large for a single reading.
 * @param context - What the turn built its tools with.
 * @returns What the tool answered.
 */
async function readLong(context: Record<string, unknown>): Promise<unknown> {
  const config = getAgentConfig();
  const tool = buildToolSet([UNDERSTAND_MEDIA], context as never)[UNDERSTAND_MEDIA];
  if (tool?.execute === undefined) throw new Error("understand_media was not offered");
  const resolveCanonicalMediaSource = vi.fn(async () => ({
    key: "audio/source.wav",
    sha256: "a".repeat(64),
    sizeBytes: config.understand_media_max_bytes + 1,
    mimeType: "audio/wav",
  }));
  return tool.execute(
    { items: [{ url: "https://assets.example/audio/source.wav" }], question: "What is said?" },
    toolOptions({ context: { usage: usageSpy().recorder, studioId: "studio-1", projectId: "project-1", actorUserId: "user-1", resolveCanonicalMediaSource } }) as never,
  );
}

describe("understand_media on one long recording", () => {
  it("reads it in batches on the turn's key set", async () => {
    await readLong({ keys: ACCOUNT });

    expect(understandMediaInBatches).toHaveBeenCalledTimes(1);
    expect(vi.mocked(understandMediaInBatches).mock.calls[0]![0]).toMatchObject({ keys: ACCOUNT });
  });

  it("reads it in batches on our keys when the turn runs on them", async () => {
    await readLong({});

    expect(understandMediaInBatches).toHaveBeenCalledTimes(1);
    expect((vi.mocked(understandMediaInBatches).mock.calls[0]![0] as { keys?: unknown }).keys).toBeUndefined();
  });
});
