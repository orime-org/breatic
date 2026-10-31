// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import { understandMedia } from "@domain/understand/understand.js";
import type { Media } from "@domain/understand/types.js";

const httpRequestMock = vi.fn();
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

const billed = vi.fn();
const base = {
  question: "Compare these.", model: "google/gemini-3.8-flash", backend: "google-vertex",
  apiKey: "unit-test-key", baseUrl: "https://openrouter.ai/api/v1",
  maxOutputTokens: 2048, timeoutMs: 180_000, onBilled: billed,
};

beforeEach(() => {
  billed.mockClear();
  httpRequestMock.mockReset().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: "Compared." }, finish_reason: "stop" }], usage: { cost: 0.001 },
  }), { headers: { "content-type": "application/json" } }));
});

describe("understandMedia batch wire contract", () => {
  it("waits for durable send authority immediately before the model request", async () => {
    const order: string[] = [];
    const onRequestSending = vi.fn(async () => {
      order.push("send-authority");
    });
    httpRequestMock.mockImplementation(async () => {
      order.push("model-request");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Compared." }, finish_reason: "stop" }],
      }), { headers: { "content-type": "application/json" } });
    });

    await understandMedia({
      ...base,
      media: [{ kind: "audio", bytes: new Uint8Array([1]), format: "wav" }],
      onRequestSending,
    });

    expect(order).toEqual(["send-authority", "model-request"]);
    expect(onRequestSending).toHaveBeenCalledTimes(1);
  });

  it("sends one question and numbered media in order through one pinned request", async () => {
    const media: Media[] = [
      { kind: "audio", bytes: new Uint8Array([1, 2]), format: "wav" },
      { kind: "image", url: "https://example.com/picture.bin" },
      { kind: "video", bytes: new Uint8Array([3, 4]), format: "video/mp4" },
      { kind: "audio", bytes: new Uint8Array([5, 6]), format: "mp3" },
    ];
    expect(await understandMedia({ ...base, media })).toEqual({ text: "Compared.", finishReason: "stop" });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    const request = httpRequestMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "google/gemini-3.8-flash", max_tokens: 2048,
      provider: { only: ["google-vertex"], allow_fallbacks: false },
      messages: [{ role: "user", content: [
        { type: "text", text: "Compare these." },
        { type: "text", text: "Item 1" },
        { type: "input_audio", input_audio: { data: "AQI=", format: "wav" } },
        { type: "text", text: "Item 2" },
        { type: "image_url", image_url: { url: "https://example.com/picture.bin" } },
        { type: "text", text: "Item 3" },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,AwQ=" } },
        { type: "text", text: "Item 4" },
        { type: "input_audio", input_audio: { data: "BQY=", format: "mp3" } },
      ] }],
    });
    expect(billed.mock.calls).toEqual([[0.001]]);
  });

  it("numbers even a single item using the same array contract", async () => {
    await understandMedia({ ...base, media: [{ kind: "image", url: "https://example.com/a.png" }] });
    const request = httpRequestMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).messages[0].content).toEqual([
      { type: "text", text: "Compare these." },
      { type: "text", text: "Item 1" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });

  it("does not attribute an ambiguous mixed-request 400 to the image URL", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 400, message: "Cannot fetch content from URL" } }), { status: 400 }));
    await expect(understandMedia({ ...base, media: [
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
      { kind: "image", url: "https://example.com/a.png" },
    ] })).rejects.toMatchObject({ name: "UnderstandRefused", kind: "media", status: 400 });
    expect(billed).not.toHaveBeenCalled();
  });

  it.each([
    ["audio before image", [
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
      { kind: "image", url: "https://example.com/a.png" },
    ]],
    ["image before audio", [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
    ]],
    ["image between inline video and audio", [
      { kind: "video", bytes: new Uint8Array([2]), format: "video/mp4" },
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
    ]],
  ] satisfies Array<[string, Media[]]>)("keeps inline decoding faults about our request for %s", async (_label, media) => {
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 400, message: "Unable to decode audio" } }), { status: 400 }));

    await expect(understandMedia({ ...base, media })).rejects.toMatchObject({
      name: "UnderstandRefused", kind: "media", status: 400, detail: "Unable to decode audio",
    });
    expect(billed).not.toHaveBeenCalled();
  });

  it("preserves the URL-fetch refusal for batches consisting entirely of image addresses", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 400, message: "Cannot fetch content from URL" } }), { status: 400 }));

    await expect(understandMedia({ ...base, media: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "image", url: "https://example.com/b.png" },
    ] })).rejects.toMatchObject({ name: "UnderstandRefused", kind: "unfetchable", status: 400 });
    expect(billed).not.toHaveBeenCalled();
  });

  it("preserves the inline-request refusal for batches consisting entirely of audio and video bytes", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 400, message: "Unable to decode audio" } }), { status: 400 }));

    await expect(understandMedia({ ...base, media: [
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
      { kind: "video", bytes: new Uint8Array([2]), format: "video/mp4" },
    ] })).rejects.toMatchObject({ name: "UnderstandRefused", kind: "media", status: 400 });
    expect(billed).not.toHaveBeenCalled();
  });

  it.each([
    [401, "deployment"],
    [402, "deployment"],
    [403, "deployment"],
    [404, "deployment"],
    [413, "media"],
    [418, "deployment"],
    [408, "transient"],
    [429, "transient"],
    [500, "transient"],
    [524, "transient"],
  ] as const)("preserves the %i refusal classification for mixed transport", async (status, kind) => {
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: status, message: "Provider refused this request" } }), { status }));

    await expect(understandMedia({ ...base, media: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
    ] })).rejects.toMatchObject({ name: "UnderstandRefused", kind, status });
    expect(billed).not.toHaveBeenCalled();
  });

  it("retains deployment refusal classification without blaming any mixed item", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 401, message: "Invalid API key" } }), { status: 401 }));
    await expect(understandMedia({ ...base, media: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", bytes: new Uint8Array([1]), format: "wav" },
    ] })).rejects.toMatchObject({ kind: "deployment", status: 401 });
    expect(billed).not.toHaveBeenCalled();
  });
});
