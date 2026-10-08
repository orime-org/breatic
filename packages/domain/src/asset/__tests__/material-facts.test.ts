// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the registration behind a material address says (inner#1315): read for
 * every address an agent's proposal names, before the check runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StudioAssetEntity } from "@breatic/shared";

const findLiveByKeyInStudio = vi.fn();
const findCoverOf = vi.fn();

vi.mock("@breatic/core", () => ({
  getStorageAdapter: async () => ({
    keyFromUrl: (url: string) => (url.startsWith("https://ours.example/") ? url.slice("https://ours.example/".length) : null),
  }),
}));
vi.mock("@domain/asset/asset.repo.js", () => ({ findLiveByKeyInStudio, findCoverOf }));

const { materialFacts } = await import("@domain/asset/material-facts.js");

/**
 * A registration row.
 * @param kind - What it holds.
 * @param extra - Fields to set.
 * @returns The row.
 */
function row(kind: StudioAssetEntity["kind"], extra: Partial<StudioAssetEntity> = {}): StudioAssetEntity {
  return {
    id: "a1",
    studioId: "s1",
    contentHash: "h",
    storageKey: "k",
    fileUrl: "https://ours.example/k",
    sizeBytes: 100,
    mimeType: kind === "video" ? "video/mp4" : "image/png",
    kind,
    source: "upload",
    producedByUserId: "u1",
    generationTaskId: null,
    width: 640,
    height: 480,
    durationSeconds: kind === "video" ? 5 : null,
    createdAt: new Date(0),
    deletedAt: null,
    ...extra,
  } as StudioAssetEntity;
}

beforeEach(() => {
  vi.clearAllMocks();
  findCoverOf.mockResolvedValue(null);
});

describe("materialFacts", () => {
  it("reads the studio's registration behind one of our addresses", async () => {
    findLiveByKeyInStudio.mockResolvedValue(row("image"));

    const table = await materialFacts("s1", ["https://ours.example/image/a.png"]);

    expect(findLiveByKeyInStudio).toHaveBeenCalledWith("s1", "image/a.png");
    expect(table.get("https://ours.example/image/a.png")).toEqual({
      kind: "image",
      media: { coverUrl: null, width: 640, height: 480, duration: null, mimeType: "image/png", size: 100 },
    });
  });

  it("leaves out an address that is not ours, without asking the ledger", async () => {
    const table = await materialFacts("s1", ["https://elsewhere.example/a.png"]);

    expect(table.has("https://elsewhere.example/a.png")).toBe(false);
    expect(findLiveByKeyInStudio).not.toHaveBeenCalled();
  });

  it("leaves out an address with no live row in this studio", async () => {
    findLiveByKeyInStudio.mockResolvedValue(null);

    const table = await materialFacts("s1", ["https://ours.example/image/b.png"]);

    expect(table.size).toBe(0);
  });

  it("carries a video's cover", async () => {
    findLiveByKeyInStudio.mockResolvedValue(row("video"));
    findCoverOf.mockResolvedValue(row("image", { id: "c1", fileUrl: "https://ours.example/cover.png" }));

    const table = await materialFacts("s1", ["https://ours.example/video/c.mp4"]);

    expect(findCoverOf).toHaveBeenCalledWith("a1");
    expect(table.get("https://ours.example/video/c.mp4")?.media).toMatchObject({ coverUrl: "https://ours.example/cover.png", duration: 5 });
  });

  it("reads each address once", async () => {
    findLiveByKeyInStudio.mockResolvedValue(row("image"));

    await materialFacts("s1", ["https://ours.example/image/a.png", "https://ours.example/image/a.png"]);

    expect(findLiveByKeyInStudio).toHaveBeenCalledTimes(1);
  });
});
