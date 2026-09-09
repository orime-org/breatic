// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What `storeCover` does when no frame came out (#181 lane ②).
 *
 * Two different things end with the extractor handing back nothing, and they
 * want opposite handling. The video may hold no frame anyone can decode, which
 * no number of retries changes. Or the object may not be readable from the
 * public domain yet — the edge assembled it moments earlier — which the very
 * next delivery would find. Answering `undefined` to both is what left a
 * perfectly good video without a cover for good.
 *
 * The source check runs only on that path: a frame that came out proves the
 * object was readable, so the successful case sends no extra request.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockExtract = vi.hoisted(() => vi.fn());
const mockStoreBytes = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockHttpRequest = vi.hoisted(() => vi.fn());

vi.mock("@worker/providers/video-cover.js", () => ({
  extractVideoCover: mockExtract,
}));
vi.mock("@worker/handlers/backend-upload.js", () => ({
  storeBytes: mockStoreBytes,
}));
vi.mock("@breatic/core", () => ({
  logger: { warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/shared", () => ({ httpRequest: mockHttpRequest }));

import { storeCover } from "@worker/handlers/store-cover.js";

const ctx = {
  projectId: "project-1",
  actingUserId: "user-1",
  log: { storageKey: "video/2026-09-09/x.mp4" },
};

describe("storeCover — what an empty extraction means", () => {
  beforeEach(() => {
    mockExtract.mockReset();
    mockStoreBytes.mockReset();
    mockWarn.mockReset();
    mockHttpRequest.mockReset();
  });

  it("gives up on a video that holds no frame, and says so", async () => {
    mockExtract.mockResolvedValue(undefined);
    // The object is there; it just has nothing to cut a frame from.
    mockHttpRequest.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(storeCover("https://cdn/video.mp4", ctx)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: "https://cdn/video.mp4" }),
      "video_cover_extraction_returned_empty_non_fatal",
    );
  });

  it("throws when the object is not readable yet, so the delivery comes again", async () => {
    mockExtract.mockResolvedValue(undefined);
    mockHttpRequest.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(storeCover("https://cdn/video.mp4", ctx)).rejects.toThrow(
      /not readable/i,
    );
  });

  it("throws when the source cannot be reached at all", async () => {
    mockExtract.mockResolvedValue(undefined);
    mockHttpRequest.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(storeCover("https://cdn/video.mp4", ctx)).rejects.toThrow(
      /not readable/i,
    );
  });

  it("asks nothing extra when a frame did come out", async () => {
    mockExtract.mockResolvedValue({
      png: Buffer.from("png"),
      mimeType: "image/png",
    });
    mockStoreBytes.mockResolvedValue({
      assetId: "asset-1",
      fileUrl: "https://cdn/cover.png",
    });

    await expect(storeCover("https://cdn/video.mp4", ctx)).resolves.toEqual({
      assetId: "asset-1",
      fileUrl: "https://cdn/cover.png",
    });

    expect(mockHttpRequest).not.toHaveBeenCalled();
  });
});
