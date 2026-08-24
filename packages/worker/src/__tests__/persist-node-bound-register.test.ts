// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * persistOutputs node-bound register fail-closed (#1826, design §0 rule 3 /
 * §4.4).
 *
 * A node's PRIMARY generated output must NEVER be pinned to an UNREGISTERED
 * storage key. So when the task targets canvas nodes (`nodeBound: true`), a
 * `studio_assets` register failure must RE-THROW — propagating to Stage 2's
 * persist-failure path, which marks the task failed with NO charge and NO node
 * emit (the same terminal path as a persist failure). This closes the hole
 * where a billed generation left a node pinned to a key the offline GC would
 * later reclaim → 404.
 *
 * Non-node-bound registers (auxiliary `extras`, or a task with no target node
 * like an agent attachment) stay best-effort — a warn, never a task failure.
 *
 * No real Redis / DB / storage — everything is mocked (same pattern as
 * record-generation-rethrow.test.ts).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockUpload = vi.hoisted(() => vi.fn());
const mockRegister = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStorageAdapter: vi.fn().mockResolvedValue({
    upload: mockUpload,
    isOwnUrl: () => true, // our-own URL → Case 2 re-host is skipped
    publicUrl: (key: string) => `https://our-bucket/${key}`,
  }),
  sha256Hex: () => "a".repeat(64),
  storageKey: () => "image/2026-07-25/gen.png",
  downloadAndStore: vi.fn(),
  publishNodeEvent: vi.fn(),
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
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
  nodeHistoryService: { recordGenerationSuccess: vi.fn(), recordGenerationFailure: vi.fn() },
  getModel: vi.fn(),
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
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

import { persistOutputs } from "@worker/handlers/dispatch.js";

/** One sync-transport (Case 1) buffer output. */
function bufferOutput(): { extra: Record<string, unknown> } {
  return { extra: { buffer: Buffer.from("gen-bytes"), contentType: "image/png" } };
}

const baseOpts = { taskType: "image", userId: "u1", projectId: "p1", taskId: "t1" };

describe("persistOutputs — node-bound register fail-closed (#1826 §0 rule 3)", () => {
  beforeEach(() => {
    mockUpload.mockReset().mockResolvedValue("https://our-bucket/gen.png");
    mockRegister.mockReset();
  });

  it("node-bound: a PRIMARY register failure PROPAGATES (→ Stage 2 markFailed, no charge)", async () => {
    mockRegister.mockRejectedValueOnce(new Error("no owner studio"));
    await expect(
      persistOutputs([bufferOutput()], {}, { ...baseOpts, nodeBound: true }),
    ).rejects.toThrow("no owner studio");
  });

  it("non-node-bound: a register failure is SWALLOWED (best-effort, the task proceeds)", async () => {
    mockRegister.mockRejectedValueOnce(new Error("no owner studio"));
    const out = await persistOutputs([bufferOutput()], {}, { ...baseOpts, nodeBound: false });
    // The output still persisted (its URL is set) — only the ledger row was skipped.
    expect(out[0]!.url).toBe("https://our-bucket/gen.png");
  });

  it("node-bound + register SUCCEEDS: the output persists and registers once", async () => {
    // The registered row's key matches the freshly-uploaded one (no dedup), so
    // the reconciled canonical equals the upload URL.
    mockRegister.mockResolvedValueOnce({
      asset: { storageKey: "image/2026-07-25/gen.png" },
      deduped: false,
    });
    const out = await persistOutputs([bufferOutput()], {}, { ...baseOpts, nodeBound: true });
    expect(out[0]!.url).toBe("https://our-bucket/image/2026-07-25/gen.png");
    expect(mockRegister).toHaveBeenCalledTimes(1);
    // source='ai' for a generated output.
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ source: "ai" }));
  });

  it("DEDUP hit: the output URL is reconciled to the EXISTING row's canonical, not the just-uploaded key (§0 rule 2 / §4.4)", async () => {
    // Gate-2 R4 H2: within-studio dedup returns the WINNER's row, whose
    // storage key differs from the one we just uploaded. The freshly-uploaded
    // key then has NO live studio_assets row and NO grant — a pure orphan the
    // offline GC (§7) reclaims. Pinning it into the node / node-history /
    // activity feed is the §0 rule 2 violation the frontend + cover paths
    // already fixed; the worker MAIN output was the last gap.
    mockRegister.mockResolvedValueOnce({
      asset: { storageKey: "image/2026-01-01/existing.png" },
      deduped: true,
    });
    const out = await persistOutputs([bufferOutput()], {}, { ...baseOpts, nodeBound: true });
    expect(out[0]!.url).toBe("https://our-bucket/image/2026-01-01/existing.png");
    // NEVER the just-uploaded (now-orphan) key's URL.
    expect(out[0]!.url).not.toBe("https://our-bucket/gen.png");
  });

  it("DEDUP hit whose reclaim-queue insert failed still reconciles, and LOGS the swallowed sentinel", async () => {
    // register() reports a failed reclaim-queue insert as a sentinel because the
    // library layer may not log (@domain/CLAUDE.md). Dropping it here would
    // leave the redundant object silently absent from the offline work list.
    mockRegister.mockResolvedValueOnce({
      asset: { storageKey: "image/2026-01-01/existing.png" },
      deduped: true,
      reclaimQueueFailed: true,
    });
    const out = await persistOutputs([bufferOutput()], {}, { ...baseOpts, nodeBound: true });
    // The registration succeeded — reconciliation is unaffected.
    expect(out[0]!.url).toBe("https://our-bucket/image/2026-01-01/existing.png");
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1" }),
      "asset_reclaim_queue_failed",
    );
  });

  it("no projectId: register no-ops → nodeBound is moot, never throws", async () => {
    const out = await persistOutputs(
      [bufferOutput()],
      {},
      { ...baseOpts, projectId: undefined, nodeBound: true },
    );
    expect(out[0]!.url).toBe("https://our-bucket/gen.png");
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
