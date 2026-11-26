// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";

const h = vi.hoisted(() => ({ add: vi.fn(), schedule: vi.fn(), removeSchedule: vi.fn(), createQueue: vi.fn(), createWorker: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(),
  createQueue: h.createQueue, createWorker: h.createWorker,
  getMiniToolsConfig: () => ({ delivery: { discovery_interval_ms: 12345, discovery_page_size: 3 } }),
  logger: { error: h.error, warn: vi.fn(), info: vi.fn() },
}));
import { startMiniToolDeliveryRecovery } from "../delivery-worker.js";

const queue = { add: h.add, upsertJobScheduler: h.schedule, removeJobScheduler: h.removeSchedule };
const importedWorkers = h.createWorker.mock.calls.slice();
beforeEach(() => { vi.resetAllMocks(); h.createQueue.mockReturnValue(queue); h.add.mockResolvedValue(undefined); h.schedule.mockResolvedValue(undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("delivery recovery uses the existing tasks worker", () => {
  it("D19 installs one durable scheduler and immediately discovers without creating a worker", async () => {
    expect(importedWorkers).toEqual([]);
    const worker = { close: vi.fn().mockResolvedValue(undefined) };
    await startMiniToolDeliveryRecovery(worker);
    expect(h.createQueue.mock.calls.every(([name]) => name === "tasks")).toBe(true);
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith("discover-mini-tool-deliveries", { every: 12345 }, {
      name: "discover-mini-tool-deliveries", data: {}, opts: { removeOnComplete: true, removeOnFail: true },
    });
    expect(h.add).toHaveBeenCalledExactlyOnceWith("discover-mini-tool-deliveries", {}, { removeOnComplete: true, removeOnFail: true });
    expect(h.createWorker).not.toHaveBeenCalled(); expect(worker.close).not.toHaveBeenCalled(); expect(h.removeSchedule).not.toHaveBeenCalled();
  });

  it("D19 two instances upsert the same scheduler identity without removing it", async () => {
    const first = { close: vi.fn().mockResolvedValue(undefined) }; const second = { close: vi.fn().mockResolvedValue(undefined) };
    await startMiniToolDeliveryRecovery(first); await startMiniToolDeliveryRecovery(second);
    expect(h.schedule.mock.calls.map(([id]) => id)).toEqual(["discover-mini-tool-deliveries", "discover-mini-tool-deliveries"]);
    expect(h.add).toHaveBeenCalledTimes(2); expect(h.createWorker).not.toHaveBeenCalled(); expect(h.removeSchedule).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled(); expect(second.close).not.toHaveBeenCalled();
  });

  it.each(["schedule", "startup-discovery"] as const)("D19 cleans up the passed worker when %s installation fails", async (phase) => {
    const worker = { close: vi.fn().mockResolvedValue(undefined) }; const failure = new Error(`fixture ${phase} unavailable`);
    if (phase === "schedule") h.schedule.mockRejectedValue(failure); else h.add.mockRejectedValue(failure);
    await expect(startMiniToolDeliveryRecovery(worker)).rejects.toBe(failure);
    expect(worker.close).toHaveBeenCalledExactlyOnceWith();
    expect(h.error.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: failure })])]));
    expect(h.createWorker).not.toHaveBeenCalled(); expect(h.removeSchedule).not.toHaveBeenCalled();
    if (phase === "schedule") expect(h.add).not.toHaveBeenCalled();
  });
});
