// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getStorageAdapter: vi.fn(),
  findLiveByKeyInStudio: vi.fn(),
  keyFromUrl: vi.fn(),
}));

vi.mock("@breatic/core", () => ({ getStorageAdapter: h.getStorageAdapter }));
vi.mock("@breatic/domain", () => ({ assetRepo: { findLiveByKeyInStudio: h.findLiveByKeyInStudio } }));

const { canonicalMediaSourceFor } = await import("@server/agent/canonical-media-source.js");

const asset = {
  storageKey: "media/source.mp4",
  contentHash: "a".repeat(64),
  sizeBytes: 30_000_000,
  mimeType: "video/mp4",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.keyFromUrl.mockReturnValue(asset.storageKey);
  h.getStorageAdapter.mockResolvedValue({ keyFromUrl: h.keyFromUrl });
  h.findLiveByKeyInStudio.mockResolvedValue(asset);
});

describe("canonicalMediaSourceFor", () => {
  it("returns the measured source facts for a live asset in the named Studio", async () => {
    await expect(canonicalMediaSourceFor("https://assets.example/media/source.mp4", "studio-1")).resolves.toEqual({
      key: asset.storageKey,
      sha256: asset.contentHash,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
    });
    expect(h.findLiveByKeyInStudio).toHaveBeenCalledWith("studio-1", asset.storageKey);
  });

  it("returns null for an address that does not name our storage", async () => {
    h.keyFromUrl.mockReturnValue(null);

    await expect(canonicalMediaSourceFor("https://external.example/source.mp4", "studio-1")).resolves.toBeNull();
    expect(h.findLiveByKeyInStudio).not.toHaveBeenCalled();
  });

  it("returns null when the key is not a live asset in that Studio", async () => {
    h.findLiveByKeyInStudio.mockResolvedValue(null);

    await expect(canonicalMediaSourceFor("https://assets.example/media/source.mp4", "studio-2")).resolves.toBeNull();
    expect(h.findLiveByKeyInStudio).toHaveBeenCalledWith("studio-2", asset.storageKey);
  });
});
