// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Delivery after the completed commit (frames-split design §7.19 交付): a run delivers its outputs once, in the completed
 * commit; the terminal commit delivers the positions whose delivery is still pending and wakes pending delivery. The
 * domain commit, the delivery context read and the delivery workers are mocked; the wrapper in `execution-completion.ts`
 * is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import * as completionModule from "../execution-completion.js";
import { finishMiniToolExecutionAndNotify } from "../execution-completion.js";

const h = vi.hoisted(() => ({ finish: vi.fn(), read: vi.fn(), settle: vi.fn(), deliver: vi.fn(), wake: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(), logger: h.logger as unknown as typeof coreModule.logger }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, settleTaskForNode: h.settle,
    miniToolExecutionService: { ...actual.miniToolExecutionService, finishMiniToolExecution: h.finish },
    miniToolDeliveryService: { ...actual.miniToolDeliveryService, readMiniToolDelivery: h.read } };
});
vi.mock("@worker/handlers/mini-tool/delivery-worker.js", () => ({ deliverMiniToolOutput: h.deliver, wakePendingMiniToolDelivery: h.wake }));

const TASK = "50000000-0000-4000-8000-000000000001";
const PLAN = "d".repeat(64);
const REDIS = {} as Parameters<typeof finishMiniToolExecutionAndNotify>[2];

/**
 * A registered result of one output.
 * @param index - The output.
 * @returns The result.
 */
function registered(index: number): Record<string, unknown> {
  return { status: "registered", assetId: `a0000000-0000-4000-8000-00000000000${index}`, canonicalURL: `https://assets.example.test/${index}.mp4`, kind: "video",
    contentHash: String(index).repeat(64), mimeType: "video/mp4", size: 100, width: 320, height: 180, duration: 1.92, cover: null };
}

/**
 * The execution the domain answers: two outputs with the given results.
 * @param results - Each output's result.
 * @returns The execution.
 */
function execution(results: (Record<string, unknown> | null)[]): Record<string, unknown> {
  const outputs = results.map((result, outputIndex) => ({ outputIndex, nodeId: `40000000-0000-4000-8000-00000000000${outputIndex}`, recipe: { kind: "segment", range: { start: outputIndex, end: outputIndex + 1 } }, result }));
  return { task: { id: TASK }, execution: { projectId: "10000000-0000-4000-8000-000000000001", spaceId: "20000000-0000-4000-8000-000000000001", planFingerprint: PLAN },
    record: { runId: TASK, status: "running", planFingerprint: PLAN, resultVersion: 1, outputs } };
}

/**
 * The delivery context with each output's delivery state.
 * @param run - The execution.
 * @param states - The delivery state of each output index that has a slot.
 * @returns The context.
 */
function context(run: Record<string, unknown>, states: Record<number, "pending" | "published">): Record<string, unknown> {
  return { ...run, delivery: { schemaVersion: 1, planFingerprint: PLAN, version: 1, lastErrorCode: null,
    outputs: Object.entries(states).map(([outputIndex, state]) => ({ outputIndex: Number(outputIndex), state })) } };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.deliver.mockImplementation(async (value: unknown) => value);
});

describe("delivery after the completed commit (design §7.19)", () => {
  it("EC03 the terminal commit delivers only positions whose delivery is still pending", async () => {
    const run = execution([registered(0), registered(1)]);
    h.finish.mockResolvedValue({ ...run, record: { ...(run.record as object), status: "completed", resultVersion: 2 } });
    h.read.mockResolvedValue(context(run, { 0: "published", 1: "pending" }));
    await finishMiniToolExecutionAndNotify(TASK, { planFingerprint: PLAN, expectedVersion: 1, outputs: (run.record as { outputs: never[] }).outputs, error: null }, REDIS);
    expect(h.deliver.mock.calls.map((call) => call[1])).toEqual([1]);
    expect(h.wake).toHaveBeenCalledTimes(1);
  });

  it("EC04 the completed commit delivers every output at once", async () => {
    const run = execution([registered(0), registered(1)]);
    h.finish.mockResolvedValue({ ...run, record: { ...(run.record as object), status: "completed", resultVersion: 1 } });
    h.read.mockResolvedValue(context(run, { 0: "pending", 1: "pending" }));
    await finishMiniToolExecutionAndNotify(TASK, { planFingerprint: PLAN, expectedVersion: 0, outputs: (run.record as { outputs: never[] }).outputs, error: null }, REDIS);
    expect(h.deliver.mock.calls.map((call) => call[1])).toEqual([0, 1]);
  });

  it("EC05 there is no per-output progress commit to deliver after", () => {
    expect((completionModule as Record<string, unknown>).commitMiniToolExecutionProgress).toBeUndefined();
  });
});
