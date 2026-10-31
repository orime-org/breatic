// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ProjectAssetReferenceEntity, StudioAssetEntity } from "@breatic/shared";
import * as assetRepo from "@core/asset/asset.repo.js";
import { inspectRegisteredProjectMedia, referenceRegisteredProjectMediaDetailed } from "@core/asset/project-asset-reference.service.js";
import { findLiveOwnerStudioId } from "@core/project/projects.repo.js";

const boundary = vi.hoisted(() => ({ tx: Object.freeze({ name: "classifier-unit-transaction" }), keys: new Map<string, string>() }));
vi.mock("@core/db/client.js", () => ({
  db: { transaction: async (run: (tx: object) => Promise<unknown>): Promise<unknown> => run(boundary.tx) },
}));
vi.mock("@core/project/projects.repo.js", () => ({ findLiveOwnerStudioId: vi.fn() }));
vi.mock("@core/asset/asset.repo.js", () => ({
  findLiveMediaIdentities: vi.fn(), findLiveProjectReferences: vi.fn(),
  findLiveManyInStudio: vi.fn(), ensureProjectReferencesDetailed: vi.fn(),
}));
vi.mock("@core/infra/storage/index.js", () => ({
  getStorageAdapter: async (): Promise<object> => ({ keyFromUrl: (url: string): string | null => boundary.keys.get(url) ?? null }),
}));

const PROJECT_A = "30000000-0000-4000-8000-000000000001";
const PROJECT_B = "30000000-0000-4000-8000-000000000002";
const STUDIO_A = "20000000-0000-4000-8000-000000000001";
const STUDIO_B = "20000000-0000-4000-8000-000000000002";
const FILE_URL = "https://assets.test.invalid/shared/video.mp4";
const STORAGE_KEY = "shared/video.mp4";
const LOCAL: StudioAssetEntity = {
  id: "10000000-0000-4000-8000-000000000001", studioId: STUDIO_A,
  contentHash: "shared-bytes-hash", storageKey: STORAGE_KEY, fileUrl: FILE_URL,
  sizeBytes: 8192, mimeType: "video/mp4", kind: "video", source: "upload",
  producedByUserId: "40000000-0000-4000-8000-000000000001", generationTaskId: null,
  width: 1280, height: 720, durationSeconds: 2.5, createdAt: new Date(0), deletedAt: null,
};
const FOREIGN: StudioAssetEntity = { ...LOCAL, id: "10000000-0000-4000-8000-000000000002", studioId: STUDIO_B };
const THIRD: StudioAssetEntity = { ...LOCAL, id: "10000000-0000-4000-8000-000000000003", studioId: "20000000-0000-4000-8000-000000000003" };
const COPIES = [LOCAL, FOREIGN, THIRD];

/**
 * Provide a repository-boundary relationship for an accepted canonical identity.
 * @throws {never} Never.
 */
function reference(projectId: string, assetId: string): ProjectAssetReferenceEntity {
  return { id: assetId.replace(/^1/, "5"), projectId, assetId, displayName: null, createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.keys.clear();
  boundary.keys.set(FILE_URL, STORAGE_KEY);
  vi.mocked(findLiveOwnerStudioId).mockImplementation(async (projectId) => projectId === PROJECT_B ? STUDIO_B : STUDIO_A);
  vi.mocked(assetRepo.findLiveMediaIdentities).mockResolvedValue([LOCAL, FOREIGN]);
  vi.mocked(assetRepo.findLiveProjectReferences).mockResolvedValue([]);
  vi.mocked(assetRepo.findLiveManyInStudio).mockImplementation(async (studioId, ids) => COPIES.filter((asset) => asset.studioId === studioId && ids.includes(asset.id)));
  vi.mocked(assetRepo.ensureProjectReferencesDetailed).mockImplementation(async (projectId, ids) => ({
    references: ids.map((id) => reference(projectId, id)), insertedAssetIds: [...ids],
  }));
});

describe.each(["inspect", "accept"] as const)("%s registered media with shared storage keys", (mode) => {
  it.each(["local-first", "local-last"] as const)("uses the current Project's local live copy when repository order is %s", async (order) => {
    const rows = order === "local-first" ? [LOCAL, FOREIGN] : [FOREIGN, LOCAL];
    vi.mocked(assetRepo.findLiveMediaIdentities).mockResolvedValue(rows);
    const input = { projectId: PROJECT_A, urls: [FILE_URL] };
    const result = mode === "inspect" ? await inspectRegisteredProjectMedia(input) : await referenceRegisteredProjectMediaDetailed(input);
    expect(result.resolution).toEqual({ resolved: [{ kind: "url", reference: FILE_URL, asset: LOCAL }], unavailable: [] });
    expect(assetRepo.findLiveMediaIdentities).toHaveBeenCalledWith([], [STORAGE_KEY], boundary.tx);
    if (mode === "inspect") {
      expect(assetRepo.findLiveProjectReferences).toHaveBeenCalledWith(PROJECT_A, [LOCAL.id], boundary.tx);
      expect(assetRepo.ensureProjectReferencesDetailed).toHaveBeenCalledTimes(0);
    } else {
      expect(assetRepo.ensureProjectReferencesDetailed).toHaveBeenCalledWith(PROJECT_A, [LOCAL.id], {}, boundary.tx);
      expect(result.references).toEqual([reference(PROJECT_A, LOCAL.id)]);
    }
  });

  it("keeps an explicit foreign asset ID forbidden while resolving its shared URL to the local copy", async () => {
    const input = { projectId: PROJECT_A, assetIds: [FOREIGN.id, LOCAL.id, FOREIGN.id], urls: [FILE_URL, FILE_URL] };
    const result = mode === "inspect" ? await inspectRegisteredProjectMedia(input) : await referenceRegisteredProjectMediaDetailed(input);
    expect(result.resolution).toEqual({
      resolved: [
        { kind: "assetId", reference: LOCAL.id, asset: LOCAL },
        { kind: "url", reference: FILE_URL, asset: LOCAL },
      ],
      unavailable: [{ kind: "assetId", reference: FOREIGN.id, reason: "foreign_studio" }],
    });
    if (mode === "accept") expect(assetRepo.ensureProjectReferencesDetailed).toHaveBeenCalledWith(PROJECT_A, [LOCAL.id], {}, boundary.tx);
  });

  it("classifies a key with only foreign live copies as foreign when the local copy is no longer live", async () => {
    vi.mocked(assetRepo.findLiveMediaIdentities).mockResolvedValue([FOREIGN, THIRD]);
    const input = { projectId: PROJECT_A, assetIds: [LOCAL.id], urls: [FILE_URL] };
    const result = mode === "inspect" ? await inspectRegisteredProjectMedia(input) : await referenceRegisteredProjectMediaDetailed(input);
    expect(result.resolution).toEqual({
      resolved: [],
      unavailable: [
        { kind: "assetId", reference: LOCAL.id, reason: "unregistered" },
        { kind: "url", reference: FILE_URL, reason: "foreign_studio" },
      ],
    });
    expect(result.references).toEqual([]);
    if (mode === "accept") expect(assetRepo.ensureProjectReferencesDetailed).toHaveBeenCalledWith(PROJECT_A, [], {}, boundary.tx);
  });

  it("classifies the URL as unregistered when no Studio has a live copy of the key", async () => {
    vi.mocked(assetRepo.findLiveMediaIdentities).mockResolvedValue([]);
    const input = { projectId: PROJECT_A, assetIds: [LOCAL.id], urls: [FILE_URL] };
    const result = mode === "inspect" ? await inspectRegisteredProjectMedia(input) : await referenceRegisteredProjectMediaDetailed(input);
    expect(result.resolution).toEqual({
      resolved: [],
      unavailable: [
        { kind: "assetId", reference: LOCAL.id, reason: "unregistered" },
        { kind: "url", reference: FILE_URL, reason: "unregistered" },
      ],
    });
    expect(result.references).toEqual([]);
  });

  it("preserves current-Studio URL ownership and explicit-ID scope across generated row permutations and duplicate references", async () => {
    await fc.assert(fc.asyncProperty(
      fc.shuffledSubarray(COPIES, { minLength: COPIES.length, maxLength: COPIES.length }),
      fc.boolean(),
      fc.array(fc.constantFrom("own", "foreign", "url"), { maxLength: 12 }),
      async (rows, selectB, duplicates) => {
        vi.clearAllMocks();
        vi.mocked(assetRepo.findLiveMediaIdentities).mockResolvedValue(rows);
        const own = selectB ? FOREIGN : LOCAL;
        const foreign = selectB ? LOCAL : FOREIGN;
        const projectId = selectB ? PROJECT_B : PROJECT_A;
        const assetIds = [own.id, foreign.id, ...duplicates.flatMap((kind) => kind === "url" ? [] : [kind === "own" ? own.id : foreign.id])];
        const urls = [FILE_URL, ...duplicates.flatMap((kind) => kind === "url" ? [FILE_URL] : [])];
        const result = mode === "inspect"
          ? await inspectRegisteredProjectMedia({ projectId, assetIds, urls })
          : await referenceRegisteredProjectMediaDetailed({ projectId, assetIds, urls });
        expect(result.resolution).toEqual({
          resolved: [
            { kind: "assetId", reference: own.id, asset: own },
            { kind: "url", reference: FILE_URL, asset: own },
          ],
          unavailable: [{ kind: "assetId", reference: foreign.id, reason: "foreign_studio" }],
        });
        if (mode === "accept") {
          expect(assetRepo.ensureProjectReferencesDetailed).toHaveBeenCalledWith(projectId, [own.id], {}, boundary.tx);
          expect(result.references).toEqual([reference(projectId, own.id)]);
        } else {
          expect(assetRepo.findLiveProjectReferences).toHaveBeenCalledWith(projectId, [own.id], boundary.tx);
          expect(assetRepo.ensureProjectReferencesDetailed).toHaveBeenCalledTimes(0);
        }
      },
    ), { numRuns: 40 });
  });
});
