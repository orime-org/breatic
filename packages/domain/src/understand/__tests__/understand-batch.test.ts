// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { understandMediaAt } from "@domain/understand/understand-at.js";
import { MediaUnavailable, type Media } from "@domain/understand/types.js";

const fetchMediaMock = vi.fn();
const understandMediaMock = vi.fn();
vi.mock("@domain/understand/fetch-media.js", () => ({
  fetchMedia: (...args: unknown[]) => fetchMediaMock(...args),
}));
vi.mock("@domain/understand/understand.js", () => ({
  understandMedia: (...args: unknown[]) => understandMediaMock(...args),
}));

const base = {
  question: "Compare these items.",
  maxBytes: 12,
  fetchTimeoutMs: 30_000,
  minBytesPerSec: 65_536,
  readFloorMs: 5_000,
  timeoutMs: 180_000,
  model: "google/gemini-3.8-flash",
  backend: "google-vertex",
  apiKey: "unit-test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  maxOutputTokens: 2048,
  onBilled: vi.fn(),
};
const image: Media = { kind: "image", url: "https://example.com/image.bin" };
const audio: Media = { kind: "audio", bytes: new Uint8Array([1, 2, 3, 4]), format: "wav" };
const video: Media = { kind: "video", bytes: new Uint8Array([5, 6, 7]), format: "video/mp4" };

beforeEach(() => {
  fetchMediaMock.mockReset();
  understandMediaMock.mockReset().mockResolvedValue({ text: "Compared.", finishReason: "stop" });
});

describe("understandMediaAt batches", () => {
  it("fetches in input order and asks one question in exactly one model call", async () => {
    fetchMediaMock.mockResolvedValueOnce(audio).mockResolvedValueOnce(image).mockResolvedValueOnce(video);
    const items = [
      { url: "https://example.com/a.wav", ledgerType: "audio/wav" },
      { url: image.url },
      { url: "https://example.com/v.mp4" },
    ];

    const result = await understandMediaAt({ ...base, items });

    expect(fetchMediaMock.mock.calls.map(([request]) => request.url)).toEqual(items.map((item) => item.url));
    expect(understandMediaMock).toHaveBeenCalledTimes(1);
    expect(understandMediaMock).toHaveBeenCalledWith(expect.objectContaining({
      media: [audio, image, video], question: base.question, onBilled: base.onBilled,
    }));
    expect(result).toEqual({ text: "Compared.", finishReason: "stop", kind: "audio", kinds: ["audio", "image", "video"] });
  });

  it("only deducts actual AV bytes and retains the per-item limit", async () => {
    fetchMediaMock.mockResolvedValueOnce(audio).mockResolvedValueOnce(image).mockResolvedValueOnce(video);
    await understandMediaAt({ ...base, items: [{ url: "https://example.com/a.wav" }, { url: image.url }, { url: "https://example.com/v.mp4" }] });

    expect(fetchMediaMock.mock.calls.map(([request]) => ({
      maxBytes: request.maxBytes, remaining: request.remainingDownloadBytes,
    }))).toEqual([
      { maxBytes: 12, remaining: 12 },
      { maxBytes: 12, remaining: 8 },
      { maxBytes: 12, remaining: 8 },
    ]);
  });

  it("still fetches an image after AV exhausts the entire download allowance", async () => {
    fetchMediaMock.mockResolvedValueOnce({ ...audio, bytes: new Uint8Array(12) }).mockResolvedValueOnce(image);
    await understandMediaAt({ ...base, items: [{ url: "https://example.com/a.wav" }, { url: image.url }] });

    expect(fetchMediaMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: image.url, maxBytes: 12, remainingDownloadBytes: 0,
    }));
    expect(understandMediaMock).toHaveBeenCalledWith(expect.objectContaining({ media: [{ ...audio, bytes: new Uint8Array(12) }, image] }));
  });

  it("does not start another fetch while the preceding item is pending", async () => {
    let release: ((media: Media) => void) | undefined;
    fetchMediaMock.mockImplementationOnce(() => new Promise<Media>((resolve) => { release = resolve; })).mockResolvedValueOnce(image);
    const pending = understandMediaAt({ ...base, items: [{ url: "https://example.com/a.wav" }, { url: image.url }] });
    await Promise.resolve();
    expect(fetchMediaMock).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("first fetch did not start");
    release(audio);
    await pending;
    expect(fetchMediaMock).toHaveBeenCalledTimes(2);
  });

  it.each(["too-large", "empty", "unreachable", "unsupported-type", "slow"] as const)("indexes %s without losing the source refusal", async (kind) => {
    fetchMediaMock.mockResolvedValueOnce(image).mockRejectedValueOnce(new MediaUnavailable(kind, {
      status: 413, limit: 8, bytes: 9, detail: "source fact", declaredType: "audio/wav",
    }));
    const pending = understandMediaAt({ ...base, items: [{ url: image.url }, { url: "https://example.com/b.wav" }, { url: "https://example.com/c.wav" }] });

    await expect(pending).rejects.toMatchObject({
      name: "MediaUnavailable", kind, itemIndex: 2, url: "https://example.com/b.wav",
      status: 413, limit: 8, bytes: 9, detail: "source fact", declaredType: "audio/wav",
    });
    await expect(pending).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(pending).rejects.toThrow(/Item 2.*https:\/\/example.com\/b.wav/);
    expect(fetchMediaMock).toHaveBeenCalledTimes(2);
    expect(understandMediaMock).not.toHaveBeenCalled();
  });

  it("propagates a caller stop without beginning a later fetch or model call", async () => {
    const controller = new AbortController();
    fetchMediaMock.mockImplementationOnce(async () => {
      controller.abort();
      return audio;
    });

    await expect(understandMediaAt({ ...base, signal: controller.signal, items: [{ url: "https://example.com/a.wav" }, { url: image.url }] })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMediaMock).toHaveBeenCalledTimes(1);
    expect(understandMediaMock).not.toHaveBeenCalled();
  });

  it("keeps source order and exactly one model invocation for arbitrary mixed inputs", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("image", "audio", "video"), { minLength: 1, maxLength: 10 }), async (kinds) => {
      fetchMediaMock.mockReset();
      understandMediaMock.mockClear();
      const media = kinds.map((kind, index): Media => kind === "image"
        ? { kind, url: `https://example.com/${index}.png` }
        : kind === "audio"
          ? { kind, bytes: new Uint8Array([index]), format: "wav" }
          : { kind, bytes: new Uint8Array([index]), format: "video/mp4" });
      for (const item of media) fetchMediaMock.mockResolvedValueOnce(item);
      const items = kinds.map((_kind, index) => ({ url: `https://example.com/${index}.bin` }));
      await understandMediaAt({ ...base, items });
      expect(understandMediaMock).toHaveBeenCalledTimes(1);
      expect(understandMediaMock).toHaveBeenCalledWith(expect.objectContaining({ media }));
      expect(fetchMediaMock.mock.calls.map(([request]) => request.url)).toEqual(items.map((item) => item.url));
    }), { numRuns: 30 });
  });
});
