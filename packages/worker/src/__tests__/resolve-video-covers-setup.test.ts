// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The guard around `resolveVideoCovers`'s setup step (#1824 best-effort).
 *
 * `video-cover.js` statically imports Sharp, so a broken native binary makes
 * the dynamic import itself reject — before any output is reached and outside
 * every per-output handler. Only the outer try covers that, and an escape
 * there fails a video task that already produced its video.
 *
 * This lives in its own file because the failure has to happen at module load:
 * a mock factory that throws cannot be installed per-test, and the sibling file
 * needs the module to load so it can drive the extractor.
 *
 * No real Redis / DB / storage — everything is mocked.
 */

import { vi, describe, it, expect } from "vitest";

const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStorageAdapter: vi.fn(),
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
  backendUploadService: { uploadBytesToStorage: vi.fn() },
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
// The failure under test: loading the module is what throws, the way a broken
// Sharp binary makes it throw.
vi.mock("@worker/providers/video-cover.js", () => {
  throw new Error("sharp: dlopen failed");
});
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

import { resolveVideoCovers } from "@worker/handlers/dispatch.js";

describe("resolveVideoCovers — the setup guard", () => {
  it("swallows a load failure and leaves the video cover-less", async () => {
    const out: { url?: string; cover_url?: string } = { url: "https://cdn/clip.mp4" };

    await expect(
      resolveVideoCovers([out], { taskId: "t1", userId: "u1", projectId: "p1" }),
    ).resolves.toBeUndefined();

    // Degraded to Film, and said so: the video itself is a success.
    expect(out.cover_url).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1" }),
      "video_cover_setup_failed_non_fatal",
    );
  });
});
