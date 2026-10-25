// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which lane a generation's output takes into R2 (#181, design §2 and §4.5).
 *
 * Where the bytes are decides it. A synchronous transport answers with a
 * buffer this process is holding, so this process sends it; an async provider
 * answers with a temporary link, and the ingest Worker pulls that where R2
 * already is. Downloading it here and uploading it again would move every byte
 * twice, which is the one thing lane ③ exists to avoid.
 *
 * Neither lane hashes anything locally. The hash the ledger keys on is
 * computed by the Worker over the bytes that really landed, and it comes back
 * as part of what the report registered — so what this file checks is that
 * each output reaches the right lane and pins the canonical URL that came back.
 *
 * No real Redis / DB / storage — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";

const mockUploadBytes = vi.hoisted(() => vi.fn());
const mockTransferUrl = vi.hoisted(() => vi.fn());
const mockAdapterUpload = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

// Owned-object acceptance is covered against PostgreSQL in the cross-service
// suite; this suite isolates transfer lanes from the Project directory.
vi.mock("@worker/services/project-media.service.js", () => ({
  resolveRegisteredProjectMedia: vi.fn(async (_projectId: string, url: string) => ({ assetId: "a1", fileUrl: url, coverUrl: null })),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  getStorageAdapter: vi.fn().mockResolvedValue({
    upload: mockAdapterUpload,
    // Only a URL already in our own bucket answers true; see `oursUrl` below.
    keyFromUrl: (url: string) =>
      url.startsWith("https://our-bucket/") ? url.slice("https://our-bucket/".length) : null,
    publicUrl: (key: string) => `https://our-bucket/${key}`,
  }),
  publishNodeEvent: vi.fn(),
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() },
  NotFoundError: class NotFoundError extends Error {},
}));
// Real but for the services driven here, so the table naming the side-effect
// events is the library's own rather than a copy typed in a test.
vi.mock("@breatic/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof domainModule>()),
  // The catalog serves only models with a key set, and tests set none; this
  // holds the one entry the enhance tool is pinned to, as its yaml declares it.
  modelCatalog: {
    getModelCatalog: () => ({
      image: [],
      video: [],
      audio: [{ name: "veed-clean-audio", output_type: "audio/wav" }],
      tts: [],
      three_d: [],
    }),
  },
  backendUploadService: {
    uploadBytesToStorage: mockUploadBytes,
    transferUrlToStorage: mockTransferUrl,
  },
  assetService: { register: vi.fn() },
  taskService: {
    getByIdInternal: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    markCompletedAndBill: vi.fn(),
    recordProviderResult: vi.fn(),
  },
  nodeHistoryService: { recordGenerationSuccess: vi.fn(), recordGenerationFailure: vi.fn() },
  getModel: vi.fn(),
  buildToolSet: vi.fn(),
  extractPromptText: vi.fn(),
}));
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

import { declaredOutputType, persistOutputs } from "@worker/handlers/dispatch.js";

/** One sync-transport output: bytes this process is holding. */
function bufferOutput(): { extra: Record<string, unknown> } {
  return { extra: { buffer: Buffer.from("gen-bytes"), contentType: "image/png" } };
}

const PROVIDER_URL = "https://provider.example/tmp/out.png";
const CANONICAL = "https://our-bucket/image/2026-01-01/canonical.png";

const DEADLINE = 1_900_000_000_000;
const baseOpts = { taskType: "image", userId: "u1", projectId: "p1", taskId: "t1", deadlineAt: DEADLINE };

beforeEach(() => {
  mockUploadBytes.mockReset().mockResolvedValue({ assetId: "a1", fileUrl: CANONICAL });
  mockTransferUrl.mockReset().mockResolvedValue({ assetId: "a1", fileUrl: CANONICAL });
  mockAdapterUpload.mockReset();
  mockWarn.mockReset();
});

// inner#1305 §7.4: a model that declares what it returns is stored as that,
// key and served type alike; the rest keep the task type's.
describe("persistOutputs — the type a declared output is stored as", () => {
  it("names a link's key and type after the model's declared output", async () => {
    await persistOutputs([{ url: PROVIDER_URL }], {}, { ...baseOpts, taskType: "audio", outputType: "audio/wav" });
    expect(mockTransferUrl.mock.calls[0]?.[1]).toMatchObject({ ext: ".wav", contentType: "audio/wav" });
  });

  // A mini-tool's job carries no model: a model tool's comes from the
  // registry, which is what its run is pinned to.
  it("reads the declared output of the model a mini-tool is pinned to", () => {
    expect(declaredOutputType(undefined, "audio.enhance")).toBe("audio/wav");
  });

  it("reads none for a container mini-tool or a model that declares nothing", () => {
    expect(declaredOutputType(undefined, "audio.denoise")).toBeUndefined();
    expect(declaredOutputType(undefined, undefined)).toBeUndefined();
  });

  it("keeps the task type's when the model declares nothing", async () => {
    await persistOutputs([{ url: PROVIDER_URL }], {}, { ...baseOpts, taskType: "audio" });
    expect(mockTransferUrl.mock.calls[0]?.[1]).toMatchObject({ ext: ".mp3", contentType: "audio/mpeg" });
  });
});

describe("persistOutputs — the lane an output takes", () => {
  it("sends bytes it is holding, and pins what came back", async () => {
    const out = await persistOutputs([bufferOutput()], {}, baseOpts);

    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    expect(mockUploadBytes.mock.calls[0]?.[1]).toMatchObject({
      projectId: "p1",
      actingUserId: "u1",
      // What the asset is and what produced it travel on the grant, since the
      // Worker's report knows only what the ticket told it.
      assetSource: "ai",
      generationTaskId: "t1",
      contentType: "image/png",
      ext: ".png",
      // Storing is the last leg of the task, so it runs out when the task does.
      deadlineAt: DEADLINE,
    });
    // The registered row's canonical, never the key just written: on a dedup
    // hit that key lost and is queued for reclaim, so pinning it would 404.
    expect(out[0]!.url).toBe(CANONICAL);
    // The buffer is not left on the output — it has been stored.
    expect(out[0]!.extra?.buffer).toBeUndefined();
  });

  it("hands a provider's link over without reading it here", async () => {
    const out = await persistOutputs([{ url: PROVIDER_URL }], {}, baseOpts);

    expect(mockTransferUrl).toHaveBeenCalledTimes(1);
    expect(mockTransferUrl.mock.calls[0]?.[0]).toBe(PROVIDER_URL);
    // The grant is the only thing the report handler learns this asset's
    // identity from — the Worker fetched a link and knows nothing else about
    // it — so lane ③ has to declare as much as lane ② does. A link carries no
    // type either, so the extension and the content type come off the task.
    expect(mockTransferUrl.mock.calls[0]?.[1]).toMatchObject({
      projectId: "p1",
      actingUserId: "u1",
      assetSource: "ai",
      generationTaskId: "t1",
      taskType: "image",
      ext: ".png",
      contentType: "image/png",
      deadlineAt: DEADLINE,
    });
    // The whole point of lane ③: those bytes never pass through this process.
    expect(mockUploadBytes).not.toHaveBeenCalled();
    expect(mockAdapterUpload).not.toHaveBeenCalled();
    expect(out[0]!.url).toBe(CANONICAL);
    // Kept so a support question about a generation can still name where the
    // provider served it from.
    expect(out[0]!.extra?.url_original).toBe(PROVIDER_URL);
  });

  // The frame is cut in the media container while the transfer's own finish
  // waits on it, so it comes back with the rest of the answer. Extracting it
  // afterwards is what left a generation's cover unlinked from its row (#201).
  it("pins the cover the transfer came back with", async () => {
    mockTransferUrl.mockResolvedValueOnce({
      assetId: "a1",
      fileUrl: CANONICAL,
      kind: "video",
      coverUrl: "https://our-bucket/video/2026-01-01/1_uuid_cover.png",
    });

    const out = await persistOutputs([{ url: PROVIDER_URL }], {}, {
      ...baseOpts,
      taskType: "video",
    });

    expect(out[0]!.cover_url).toBe(
      "https://our-bucket/video/2026-01-01/1_uuid_cover.png",
    );
  });

  // The row holds them, and a generated node has no other way to read them —
  // without this it measures its own media in the browser and shows nothing
  // until the bytes have decoded (A1).
  it("pins the numbers the transfer came back with", async () => {
    mockTransferUrl.mockResolvedValueOnce({
      assetId: "a1",
      fileUrl: CANONICAL,
      kind: "video",
      coverUrl: null,
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
    });

    const out = await persistOutputs([{ url: PROVIDER_URL }], {}, {
      ...baseOpts,
      taskType: "video",
    });

    expect(out[0]).toMatchObject({
      width: 1920,
      height: 1080,
      duration_seconds: 12.5,
    });
  });

  it("leaves a url already ours alone", async () => {
    // A local mini-tool's output has been through this once. Pulling our own
    // object would store a second copy of it.
    const oursUrl = "https://our-bucket/image/2026-01-01/local-tool.png";

    const out = await persistOutputs([{ url: oursUrl }], {}, baseOpts);

    expect(mockTransferUrl).not.toHaveBeenCalled();
    expect(out[0]!.url).toBe(oursUrl);
  });

  it("fails the task when bytes it is holding cannot be stored", async () => {
    // These bytes exist nowhere else, so there is no url to fall back to.
    // Stage 2 turns the throw into markFailed with no charge.
    mockUploadBytes.mockRejectedValueOnce(new Error("the worker refused it"));

    await expect(
      persistOutputs([bufferOutput()], {}, baseOpts),
    ).rejects.toThrow("the worker refused it");
  });

  it("fails the task when a transfer cannot be made", async () => {
    // A node pinned to nothing is worse than a generation that reports having
    // failed, so this is not best-effort the way a cover is. An answer with no
    // url is the same failure and arrives the same way: the store itself
    // refuses to hand back an asset it did not file.
    mockTransferUrl.mockRejectedValueOnce(new Error("the worker refused it"));

    await expect(
      persistOutputs([{ url: PROVIDER_URL }], {}, baseOpts),
    ).rejects.toThrow("the worker refused it");
  });
});

describe("persistOutputs — the provider's own extra fields", () => {
  it("transfers them too, and pins the canonical", async () => {
    const extras: Record<string, unknown> = { audio_url: PROVIDER_URL };

    await persistOutputs([], extras, baseOpts);

    expect(mockTransferUrl).toHaveBeenCalledWith(PROVIDER_URL, expect.anything());
    // #181 §4.8: this used to keep the key just written, which on a dedup hit
    // is the loser — queued for reclaim, so the field would name a 404.
    expect(extras.audio_url).toBe(CANONICAL);
    expect(extras.audio_url_original).toBe(PROVIDER_URL);
  });

  it("keeps the original when a transfer fails, without failing the task", async () => {
    // None of these is what the node shows, so a generation that produced its
    // deliverable is not failed over one of them.
    mockTransferUrl.mockRejectedValueOnce(new Error("the worker refused it"));
    const extras: Record<string, unknown> = { video_url: PROVIDER_URL };

    await persistOutputs([], extras, baseOpts);

    expect(extras.video_url).toBe(PROVIDER_URL);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ field: "video_url" }),
      expect.stringContaining("keeping original"),
    );
  });
});
