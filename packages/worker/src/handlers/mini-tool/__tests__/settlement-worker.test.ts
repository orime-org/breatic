// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";

const wire = vi.hoisted(() => ({
  processor: undefined as ((job: Job<unknown>) => Promise<unknown>) | undefined,
  createWorker: vi.fn(), createQueue: vi.fn(), add: vi.fn(), schedule: vi.fn(), removeSchedule: vi.fn(),
  on: vi.fn(), close: vi.fn(), run: vi.fn(), discover: vi.fn(), lookup: vi.fn(), error: vi.fn(),
}));
vi.mock("@breatic/core", async (original) => ({
  ...await original<typeof coreModule>(),
  getMiniToolsConfig: () => ({ settlement: { lease_ms: 60000, retry_ms: 30000, lookup_timeout_ms: 15000, discovery_interval_ms: 30000, discovery_page_size: 100 } }),
  createQueue: wire.createQueue, createWorker: wire.createWorker,
  logger: { error: wire.error, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@breatic/domain", async (original) => ({ ...await original<typeof domainModule>(), runMiniToolSettlement: wire.run, listDueMiniToolSettlements: wire.discover }));
vi.mock("../lookup-consumption.js", () => ({ lookupMiniToolConsumption: wire.lookup }));

import { MINI_TOOL_SETTLEMENT_QUEUE, MINI_TOOL_SETTLEMENT_JOB, MINI_TOOL_SETTLEMENT_DISCOVERY_JOB } from "@breatic/core";
import { startMiniToolSettlementWorker } from "../settlement-worker.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const taskId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";
const dueAt = "2026-10-25T00:00:30.000000Z";
const queue = { add: wire.add, upsertJobScheduler: wire.schedule, removeJobScheduler: wire.removeSchedule };
const worker = { on: wire.on, close: wire.close };

/**
 * Start the actual registration module and capture its BullMQ application boundary.
 * @returns The registered real processor, with only infrastructure ports replaced.
 * @throws {Error} When startup never registers its processor.
 */
async function boot(): Promise<(job: Job<unknown>) => Promise<unknown>> {
  await startMiniToolSettlementWorker();
  if (wire.processor === undefined) throw new Error("Settlement processor was not registered");
  return wire.processor;
}

beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(Date, "now").mockReturnValue(NOW); wire.processor = undefined;
  wire.add.mockResolvedValue(undefined); wire.schedule.mockResolvedValue(undefined); wire.close.mockResolvedValue(undefined); wire.on.mockReturnValue(worker);
  wire.createQueue.mockReturnValue(queue);
  wire.createWorker.mockImplementation((_name: string, processor: (job: Job<unknown>) => Promise<unknown>) => { wire.processor = processor; return worker; });
  wire.run.mockResolvedValue({ charge: null, nextWake: null }); wire.discover.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("durable mini-tool expense worker wiring", () => {
  it("registers a worker, installs the shared schedule and performs a startup discovery", async () => {
    expect(await startMiniToolSettlementWorker()).toBe(worker);
    expect(wire.createQueue).toHaveBeenCalledExactlyOnceWith(MINI_TOOL_SETTLEMENT_QUEUE);
    expect(wire.createWorker).toHaveBeenCalledExactlyOnceWith(MINI_TOOL_SETTLEMENT_QUEUE, expect.any(Function));
    expect(wire.schedule).toHaveBeenCalledExactlyOnceWith(MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, { every: 30000 }, {
      name: MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true },
    });
    expect(wire.add).toHaveBeenCalledExactlyOnceWith(MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, {}, { removeOnComplete: true, removeOnFail: true });
    expect(wire.removeSchedule).not.toHaveBeenCalled();
  });

  it("routes a wake through SQL recovery and reads costs under a fresh bounded lifetime", async () => {
    const process = await boot(); wire.add.mockClear();
    const lookupInput: domainModule.MiniToolConsumptionLookupInput = { consumption: {
      schemaVersion: 1, consumptionKey: "1".repeat(64), identity: { kind: "container", containerClass: "MiniToolContainerStd4", jobId: "task:T/chunk:0", chunkIndex: 0 },
      state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null,
      containerPricing: { configVersion: "first-policy", size: { vcpu: 4, memory_gib: 12, disk_gb: 20 },
        prices: { vcpu_second_usd: 0.001, memory_gib_second_usd: 0.002, disk_gb_second_usd: 0.003 } },
    }, plan: { schemaVersion: 2, jobId: "task:T/chunk:0", containerClass: "MiniToolContainerStd4", deadlineAt: 1792920000000,
      limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, inputs: [], outputs: [],
      count: { kind: "grid_count", inputId: "20000000-0000-4000-8000-000000000001", gridStart: { numerator: 0, denominator: 1 }, fps: { numerator: 25, denominator: 1 }, gridEnd: null } } };
    wire.lookup.mockResolvedValue({ state: "pending", reason: "billing-delayed" });
    wire.run.mockImplementation(async (_scope: unknown, lookup: domainModule.MiniToolSettlementLookup) => {
      await lookup(lookupInput);
      return { charge: null, nextWake: { taskId, settlementVersion: 8, dueAt } };
    });
    await process({ id: "old-version-job", name: MINI_TOOL_SETTLEMENT_JOB, data: { taskId, settlementVersion: 7 } } as Job<unknown>);
    expect(wire.run).toHaveBeenCalledExactlyOnceWith({ taskId, settlementVersion: 7 }, expect.any(Function));
    expect(wire.lookup).toHaveBeenCalledExactlyOnceWith(lookupInput, { signal: expect.any(AbortSignal), timeoutMs: 15000 });
    expect(wire.add).toHaveBeenCalledExactlyOnceWith(MINI_TOOL_SETTLEMENT_JOB, { taskId, settlementVersion: 8 }, {
      jobId: `mini-tool-${taskId}-8`, delay: 30000, removeOnComplete: true, removeOnFail: true,
    });
  });

  it("discovers one full-precision page and queues its continuation without claiming expenses", async () => {
    const process = await boot(); wire.add.mockClear();
    const cursor = { taskId, dueAt: "2026-10-24T00:00:00.100001Z" };
    const nextCursor = { taskId: secondId, dueAt: "2026-10-24T00:00:00.100002Z" };
    wire.discover.mockResolvedValue({ items: [{ taskId, settlementVersion: 7, dueAt }, { taskId: secondId, settlementVersion: 9, dueAt }], nextCursor });
    await process({ name: MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, data: { cursor } } as Job<unknown>);
    expect(wire.discover).toHaveBeenCalledExactlyOnceWith({ limit: 100, cursor });
    expect(wire.add.mock.calls).toEqual([
      [MINI_TOOL_SETTLEMENT_JOB, { taskId, settlementVersion: 7 }, { jobId: `mini-tool-${taskId}-7`, delay: 30000, removeOnComplete: true, removeOnFail: true }],
      [MINI_TOOL_SETTLEMENT_JOB, { taskId: secondId, settlementVersion: 9 }, { jobId: `mini-tool-${secondId}-9`, delay: 30000, removeOnComplete: true, removeOnFail: true }],
      [MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, { cursor: nextCursor }, { removeOnComplete: true, removeOnFail: true }],
    ]);
    expect(wire.run).not.toHaveBeenCalled(); expect(wire.lookup).not.toHaveBeenCalled();
  });

  it("logs retained recovery errors and still delivers the committed next version", async () => {
    const process = await boot(); wire.add.mockClear(); const error = new Error("retained lookup failure");
    wire.run.mockResolvedValue({ charge: null, nextWake: { taskId, settlementVersion: 8, dueAt }, failure: error });
    await process({ name: MINI_TOOL_SETTLEMENT_JOB, data: { taskId, settlementVersion: 7 } } as Job<unknown>);
    expect(wire.error).toHaveBeenCalledWith({ err: error, ctx: { taskId, settlementVersion: 7 } }, "mini_tool_settlement_deferred");
    expect(wire.add).toHaveBeenCalledTimes(1);
  });

  it("logs enqueue failure while leaving SQL recovery as the authority", async () => {
    const process = await boot(); wire.add.mockClear(); const error = new Error("queue unavailable");
    wire.run.mockResolvedValue({ charge: null, nextWake: { taskId, settlementVersion: 8, dueAt } }); wire.add.mockRejectedValue(error);
    await expect(process({ name: MINI_TOOL_SETTLEMENT_JOB, data: { taskId, settlementVersion: 7 } } as Job<unknown>)).rejects.toBe(error);
    expect(wire.error).toHaveBeenCalledWith(expect.objectContaining({ err: error }), "mini_tool_settlement_job_failed");
    expect(wire.run).toHaveBeenCalledTimes(1);
  });

  it("closes a partially registered worker when its schedule cannot be installed", async () => {
    const error = new Error("scheduler unavailable"); wire.schedule.mockRejectedValue(error);
    await expect(startMiniToolSettlementWorker()).rejects.toBe(error);
    expect(wire.close).toHaveBeenCalledTimes(1); expect(wire.add).not.toHaveBeenCalled();
    expect(wire.error).toHaveBeenCalledWith(expect.objectContaining({ err: error }), "mini_tool_settlement_start_failed");
  });

  it.each(["unrecognized-job", MINI_TOOL_SETTLEMENT_JOB])("rejects invalid %s delivery before reading an expense", async (name) => {
    const process = await boot(); wire.add.mockClear();
    await expect(process({ name, data: { taskId: "invalid", settlementVersion: -1 } } as Job<unknown>)).rejects.toThrow();
    expect(wire.run).not.toHaveBeenCalled(); expect(wire.lookup).not.toHaveBeenCalled(); expect(wire.add).not.toHaveBeenCalled();
  });
});
