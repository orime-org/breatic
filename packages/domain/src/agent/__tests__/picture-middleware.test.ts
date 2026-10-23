// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
import { generateText, wrapLanguageModel } from "ai";
import type { LanguageModelMiddleware } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { pictureMiddleware } from "@domain/agent/picture-middleware.js";

type Prompt = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["prompt"];
const URL_ONE = "https://media.example/one.png.agent-v1-1024-q85.jpg";
const URL_TWO = "https://media.example/two.bin.agent-v1-1024-q85.jpg";
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A provider answering without a network request. */
function model(provider = "test"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider,
    doGenerate: async () => ({
      content: [{ type: "text", text: "done" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

/** Two complete tool results form one group before any generated picture user message. */
function logicalPrompt(): Prompt {
  return [
    { role: "assistant", content: [
      { type: "tool-call", toolCallId: "c1", toolName: "search_images", input: { query: "one" } },
      { type: "tool-call", toolCallId: "c2", toolName: "search_images", input: { query: "two" } },
    ] },
    ...[URL_ONE, URL_TWO].map((url, index) => ({
      role: "tool" as const,
      content: [{
        type: "tool-result" as const, toolCallId: `c${String(index + 1)}`, toolName: "search_images",
        output: { type: "json" as const, value: { kind: "agent-pictures-v1", text: `result ${String(index + 1)}`, pictures: [{
          label: `result ${String(index + 1)}`, sourceUrl: `https://source.example/${String(index)}.bin`,
          url, mediaType: "image/jpeg", sizeBytes: 1234,
        }] } },
      }],
    })),
  ];
}

/** Run only the sending transformation, leaving all provider IO disabled. */
async function transformed(prompt: Prompt): Promise<Prompt> {
  if (pictureMiddleware.transformParams === undefined) throw new Error("picture transformation is missing");
  const params = await pictureMiddleware.transformParams({ type: "generate", params: { prompt }, model: model() });
  return params.prompt;
}

describe("picture middleware sending contract", () => {
  it("merges the provider's supported URLs with prepared HTTPS JPEG URLs", async () => {
    const original = /^https:\/\/provider\.example\//;
    const underlying = new MockLanguageModelV4({ supportedUrls: { "video/*": [original] } });
    const wrapped = wrapLanguageModel({ model: underlying, middleware: pictureMiddleware });
    const supported = await wrapped.supportedUrls;

    expect(supported["video/*"]).toEqual([original]);
    expect(supported["image/*"]?.some((pattern) => pattern.test(URL_ONE))).toBe(true);
    expect(supported["image/*"]?.some((pattern) => pattern.test("http://media.example/a.agent-v1-1024-q85.jpg"))).toBe(false);
    expect(supported["image/*"]?.some((pattern) => pattern.test("https://source.example/unprepared.png"))).toBe(false);
  });

  it("puts tool pictures after all contiguous results while preserving calls and result order", async () => {
    const prompt = logicalPrompt();
    const before = JSON.stringify(prompt);
    const out = await transformed(prompt);

    expect(out.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    const imageMessage = out[3];
    const parts = imageMessage?.role === "user" ? imageMessage.content : [];
    const urls = parts.flatMap((part) => part.type === "file" && part.data.type === "url" ? [String(part.data.url)] : []);
    expect(urls).toEqual([URL_ONE, URL_TWO]);
    expect(parts.filter((part) => part.type === "file").map((part) => part.mediaType)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(JSON.stringify(imageMessage)).toContain("c1");
    expect(JSON.stringify(imageMessage)).toContain("c2");
    expect(JSON.stringify(prompt)).toBe(before);
    expect(out).not.toBe(prompt);
  });

  it("does not expand an already expanded tool group twice", async () => {
    const first = await transformed(logicalPrompt());
    expect(await transformed(first)).toEqual(first);
  });

  it("passes native JPEG file parts and ordinary text tool results through without rewriting their content", async () => {
    const prompt: Prompt = [
      { role: "user", content: [{ type: "text", text: "clock" }, { type: "file", mediaType: "image/jpeg", data: { type: "url", url: new URL(URL_ONE) } }, { type: "text", text: "reminder" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "legacy", output: { type: "text", value: "https://source.example/not-a-prepared-picture.png" } }] },
    ];

    expect(await transformed(prompt)).toEqual(prompt);
  });

  it.each(["anthropic", "google", "openai", "openrouter"])("keeps the prepared URL and full MIME at the %s provider boundary without downloading bytes", async (provider) => {
    const underlying = model(provider);
    const wrapped = wrapLanguageModel({ model: underlying, middleware: pictureMiddleware });
    const download = vi.fn(async (planned: Array<{ url: URL; isUrlSupportedByModel: boolean }>) => {
      // The SDK always calls this planning hook, even for URLs it will send
      // directly. Reject any plan requiring bytes instead of hiding a missing
      // supported-URL override by returning null unconditionally.
      expect(planned).toEqual([{ url: new URL(URL_ONE), isUrlSupportedByModel: true }]);
      return planned.map(() => null);
    });
    const result = await generateText({
      model: wrapped,
      maxRetries: 0,
      messages: [{ role: "user", content: [{ type: "file", data: URL_ONE, mediaType: "image/jpeg" }] }],
      experimental_download: download,
    });

    expect(result.text).toBe("done");
    expect(download).toHaveBeenCalledTimes(1);
    expect(underlying.doGenerateCalls[0]!.prompt).toEqual([
      { role: "user", content: [{ type: "file", data: { type: "url", url: new URL(URL_ONE) }, mediaType: "image/jpeg" }] },
    ]);
  });
});
