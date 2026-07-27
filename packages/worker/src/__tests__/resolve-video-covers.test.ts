// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * resolveVideoCovers — cover registration + canonical pin (#1824 / #1826 §4.5,
 * §0 rule 2). Gate-2 R3 G11 regression guard.
 *
 * A video output's `cover_url` must be pinned ONLY from the REGISTERED canonical
 * (`adapter.publicUrl(asset.storageKey)`), NEVER the just-uploaded `cover.key`:
 *   - a dedup hit resolves to a DIFFERENT existing row → cover.key is a discarded
 *     duplicate (orphan);
 *   - a register failure commits NO row → cover.key is an orphan;
 *   - no project → the cover can't be registered → degrade to Film.
 * Pinning cover.key in any of these leaves an offline-GC orphan → 404. Every
 * failure is best-effort — a cover failure NEVER fails the video (#1824).
 *
 * No real Redis / DB / storage — everything is mocked (same pattern as
 * persist-node-bound-register.test.ts).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockPublicUrl = vi.hoisted(() => vi.fn((key: string) => `https://cdn/${key}`));
const mockRegister = vi.hoisted(() => vi.fn());
const mockExtract = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockGetStorageAdapter = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStorageAdapter: mockGetStorageAdapter,
  sha256Hex: () => "a".repeat(64),
  storageKey: () => "image/2026-07-25/gen.png",
  downloadAndStore: vi.fn(),
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
  assetService: { register: mockRegister },
  taskService: {
    getByIdInternal: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    markCompletedAndBill: vi.fn(),
    recordProviderResult: vi.fn(),
    setResolvedSkills: vi.fn(),
  },
  creditService: { deduct: vi.fn() },
  nodeHistoryService: { recordGenerationSuccess: vi.fn(), recordGenerationFailure: vi.fn() },
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  buildToolSet: vi.fn(),
  getSkillRegistry: vi.fn(),
  extractPromptText: vi.fn(),
  releaseCanvasNodeLock: vi.fn(),
  reacquireCanvasNodeLock: vi.fn(),
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

/** The cover the extractor uploads (its `key` / `url` = the JUST-UPLOADED object). */
const COVER = {
  url: "https://cdn/image/2026-07-25/uploaded.webp",
  key: "image/2026-07-25/uploaded.webp",
  sha256: "c".repeat(64),
  sizeBytes: 1234,
  mimeType: "image/webp",
};

const CTX = { taskId: "t1", userId: "u1", projectId: "p1" as string | undefined };

beforeEach(() => {
  vi.clearAllMocks();
  mockPublicUrl.mockImplementation((key: string) => `https://cdn/${key}`);
  mockExtract.mockResolvedValue(COVER);
  mockGetStorageAdapter.mockResolvedValue({
    upload: vi.fn(),
    isOwnUrl: () => true,
    publicUrl: mockPublicUrl,
  });
});

/** A fresh video output object (held by direct ref so the in-place mutation is
 * observable without an index access under `noUncheckedIndexedAccess`). */
function videoOut(): { url?: string; cover_url?: string } {
  return { url: "https://cdn/clip.mp4" };
}

describe("resolveVideoCovers — cover canonical pin (#1826 §4.5 / §0 rule 2)", () => {
  it("register success → pins the REGISTERED canonical (publicUrl of the row's storageKey)", async () => {
    mockRegister.mockResolvedValue({
      asset: { storageKey: "image/2026-07-25/uploaded.webp" },
      deduped: false,
    });
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    expect(out.cover_url).toBe("https://cdn/image/2026-07-25/uploaded.webp");
    // Registered with the cover's OWN mime (§8 webp, can't drift) + source/kind.
    expect(mockRegister).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: "p1",
        storageKey: "image/2026-07-25/uploaded.webp",
        mimeType: "image/webp",
        kind: "image",
        source: "cover",
        generationTaskId: "t1",
      }),
    );
  });

  it("DEDUP hit → pins the EXISTING row's canonical, NOT the just-uploaded cover.key (§0 rule 2)", async () => {
    // The content already existed under a DIFFERENT key; register returns that
    // existing row. The just-uploaded cover.key is now a discarded duplicate
    // (orphan) — pinning it would 404 once the offline GC reclaims it.
    mockRegister.mockResolvedValue({
      asset: { storageKey: "image/2026-01-01/existing.webp" },
      deduped: true,
    });
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    expect(out.cover_url).toBe("https://cdn/image/2026-01-01/existing.webp");
    // NEVER the just-uploaded (duplicate) key.
    expect(out.cover_url).not.toBe(COVER.url);
    expect(out.cover_url).not.toBe("https://cdn/image/2026-07-25/uploaded.webp");
  });

  it("DEDUP hit whose reclaim-queue insert failed still pins the canonical, and LOGS the swallowed sentinel", async () => {
    // The library layer may not log (@domain/CLAUDE.md), so register() reports a
    // failed reclaim-queue insert as a `reclaimQueueFailed` sentinel. Dropping
    // it here would leave the redundant object silently absent from the offline
    // job's work list — a silent failure the mandate bans.
    mockRegister.mockResolvedValue({
      asset: { storageKey: "image/2026-01-01/existing.webp" },
      deduped: true,
      reclaimQueueFailed: true,
    });
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    // Registration succeeded — the cover still resolves normally.
    expect(out.cover_url).toBe("https://cdn/image/2026-01-01/existing.webp");
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1", key: COVER.key }),
      "asset_reclaim_queue_failed",
    );
  });

  it("register FAILS → cover_url stays undefined (Film), never the orphan cover.key (#1824 best-effort)", async () => {
    mockRegister.mockRejectedValue(new Error("db blip"));
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    // No live studio_assets row → degrade to Film, NEVER pin the orphan key.
    expect(out.cover_url).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1" }),
      "video_cover_register_failed_non_fatal",
    );
  });

  it("no project → cover can't be registered → degrade to Film (register NOT called)", async () => {
    const out = videoOut();

    await resolveVideoCovers([out], { taskId: "t1", userId: "u1", projectId: undefined });

    expect(out.cover_url).toBeUndefined();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("extraction returns undefined → cover_url undefined, no register", async () => {
    mockExtract.mockResolvedValue(undefined);
    const out = videoOut();

    await resolveVideoCovers([out], CTX);

    expect(out.cover_url).toBeUndefined();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("getStorageAdapter throwing NEVER propagates — the whole body is best-effort (#1824 invariant)", async () => {
    // Gate-2 R4 H4 regression guard: the adapter lookup used to sit OUTSIDE any
    // try/catch, so a storage-config / adapter-init failure escaped
    // resolveVideoCovers and failed the whole video task — exactly what #1824
    // ("a cover failure NEVER fails the video") forbids, and what this
    // function's own TSDoc promises it wraps.
    mockGetStorageAdapter.mockRejectedValue(new Error("adapter init failed"));
    const out = videoOut();

    await expect(resolveVideoCovers([out], CTX)).resolves.toBeUndefined();

    expect(out.cover_url).toBeUndefined();
  });

  it("a cover-loop throw NEVER propagates — degrades to a cover-less video (#1824)", async () => {
    // Defense in depth for any future non-cover-specific throw inside the loop
    // (e.g. publicUrl blowing up on a malformed key).
    mockRegister.mockResolvedValue({
      asset: { storageKey: "image/2026-07-25/uploaded.webp" },
      deduped: false,
    });
    mockPublicUrl.mockImplementation(() => {
      throw new Error("publicUrl exploded");
    });
    const out = videoOut();

    await expect(resolveVideoCovers([out], CTX)).resolves.toBeUndefined();

    expect(out.cover_url).toBeUndefined();
  });

  it("skips outputs that already have a cover_url or a non-string url", async () => {
    mockRegister.mockResolvedValue({
      asset: { storageKey: "image/2026-07-25/uploaded.webp" },
      deduped: false,
    });
    const kept: { url?: string; cover_url?: string } = {
      url: "https://cdn/a.mp4",
      cover_url: "https://cdn/kept.webp",
    };
    const noUrl: { url?: string; cover_url?: string } = { cover_url: undefined };

    await resolveVideoCovers([kept, noUrl], CTX);

    expect(kept.cover_url).toBe("https://cdn/kept.webp");
    expect(noUrl.cover_url).toBeUndefined();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
