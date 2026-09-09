// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one entry the tool calls, and the order it puts the two halves in.
 *
 * Each half has its own cases; what only shows up here is the seam. Getting
 * the media and asking about it are two calls with their own budgets, and
 * sending one half's figure to the other is a mistake neither half can see:
 * the fetch would get the model's three minutes and the upload the fetch's
 * thirty seconds, and twenty megabytes takes about fifty-five of them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as fetchModule from "@domain/understand/fetch-media.js";
import type * as understandModule from "@domain/understand/understand.js";
import { understandMediaAt } from "@domain/understand/understand-at.js";
import { MediaUnavailable } from "@domain/understand/types.js";

const fetchMediaMock = vi.fn();
const understandMediaMock = vi.fn();

vi.mock("@domain/understand/fetch-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof fetchModule>();
  return { ...actual, fetchMedia: (...args: unknown[]) => fetchMediaMock(...args) };
});

vi.mock("@domain/understand/understand.js", async (importOriginal) => {
  const actual = await importOriginal<typeof understandModule>();
  return { ...actual, understandMedia: (...args: unknown[]) => understandMediaMock(...args) };
});

/** Every figure distinct, so a pair swapped between them shows as a wrong number. */
const request = {
  url: "https://example.com/clip.mp4",
  question: "What happens?",
  maxBytes: 20_000_000,
  fetchTimeoutMs: 30_000,
  minBytesPerSec: 65_536,
  readFloorMs: 5_000,
  timeoutMs: 180_000,
  model: "google/gemini-3.8-flash",
  backend: "google-vertex",
  apiKey: "test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  maxOutputTokens: 2048,
};

const media = { kind: "video", bytes: new Uint8Array([1, 2, 3]), mediaType: "video/mp4" };

beforeEach(() => {
  fetchMediaMock.mockReset();
  understandMediaMock.mockReset();
  fetchMediaMock.mockResolvedValue(media);
  understandMediaMock.mockResolvedValue({
    text: "A rabbit wakes up.",
    finishReason: "stop",
    usage: { totalTokens: 42 },
  });
});

describe("understandMediaAt — what each half is told", () => {
  it("gives the fetch the fetch's own limits", async () => {
    await understandMediaAt(request);

    expect(fetchMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: request.url,
        maxBytes: 20_000_000,
        fetchTimeoutMs: 30_000,
        minBytesPerSec: 65_536,
        readFloorMs: 5_000,
      }),
    );
  });

  it("gives the model call the model call's own limits, and what was fetched", async () => {
    await understandMediaAt(request);

    expect(understandMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media,
        question: request.question,
        timeoutMs: 180_000,
        model: "google/gemini-3.8-flash",
        backend: "google-vertex",
        apiKey: "test-key",
        baseUrl: "https://openrouter.ai/api/v1",
        maxOutputTokens: 2048,
      }),
    );
  });

  it("passes the caller's signal to both halves", async () => {
    const controller = new AbortController();

    await understandMediaAt({ ...request, signal: controller.signal });

    expect(fetchMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(understandMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("understandMediaAt — the order", () => {
  it("reports what kind it turned out to be, which only the fetch knows", async () => {
    const answer = await understandMediaAt(request);

    expect(answer).toEqual({
      text: "A rabbit wakes up.",
      finishReason: "stop",
      usage: { totalTokens: 42 },
      kind: "video",
    });
  });

  it("does not call the model when the media could not be had", async () => {
    fetchMediaMock.mockRejectedValue(new MediaUnavailable("too-large", { limit: 20_000_000 }));

    await expect(understandMediaAt(request)).rejects.toBeInstanceOf(MediaUnavailable);
    expect(understandMediaMock).not.toHaveBeenCalled();
  });
});
