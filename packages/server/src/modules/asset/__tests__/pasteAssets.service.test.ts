// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  findByStorageKeys: vi.fn(),
  findLiveByStorageKey: vi.fn(),
  findByStudioAndHash: vi.fn(),
  findCoverOf: vi.fn(),
  registerWithDedup: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  accountActivityRepo: { recordActivity: vi.fn() },
  getStorageAdapter: async () => ({
    keyFromUrl: (url: string) => (url.startsWith("https://cdn.test/") ? url.slice("https://cdn.test/".length) : null),
    publicUrl: (key: string) => `https://cdn.test/${key}`,
  }),
  logger: { error: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  assetRepo: repo,
  assetService: { resolveOwnerStudioId: async () => "studio-target" },
  ingestReportService: { settleDedupedCover: vi.fn() },
  materialFacts: async () => new Map(),
  nodeHistoryService: { recordSnapshot: vi.fn(), recordUpload: vi.fn() },
}));
vi.mock("@server/modules/asset/storageQuota.service.js", () => ({ assertStudioStorageAllowance: vi.fn() }));

import { pasteAssets } from "@server/modules/asset/pasteAssets.service.js";

/**
 * An asset row as the repository returns it.
 * @param key - Its storage key.
 * @param kind - What it holds.
 * @returns The row.
 */
function row(key: string, kind: "image" | "video"): Record<string, unknown> {
  return {
    id: `id-${key}`,
    studioId: "studio-source",
    contentHash: `hash-${key}`,
    storageKey: key,
    fileUrl: `https://cdn.test/${key}`,
    sizeBytes: 10,
    mimeType: kind === "video" ? "video/mp4" : "image/png",
    kind,
    width: null,
    height: null,
    durationSeconds: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.findLiveByStorageKey.mockResolvedValue(null);
  repo.findByStudioAndHash.mockResolvedValue(null);
  repo.findCoverOf.mockResolvedValue(null);
  repo.registerWithDedup.mockImplementation(async (input: { storageKey: string; fileUrl: string }) => ({
    asset: { ...row(input.storageKey, "image"), id: `new-${input.storageKey}`, fileUrl: input.fileUrl },
  }));
  repo.findByStorageKeys.mockResolvedValue(
    new Map([
      ["a.png", { asset: row("a.png", "image"), cover: null }],
      ["b.png", { asset: row("b.png", "image"), cover: null }],
      ["v.mp4", { asset: row("v.mp4", "video"), cover: row("v.mp4.cover.jpg", "image") }],
    ]),
  );
});

describe("pasteAssets", () => {
  it("reads every address of a paste from the ledger in one lookup", async () => {
    const answer = await pasteAssets({
      projectId: "project-1",
      userId: "user-1",
      urls: ["https://cdn.test/a.png", "https://cdn.test/b.png", "https://cdn.test/v.mp4"],
      pairs: [],
      history: [],
    });

    expect(repo.findByStorageKeys).toHaveBeenCalledTimes(1);
    expect(new Set(repo.findByStorageKeys.mock.calls[0]?.[0] as string[])).toEqual(
      new Set(["a.png", "b.png", "v.mp4"]),
    );
    expect(repo.findLiveByStorageKey).not.toHaveBeenCalled();
    expect(answer.map).toEqual({
      "https://cdn.test/a.png": "https://cdn.test/a.png",
      "https://cdn.test/b.png": "https://cdn.test/b.png",
      "https://cdn.test/v.mp4": "https://cdn.test/v.mp4",
      "https://cdn.test/v.mp4.cover.jpg": "https://cdn.test/v.mp4.cover.jpg",
    });
  });
});
