// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

const { getProject, findLiveInStudio } = vi.hoisted(() => ({
  getProject: vi.fn(),
  findLiveInStudio: vi.fn(),
}));

vi.mock("@server/modules/project/project.service.js", () => ({ get: getProject }));
vi.mock("@breatic/domain", () => ({ assetRepo: { findLiveInStudio } }));

import { NotFoundError } from "@breatic/core";
import { resolveSceneAsset } from "@server/modules/asset/scene-asset.service.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const STUDIO = "33333333-3333-4333-8333-333333333333";
const USER = "viewer-1";

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue({ studioId: STUDIO });
  findLiveInStudio.mockResolvedValue(null);
});

describe("resolveSceneAsset", () => {
  it("returns the registered GLB descriptor after checking Project access", async () => {
    const mimeType = "model/gltf-binary";
    const url = "https://assets.example.test/registered-model";
    findLiveInStudio.mockImplementation(async () => {
      expect(getProject).toHaveBeenCalledWith(PROJECT, USER);
      return { fileUrl: url, mimeType };
    });

    expect(await resolveSceneAsset(PROJECT, USER, ASSET)).toEqual({ url, mimeType });
    expect(findLiveInStudio).toHaveBeenCalledWith(STUDIO, ASSET);
  });

  it("leaves glTF bundles to the import follow-up because the current loader supports GLB", async () => {
    findLiveInStudio.mockResolvedValue({ fileUrl: "https://assets.example.test/scene.gltf", mimeType: "model/gltf+json" });
    await expect(resolveSceneAsset(PROJECT, USER, ASSET)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not look up any asset if Project reading is denied", async () => {
    const denied = new NotFoundError("not found");
    getProject.mockRejectedValue(denied);

    await expect(resolveSceneAsset(PROJECT, USER, ASSET)).rejects.toBe(denied);
    expect(findLiveInStudio).not.toHaveBeenCalled();
  });

  it.each(["missing", "another Studio's", "deleted"])(
    "answers not found when the live-in-Studio repository excludes a %s asset",
    async () => {
      // findLiveInStudio filters both studio_id and deleted_at in its query.
      findLiveInStudio.mockResolvedValue(null);
      await expect(resolveSceneAsset(PROJECT, USER, ASSET)).rejects.toBeInstanceOf(NotFoundError);
      expect(findLiveInStudio).toHaveBeenCalledWith(STUDIO, ASSET);
    },
  );

  it("INVARIANT: every unsupported MIME remains unavailable to the scene", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string().filter((mime) => mime !== "model/gltf-binary"),
      async (mimeType) => {
        findLiveInStudio.mockResolvedValue({ fileUrl: "https://assets.example.test/non-model", mimeType });
        await expect(resolveSceneAsset(PROJECT, USER, ASSET)).rejects.toBeInstanceOf(NotFoundError);
      },
    ), { numRuns: 50 });
  });

  it("INVARIANT: asset ids never change the Studio selected by Project authorization", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), async (assetId) => {
      findLiveInStudio.mockClear();
      findLiveInStudio.mockResolvedValue(null);

      await expect(resolveSceneAsset(PROJECT, USER, assetId)).rejects.toBeInstanceOf(NotFoundError);
      expect(findLiveInStudio.mock.calls).toEqual([[STUDIO, assetId]]);
    }), { numRuns: 30 });
  });
});
