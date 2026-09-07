// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * resolveVideoCovers — storing the frame and pinning what came back
 * (#1824 / #1826 §4.5, §0 rule 2; #181 lane ②).
 *
 * The frame is a buffer this process is holding, so it reaches R2 the way every
 * other asset does — through the ingest Worker, which files it as a `cover` row
 * and computes its hash over what landed.
 *
 * `cover_url` is pinned ONLY from the url that came back, never from anything
 * this side minted: a dedup hit resolves to a DIFFERENT existing row, and a
 * store that filed nothing has no url at all. Every failure is best-effort — a
 * cover failure NEVER fails the video (#1824).
 *
 * No real Redis / DB / storage — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockUploadBytes = vi.hoisted(() => vi.fn());
const mockExtract = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockGetStorageAdapter = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStorageAdapter: mockGetStorageAdapter,
  publishNodeEvent: vi.fn(),
  getStreamRedis: vi.fn(),
  getWorkerConfig: vi.fn(),
  projectActivitiesRepo: {},
  publishActivityNew: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() },
  NotFoundError: class NotFoundError extends Error {},
}));
vi.mock("@breatic/domain", () => ({
  backendUploadService: { uploadBytesToStorage: mockUploadBytes },
  taskService: {
    getByIdInternal: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    markCompletedAndBill: vi.fn(),
    recordProviderResult: vi.fn(),
    setResolvedSkills: vi.fn(),
  },
  nodeHistoryService: { recordGenerationSuccess: vi.fn(), recordGenerationFailure: vi.fn() },
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  buildToolSet: vi.fn(),
  getSkillRegistry: vi.fn(),
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
}));
vi.mock("@worker/mini-tool-registry.js", () => ({ resolveMiniToolEntry: vi.fn() }));
vi.mock("@worker/handlers/local/index.js", () => ({ runLocalHandler: vi.fn() }));
vi.mock("@worker/providers/video-cover.js", () => ({ extractVideoCover: mockExtract }));
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

import { resolveVideoCovers } from "@worker/handlers/dispatch.js";

/** What the extractor hands back: the frame, and the type it is served as. */
const COVER = { png: Buffer.from("png-bytes"), mimeType: "image/png" };

/** The url the store answered with — a row that may or may not be a new one. */
const CANONICAL = "https://cdn/image/2026-01-01/existing.png";

const CTX = { taskId: "t1", userId: "u1", projectId: "p1" as string | undefined };

beforeEach(() => {
  vi.clearAllMocks();
  mockExtract.mockResolvedValue(COVER);
  mockUploadBytes.mockResolvedValue({ assetId: "cover-1", fileUrl: CANONICAL });
  mockGetStorageAdapter.mockResolvedValue({
    upload: vi.fn(),
    isOwnUrl: () => true,
    publicUrl: (key: string) => `https://cdn/${key}`,
  });
});

/** A fresh video output object (held by direct ref so the in-place mutation is
 * observable without an index access under `noUncheckedIndexedAccess`). */
function videoOut(): { url?: string; cover_url?: string } {
  return { url: "https://cdn/clip.mp4" };
}

describe("resolveVideoCovers — the frame's trip to R2 (#1826 §4.5 / §0 rule 2)", () => {
  it("sends the frame as a cover, and pins the url that came back", async () => {
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    expect(mockUploadBytes).toHaveBeenCalledExactlyOnceWith(
      COVER.png,
      expect.objectContaining({
        projectId: "p1",
        actingUserId: "u1",
        // What this is travels on the grant: the Worker's report knows only
        // what the ticket told it, so `cover` cannot be inferred there.
        assetSource: "cover",
        generationTaskId: "t1",
        // The cover owns its format (§8 PNG), so the type comes from the
        // extractor rather than being restated here.
        contentType: "image/png",
      }),
    );
    // On a dedup hit this is an existing row whose key differs from the one
    // just written; that one is queued for reclaim, so anything minted on this
    // side would 404 (§0 rule 2).
    expect(out.cover_url).toBe(CANONICAL);
  });

  it("degrades to Film when the frame could not be stored (#1824 best-effort)", async () => {
    mockUploadBytes.mockRejectedValue(new Error("the worker refused it"));
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    // No row anyone may serve → show Film, never pin something unregistered.
    expect(out.cover_url).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1" }),
      "video_cover_register_failed_non_fatal",
    );
  });

  it("degrades to Film when the store answered with no url", async () => {
    mockUploadBytes.mockResolvedValue({ assetId: null });
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    expect(out.cover_url).toBeUndefined();
  });

  it("no project → nothing to store it against → degrade to Film", async () => {
    const out = videoOut();

    await resolveVideoCovers([out], { taskId: "t1", userId: "u1", projectId: undefined });

    expect(out.cover_url).toBeUndefined();
    expect(mockUploadBytes).not.toHaveBeenCalled();
  });

  it("extraction returns undefined → cover_url undefined, nothing stored", async () => {
    mockExtract.mockResolvedValue(undefined);
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    expect(out.cover_url).toBeUndefined();
    expect(mockUploadBytes).not.toHaveBeenCalled();
  });

  it("a synchronous throw from the extractor NEVER propagates (#1824)", async () => {
    // Thrown rather than rejected: a synchronous throw from an awaited call is
    // caught by the same handler, and this is the shape a broken native
    // dependency takes once the module has loaded. The load itself failing is
    // the outer guard's job, in `resolve-video-covers-setup.test.ts`.
    mockExtract.mockImplementation(() => {
      throw new Error("sharp is broken");
    });
    const out = videoOut();

    await expect(resolveVideoCovers([out], CTX)).resolves.toBeUndefined();

    expect(out.cover_url).toBeUndefined();
  });

  it("a throw inside the loop NEVER propagates either (#1824)", async () => {
    // Defense in depth: the setup guard above catches what happens before the
    // loop, this one what happens inside it. A cover failure of any shape
    // leaves a cover-less video rather than a failed one.
    mockUploadBytes.mockImplementation(() => {
      throw new Error("something in the loop exploded");
    });
    const out = videoOut();

    await expect(resolveVideoCovers([out], CTX)).resolves.toBeUndefined();

    expect(out.cover_url).toBeUndefined();
  });

  it("skips outputs that already have a cover_url or a non-string url", async () => {
    const kept: { url?: string; cover_url?: string } = {
      url: "https://cdn/a.mp4",
      // Deliberately a legacy `.webp`: this branch skips outputs that ALREADY
      // carry a cover_url, and the skip is a truthiness check on the field
      // (`dispatch.ts`), so the value is never parsed. Left as webp so the
      // fixture also stands for a cover produced before the format changed.
      cover_url: "https://cdn/kept.webp",
    };
    const noUrl: { url?: string; cover_url?: string } = { cover_url: undefined };

    await resolveVideoCovers([kept, noUrl], CTX);

    expect(kept.cover_url).toBe("https://cdn/kept.webp");
    expect(noUrl.cover_url).toBeUndefined();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockUploadBytes).not.toHaveBeenCalled();
  });
});
