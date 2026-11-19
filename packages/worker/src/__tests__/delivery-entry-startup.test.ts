// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type * as deliveryModule from "../handlers/mini-tool/delivery-worker.js";

const h = vi.hoisted(() => ({
  workers: [] as Array<{ name: string; on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  recoveryWorkers: [] as Array<Pick<Worker, "close">>,
  createWorker: vi.fn(), createQueue: vi.fn(), add: vi.fn(), schedule: vi.fn(), removeSchedule: vi.fn(),
  health: vi.fn(), error: vi.fn(), exit: vi.fn(), settlement: vi.fn(), sweep: vi.fn(),
  exitError: new Error("fixture application exit"),
}));
// Import the actual composition root while suppressing runtime configuration reads
// and external sockets. The delivery startup helper itself remains call-through.
vi.mock("@worker/bootstrap-config.js", () => ({}));
vi.mock("@worker/sentry.js", () => ({ initSentry: () => "disabled", exitProcess: h.exit }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(),
  env: { WORKER_HEALTH_PORT: 19101, AMPLITUDE_API_KEY: undefined },
  initLogger: vi.fn(), loadLocales: vi.fn(), getAgentConfig: () => ({}), assertKnownQueues: vi.fn(),
  initServerAnalytics: () => "disabled", adsConversionState: () => "disabled", adsConversionConfig: () => null,
  scheduleAdsUploadSweep: h.sweep, unscheduleAdsUploadSweep: h.sweep,
  installDeadlineBoundDispatcher: vi.fn(), checkInfraReady: vi.fn().mockResolvedValue(undefined),
  getRedis: () => ({ on: vi.fn() }), getQueueRedis: () => ({ on: vi.fn() }), getStreamRedis: () => ({}),
  createWorker: h.createWorker, createQueue: h.createQueue, createQueueEvents: () => ({ on: vi.fn() }),
  getMiniToolsConfig: () => ({ delivery: { discovery_interval_ms: 12345, discovery_page_size: 3 } }),
  startHealthServer: h.health, logger: { error: h.error, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@breatic/domain", async (original) => ({ ...await original<typeof domainModule>(), modelCatalog: { getModelCatalog: () => ({}) } }));
vi.mock("@worker/handlers/dispatch.js", () => ({ runTask: vi.fn() }));
vi.mock("@worker/handlers/failed-job-cleanup.js", () => ({ reclaimFailedJobById: vi.fn() }));
vi.mock("@worker/handlers/url-ingest.js", () => ({ runUrlIngest: vi.fn() }));
vi.mock("@worker/handlers/abort-ingest.js", () => ({ settleStalledIngest: vi.fn() }));
vi.mock("@worker/handlers/usage-lookup.js", () => ({ runUsageLookup: vi.fn() }));
vi.mock("@worker/handlers/media-read.js", () => ({ runMediaRead: vi.fn() }));
vi.mock("@worker/handlers/audio-peaks.js", () => ({ runAudioPeaks: vi.fn() }));
vi.mock("@worker/handlers/video-presentation.js", () => ({ runVideoPresentation: vi.fn() }));
vi.mock("@worker/handlers/upload-finish.js", () => ({ runUploadFinish: vi.fn() }));
vi.mock("@worker/handlers/mail.js", () => ({ runMail: vi.fn() }));
vi.mock("@worker/handlers/ads-conversion.js", () => ({ runAdsConversion: vi.fn(), googleDataManagerSink: vi.fn() }));
vi.mock("@worker/handlers/mini-tool/settlement-worker.js", () => ({ startMiniToolSettlementWorker: h.settlement }));
vi.mock("@worker/handlers/mini-tool/delivery-worker.js", async (original) => {
  const actual = await original<typeof deliveryModule>();
  return { ...actual,
    /** Record the actual entry's owned worker while running the real delivery registration. */
    startMiniToolDeliveryRecovery: async (worker: Pick<Worker, "close">): Promise<void> => {
      h.recoveryWorkers.push(worker); await actual.startMiniToolDeliveryRecovery(worker);
    },
  };
});

const queue = { add: h.add, upsertJobScheduler: h.schedule, removeJobScheduler: h.removeSchedule };
const originalWarnings = globalThis.AI_SDK_LOG_WARNINGS;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); h.workers.length = 0; h.recoveryWorkers.length = 0;
  vi.spyOn(process, "on").mockReturnValue(process);
  h.createQueue.mockReturnValue(queue); h.add.mockResolvedValue(undefined); h.schedule.mockResolvedValue(undefined);
  h.health.mockReturnValue({ stop: vi.fn().mockResolvedValue(undefined) });
  h.settlement.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  h.sweep.mockResolvedValue(undefined);
  h.exit.mockRejectedValue(h.exitError);
  h.createWorker.mockImplementation((name: string) => {
    const worker = { name, on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }; h.workers.push(worker); return worker;
  });
});
afterEach(() => { globalThis.AI_SDK_LOG_WARNINGS = originalWarnings; vi.restoreAllMocks(); });

describe("D19 actual worker composition root", () => {
  it("registers delivery recovery on the same sole tasks worker before announcing health", async () => {
    await import("../index.js");
    const workers = h.workers.filter((worker) => worker.name === "tasks"); expect(workers).toHaveLength(1);
    expect(h.recoveryWorkers).toEqual([workers[0]]);
    // The same mocked queue also receives main's long-media-dispatch-sweep schedule; only the delivery discovery is this case's.
    const discovery = h.schedule.mock.calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === "discover-mini-tool-deliveries");
    expect(discovery.map(({ call }) => call)).toEqual([["discover-mini-tool-deliveries", { every: 12345 }, expect.objectContaining({ name: "discover-mini-tool-deliveries", data: {} })]]);
    expect(h.add).toHaveBeenCalledWith("discover-mini-tool-deliveries", {}, expect.any(Object));
    expect(h.health).toHaveBeenCalledTimes(1);
    expect(h.schedule.mock.invocationCallOrder[discovery[0]!.index]!).toBeLessThan(h.health.mock.invocationCallOrder[0]!);
    expect(h.exit).not.toHaveBeenCalled(); expect(h.removeSchedule).not.toHaveBeenCalled();
  });

  it.each(["schedule", "startup-discovery"] as const)("fails actual startup after %s fails, closing the same tasks worker without health", async (phase) => {
    const failure = new Error(`fixture entry ${phase} unavailable`);
    if (phase === "schedule") h.schedule.mockRejectedValue(failure); else h.add.mockRejectedValue(failure);
    await expect(import("../index.js")).rejects.toBe(h.exitError);
    const workers = h.workers.filter((worker) => worker.name === "tasks"); expect(workers).toHaveLength(1);
    expect(h.recoveryWorkers).toEqual([workers[0]]); expect(workers[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.health).not.toHaveBeenCalled(); expect(h.exit).toHaveBeenCalledExactlyOnceWith(1); expect(h.removeSchedule).not.toHaveBeenCalled();
    expect(h.error.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: failure, ctx: expect.objectContaining({ phase: "worker-start" }) })])]));
  });
});
