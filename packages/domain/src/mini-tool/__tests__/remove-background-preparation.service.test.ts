// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@breatic/core";
import type * as coreModule from "@breatic/core";
import type * as assetRepoModule from "@domain/asset/asset.repo.js";
import type * as modelCatalogModule from "@domain/model-catalog/model-catalog.js";
import type { ModelCatalog, ModelEntry, StudioAssetEntity } from "@breatic/shared";
import type { MiniToolAnalysisRequest, MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import { prepareVideoRemoveBackground } from "@domain/mini-tool/remove-background-preparation.service.js";

const { getStorageAdapter, keyFromUrl, publicUrl, findLiveByStorageKey, getModelCatalog, estimateModelCredits } = vi.hoisted(() => ({
  getStorageAdapter: vi.fn(), keyFromUrl: vi.fn(), publicUrl: vi.fn(), findLiveByStorageKey: vi.fn(), getModelCatalog: vi.fn(), estimateModelCredits: vi.fn(),
}));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(), getStorageAdapter, env: { CREDIT_MULTIPLIER: 2 } }));
vi.mock("@domain/asset/asset.repo.js", async (original) => ({ ...await original<typeof assetRepoModule>(), findLiveByStorageKey }));
vi.mock("@domain/model-catalog/model-catalog.js", async (original) => ({ ...await original<typeof modelCatalogModule>(), getModelCatalog, estimateModelCredits }));

const URL = "https://assets.example.test/video/source.mp4";
const KEY = "video/source.mp4";
const MODEL = "M";
const BODY = { video: URL, background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true };

/** Return a fresh caller-owned source with no authority over registered measurements.
 * @throws {never} Never.
 */
function source(): MiniToolAnalysisRequest["source"] {
  return { nodeId: "20000000-0000-4000-8000-000000000001", canonicalURL: URL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } };
}

/** Return an original registered source owned independently of any target project.
 * @throws {never} Never.
 */
function asset(): StudioAssetEntity {
  return { id: "10000000-0000-4000-8000-000000000001", studioId: "30000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), storageKey: KEY,
    fileUrl: URL, sizeBytes: 1024, mimeType: "video/mp4", kind: "video", source: "upload", producedByUserId: "40000000-0000-4000-8000-000000000001",
    generationTaskId: null, width: 960, height: 540, durationSeconds: 5.055, createdAt: new Date("2026-10-24T00:00:00Z"), deletedAt: null };
}

/** Supply synthetic served catalog facts; pricing is stubbed, with no inferred production formula.
 * @throws {never} Never.
 */
function entry(): ModelEntry {
  return { name: MODEL, display_name: "Fixture video remover", modality: "video", mode: "video-to-video", description: "", guide: "", tier: "internal", generation_time: 1,
    takes_prompt: false, params: { video: { description: "", default: null, max_total_duration: 60 } },
    availability: { upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] } };
}

/** Group the served fixture in the existing catalog shape rather than creating another model registry.
 * @throws {never} Never.
 */
function catalog(model: ModelEntry = entry()): ModelCatalog {
  return { image: [], video: [model], audio: [], tts: [], three_d: [], total: 1, credit_multiplier: 2 };
}

/** State the independently fixed registered binding, without calling the resolver to produce expected data.
 * @throws {never} Never.
 */
function binding(): MiniToolSourceBinding {
  return { assetId: "10000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: URL, kind: "video", mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } };
}

/** Hold one existing asynchronous dependency without changing its contract.
 * @throws {never} Never.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => { resolve = release; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  keyFromUrl.mockImplementation((url: string) => url === URL ? KEY : null);
  publicUrl.mockReturnValue(URL);
  getStorageAdapter.mockResolvedValue({ keyFromUrl, publicUrl });
  findLiveByStorageKey.mockResolvedValue(asset());
  getModelCatalog.mockReturnValue(catalog());
  estimateModelCredits.mockResolvedValue({ credits: 30, bound: "exact" });
});

describe("registered video removal preparation", () => {
  it("P1 prepares the complete original B/I, binding, key, selected model and quote without analysis input", async () => {
    const input = source(); const before = structuredClone(input);
    expect(await prepareVideoRemoveBackground(input, MODEL)).toEqual({ binding: binding(), sourceKey: KEY, model: MODEL, params: BODY });
    expect(estimateModelCredits).not.toHaveBeenCalled();
    expect(keyFromUrl).toHaveBeenCalledWith(URL);
    expect(findLiveByStorageKey).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(input).toEqual(before);
  });
  it("P2 ignores client width, height and duration claims while preserving registered truth", async () => {
    const input = source(); input.mediaInfo = { ...input.mediaInfo, width: 16, height: 16, duration: 0.1 };
    expect(await prepareVideoRemoveBackground(input, MODEL)).toEqual({ binding: binding(), sourceKey: KEY, model: MODEL, params: BODY });
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
  it("P2 is invariant under arbitrary positive caller measurement claims", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 8192 }), fc.double({ min: 0.001, max: 60, noNaN: true }), async (width, height, duration) => {
      const input = source(); input.mediaInfo = { ...input.mediaInfo, width, height, duration };
      expect(await prepareVideoRemoveBackground(input, MODEL)).toEqual({ binding: binding(), sourceKey: KEY, model: MODEL, params: BODY });
      expect(estimateModelCredits).not.toHaveBeenCalled();
    }));
  });
  it("P3 uses replacement registered geometry, hash and duration and the new explicit quote", async () => {
    findLiveByStorageKey.mockResolvedValue({ ...asset(), width: 1920, height: 1080, durationSeconds: 12.125, contentHash: "b".repeat(64) });
    estimateModelCredits.mockResolvedValue({ credits: 71.23, bound: "exact" });
    expect(await prepareVideoRemoveBackground(source(), MODEL)).toEqual({ binding: { ...binding(), contentHash: "b".repeat(64), mediaInfo: { width: 1920, height: 1080, duration: 12.125, mimeType: "video/mp4" } }, sourceKey: KEY, model: MODEL, params: BODY });
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
  it("P4 freezes the returned model, provider body, binding and quote against subsequent configuration changes", async () => {
    const configured = entry(); getModelCatalog.mockReturnValue(catalog(configured)); const row = asset(); findLiveByStorageKey.mockResolvedValue(row);
    const quote = { credits: 30, bound: "exact" }; estimateModelCredits.mockResolvedValue(quote);
    const prepared = await prepareVideoRemoveBackground(source(), MODEL);
    expect(prepared).toEqual({ binding: binding(), sourceKey: KEY, model: MODEL, params: BODY });
    configured.name = "changed"; configured.params.video!.max_total_duration = 1;
    row.width = 16; row.contentHash = "b".repeat(64); quote.credits = 900;
    expect(prepared).toEqual({ binding: binding(), sourceKey: KEY, model: MODEL, params: BODY });
  });
});

describe("existing source resolver failures before pricing", () => {
  it("P5 propagates the real resolver's ValidationError for a foreign URL without quoting", async () => {
    await expect(prepareVideoRemoveBackground({ ...source(), canonicalURL: "https://foreign.example.test/video.mp4" }, MODEL)).rejects.toBeInstanceOf(ValidationError);
    expect(findLiveByStorageKey).not.toHaveBeenCalled(); expect(estimateModelCredits).not.toHaveBeenCalled();
  });
  it("P6 rejects the repository's no-live-row sentinel, including its soft-deleted source case", async () => {
    findLiveByStorageKey.mockResolvedValue(null);
    await expect(prepareVideoRemoveBackground(source(), MODEL)).rejects.toBeInstanceOf(ValidationError);
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
  it.each(["image", "audio", "document"] as const)("P7 rejects a registered %s through the existing resolver", async (kind) => {
    findLiveByStorageKey.mockResolvedValue({ ...asset(), kind });
    await expect(prepareVideoRemoveBackground(source(), MODEL)).rejects.toBeInstanceOf(ValidationError);
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
  it.each([
    { label: "null width", patch: { width: null } }, { label: "zero width", patch: { width: 0 } }, { label: "fractional width", patch: { width: 1.5 } },
    { label: "null height", patch: { height: null } }, { label: "zero height", patch: { height: 0 } }, { label: "negative height", patch: { height: -1 } },
    { label: "null duration", patch: { durationSeconds: null } }, { label: "zero duration", patch: { durationSeconds: 0 } }, { label: "NaN duration", patch: { durationSeconds: Number.NaN } },
    { label: "empty MIME", patch: { mimeType: "" } }, { label: "invalid hash", patch: { contentHash: "not-a-hash" } },
  ])("P8 preserves binding schema rejection for $label without trusting client facts", async ({ patch }) => {
    findLiveByStorageKey.mockResolvedValue({ ...asset(), ...patch });
    await expect(prepareVideoRemoveBackground(source(), MODEL)).rejects.toBeInstanceOf(ValidationError);
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
  it("P5-P8 propagates an original source-owner infrastructure exception by identity", async () => {
    const failure = new Error("fixture source lookup failure"); getStorageAdapter.mockRejectedValue(failure);
    await expect(prepareVideoRemoveBackground(source(), MODEL)).rejects.toBe(failure);
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
});

// inner#1306 §11.5: whether the model is served here, its vendor limit and its quote are decided where the plan's call is
// admitted (model-call-admission.ts); preparation only needs the catalog to carry the model.
describe("the pinned catalog model", () => {
  it("P9 rejects an absent served catalog entry instead of accepting the minimum task fallback", async () => {
    getModelCatalog.mockReturnValue({ ...catalog(), video: [], total: 0 });
    await expect(prepareVideoRemoveBackground(source(), MODEL)).rejects.toMatchObject({ statusCode: 503 });
    expect(estimateModelCredits).not.toHaveBeenCalled();
  });
});

describe("immutable source and configuration references without an ISO admission gate", () => {
  it.each(["video/webm", "video/quicktime"])("P14 accepts a valid live %s binding without physical track or edit metadata", async (mimeType) => {
    findLiveByStorageKey.mockResolvedValue({ ...asset(), mimeType });
    expect(await prepareVideoRemoveBackground(source(), MODEL)).toEqual({ binding: { ...binding(), mediaInfo: { ...binding().mediaInfo, mimeType } }, sourceKey: KEY, model: MODEL, params: BODY });
  });
  it("P15 freezes the original source reference before an asynchronous resolver resumes", async () => {
    const gate = deferred<{ keyFromUrl: typeof keyFromUrl; publicUrl: typeof publicUrl }>(); getStorageAdapter.mockReturnValueOnce(gate.promise);
    const input = source(); const outcome = prepareVideoRemoveBackground(input, MODEL).then(value => ({ value }), error => ({ error }));
    input.canonicalURL = "https://foreign.example.test/changed.mp4"; input.mediaInfo.duration = 0.1;
    gate.resolve({ keyFromUrl, publicUrl });
    expect(await outcome).toEqual({ value: { binding: binding(), sourceKey: KEY, model: MODEL, params: BODY } });
  });
});
