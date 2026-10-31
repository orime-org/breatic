// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type * as coreModule from "@breatic/core";
import type * as understandModule from "@domain/understand/index.js";
import { makeUnderstandMediaTool } from "@domain/agent/tools/understand-media.js";
import { toolOptions, usageSpy } from "@domain/agent/__tests__/helpers/usage-spy.js";
import { MediaUnavailable } from "@domain/understand/types.js";
import { toolFailureOf } from "@breatic/shared";

const understandMediaAtMock = vi.fn();
let maxItems = 10;
let maxBytes = 20_000_000;
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getRawEnvVar: () => "unit-test-key",
    getAgentConfig: () => ({ ...actual.getAgentConfig(), understand_media_max_items: maxItems, understand_media_max_bytes: maxBytes }),
  };
});
vi.mock("@domain/understand/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof understandModule>();
  return { ...actual, understandMediaAt: (...args: unknown[]) => understandMediaAtMock(...args) };
});

beforeEach(() => {
  maxItems = 10;
  maxBytes = 20_000_000;
  understandMediaAtMock.mockReset().mockResolvedValue({ text: "Compared.", finishReason: "stop", kind: "image", kinds: ["image", "audio"] });
});

describe("understand_media batch tool", () => {
  it("describes fallback images and mixed AV according to the turn's picture capability", () => {
    const vision = makeUnderstandMediaTool({ seesPictures: true }).description;
    const textOnly = makeUnderstandMediaTool({ seesPictures: false }).description;
    expect(vision).toEqual(expect.stringMatching(/audio/i));
    expect(vision).toEqual(expect.stringMatching(/video/i));
    expect(vision).toEqual(expect.stringMatching(/original|detail/i));
    expect(vision).toEqual(expect.stringMatching(/budget|omitted/i));
    expect(textOnly).toEqual(expect.stringMatching(/image/i));
    expect(textOnly).toEqual(expect.stringMatching(/audio/i));
    expect(textOnly).toEqual(expect.stringMatching(/video/i));
  });

  it("accepts one through the configured number of items, and rejects scalar, empty and excessive input", () => {
    const schema = makeUnderstandMediaTool().inputSchema as z.ZodType;
    const question = "Compare.";
    const item = { url: "https://example.com/a.wav" };
    expect(schema.safeParse({ items: [item], question }).success).toBe(true);
    expect(schema.safeParse({ items: Array.from({ length: 10 }, () => item), question }).success).toBe(true);
    expect(schema.safeParse({ url: item.url, question }).success).toBe(false);
    expect(schema.safeParse({ items: [], question }).success).toBe(false);
    expect(schema.safeParse({ items: Array.from({ length: 11 }, () => item), question }).success).toBe(false);
    expect(schema.safeParse({ items: [{ url: "not a URL" }], question }).success).toBe(false);
    expect(schema.safeParse({ items: [item], question: "   " }).success).toBe(false);
  });

  it("creates the schema per factory and freezes the same configuration for execution", async () => {
    maxItems = 2;
    maxBytes = 12345;
    const tool = makeUnderstandMediaTool();
    maxItems = 1;
    maxBytes = 999;
    const input = { items: [{ url: "https://example.com/a.wav" }, { url: "https://example.com/b.wav" }], question: "Compare." };
    const schema = tool.inputSchema as z.ZodType;
    expect(schema.safeParse(input).success).toBe(true);
    expect((makeUnderstandMediaTool().inputSchema as z.ZodType).safeParse(input).success).toBe(false);
    if (!tool.execute) throw new Error("tool has no execute");
    expect(await tool.execute(input, toolOptions() as never)).toBe("Compared.");
    expect(understandMediaAtMock).toHaveBeenCalledWith(expect.objectContaining({ items: input.items, maxBytes: 12345 }));
  });

  it("sends all items and one question in one capability call and records one service call", async () => {
    const tool = makeUnderstandMediaTool();
    const usage = usageSpy();
    const items = [{ url: "https://example.com/a.wav" }, { url: "https://example.com/b.mp4" }, { url: "https://example.com/c.png" }];
    understandMediaAtMock.mockImplementationOnce(async (request: { onBilled: (cost: number) => void }) => {
      request.onBilled(0.003);
      return { text: "Compared.", finishReason: "stop", kind: "audio", kinds: ["audio", "video", "image"] };
    });
    if (!tool.execute) throw new Error("tool has no execute");
    expect(await tool.execute({ items, question: "Compare all three." }, toolOptions({}, usage.recorder) as never)).toBe("Compared.");
    expect(understandMediaAtMock).toHaveBeenCalledTimes(1);
    expect(understandMediaAtMock).toHaveBeenCalledWith(expect.objectContaining({ items, question: "Compare all three." }));
    expect(usage.serviceCalls).toEqual([{ source: "tool:understand_media", service: "google/gemini-3.8-flash", provider: "openrouter", requests: 1, costUsd: 0.003 }]);
  });

  it("preserves the one-in-flight gate for a whole batch and reopens it after completion", async () => {
    const tool = makeUnderstandMediaTool();
    let release: (() => void) | undefined;
    understandMediaAtMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { text: "First.", finishReason: "stop", kind: "audio", kinds: ["audio"] };
    });
    if (!tool.execute) throw new Error("tool has no execute");
    const input = { items: [{ url: "https://example.com/a.wav" }], question: "Read." };
    const first = tool.execute(input, toolOptions() as never);
    const second = await Promise.resolve(tool.execute(input, toolOptions() as never)).catch((error: unknown) => error);
    expect(toolFailureOf(second)?.kind).toBe("turned_away");
    expect(understandMediaAtMock).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("batch did not start");
    release();
    expect(await first).toBe("First.");
    expect(await tool.execute(input, toolOptions() as never)).toBe("Compared.");
    expect(understandMediaAtMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the failing item number and source in the model-facing failure", async () => {
    const refusal = Object.assign(new MediaUnavailable("too-large", { bytes: 13, limit: 12 }), { itemIndex: 2, url: "https://example.com/b.wav" });
    understandMediaAtMock.mockRejectedValueOnce(refusal);
    const tool = makeUnderstandMediaTool();
    if (!tool.execute) throw new Error("tool has no execute");
    const error = await Promise.resolve(tool.execute({ items: [{ url: "https://example.com/a.wav" }, { url: refusal.url }], question: "Compare." }, toolOptions() as never)).catch((caught: unknown) => caught);
    expect(toolFailureOf(error)).toMatchObject({ forModel: expect.stringMatching(/Item 2.*https:\/\/example.com\/b.wav/) });
    expect(toolFailureOf(error)).toMatchObject({ forModel: expect.stringContaining("12 byte limit") });
  });
});
