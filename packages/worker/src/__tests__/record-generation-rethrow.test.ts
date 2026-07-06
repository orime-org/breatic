// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * recordGenerationForNodes re-throw contract (#1618 A / adversarial hole ③).
 *
 * A billed generation MUST land in node_history. When the record INSERT
 * itself fails on a LIVE run (transient DB blip), the helper must RE-THROW
 * (rethrowOnRecordFailure) so BullMQ redelivers and the re-entry guard
 * re-records idempotently — closing the "best-effort warn-swallow leaves a
 * billed-but-unrecorded row with no retry" hole. The terminal crash-net path
 * passes best-effort (no retry left). The emit stays best-effort in both.
 *
 * No real Redis / DB — publishNodeEvent + nodeHistoryService are mocked
 * (same pattern as failed-job-cleanup.test.ts).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockPublishNodeEvent = vi.hoisted(() => vi.fn());
const mockRecord = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  publishNodeEvent: mockPublishNodeEvent,
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
}));
vi.mock("@breatic/domain", () => ({
  taskService: {
    getByIdInternal: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    markCompletedAndBill: vi.fn(),
    recordProviderResult: vi.fn(),
    setResolvedSkills: vi.fn(),
  },
  creditService: { deduct: vi.fn() },
  nodeHistoryService: { recordGenerationSuccess: mockRecord, recordGenerationFailure: vi.fn() },
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

import { recordGenerationForNodes } from "@worker/handlers/dispatch.js";

const streamRedis = {} as never;
const genOf = (): number => 1;
const ctx = {
  projectId: "p1",
  userId: "u1",
  taskId: "t1",
  taskType: "image",
  metadata: {},
};
const outputs = [{ nodeId: "n1", url: "https://x/a.png", coverUrl: undefined }];

describe("recordGenerationForNodes re-throw contract (#1618 A / hole ③)", () => {
  beforeEach(() => {
    mockPublishNodeEvent.mockReset();
    mockRecord.mockReset();
  });

  it("rethrowOnRecordFailure=true: a node_history record failure PROPAGATES (so BullMQ redelivers → case a re-records)", async () => {
    mockRecord.mockRejectedValueOnce(new Error("db blip"));
    await expect(
      recordGenerationForNodes(streamRedis, "project-p1/canvas-s1", ctx, outputs, genOf, {
        rethrowOnRecordFailure: true,
      }),
    ).rejects.toThrow("db blip");
  });

  it("default (best-effort, terminal path): a record failure is swallowed and the emit still runs", async () => {
    mockRecord.mockRejectedValueOnce(new Error("db blip"));
    await expect(
      recordGenerationForNodes(streamRedis, "project-p1/canvas-s1", ctx, outputs, genOf),
    ).resolves.toBeUndefined();
    // Emit is best-effort in both modes — a record failure must not skip it.
    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
  });

  it("records + emits once per node when the insert succeeds", async () => {
    mockRecord.mockResolvedValue({});
    await recordGenerationForNodes(streamRedis, "project-p1/canvas-s1", ctx, outputs, genOf, {
      rethrowOnRecordFailure: true,
    });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
  });
});
