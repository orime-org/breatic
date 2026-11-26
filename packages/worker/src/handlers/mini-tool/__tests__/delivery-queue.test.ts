// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";

const h = vi.hoisted(() => ({
  add: vi.fn(), createQueue: vi.fn(), createWorker: vi.fn(), read: vi.fn(), ack: vi.fn(), defer: vi.fn(), discover: vi.fn(),
  legacy: vi.fn(), consent: vi.fn(), error: vi.fn(),
}));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(),
  createQueue: h.createQueue, createWorker: h.createWorker, getStreamRedis: () => ({}),
  getMiniToolsConfig: () => ({ delivery: { discovery_interval_ms: 12345, discovery_page_size: 3 } }),
  runWithConsent: h.consent, logger: { error: h.error, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, miniToolDeliveryService: { readMiniToolDelivery: h.read, ackMiniToolDelivery: h.ack, deferMiniToolDelivery: h.defer, listPendingMiniToolDeliveries: h.discover },
    taskService: { ...actual.taskService, getByIdInternal: h.legacy } };
});

import { MINI_TOOL_DELIVERY_JOB, MINI_TOOL_DELIVERY_DISCOVERY_JOB, miniToolDeliveryWakeSchema, miniToolDeliveryDiscoverySchema } from "@breatic/core";
import * as delivery from "../delivery-worker.js";
import { runTask } from "@worker/handlers/dispatch.js";

const TASK = "10000000-0000-4000-8000-000000000001";
const NEXT = "10000000-0000-4000-8000-000000000002";
const queue = { add: h.add };
const importedWorkers = h.createWorker.mock.calls.slice();

beforeEach(() => {
  vi.resetAllMocks();
  h.createQueue.mockReturnValue(queue); h.add.mockResolvedValue(undefined);
  h.discover.mockResolvedValue({ items: [], nextCursor: null });
  h.legacy.mockRejectedValue(new Error("Pure delivery entered legacy computation"));
  h.consent.mockImplementation((_snapshot: unknown, run: () => Promise<Record<string, unknown>>) => run());
});
afterEach(() => { vi.restoreAllMocks(); });

describe("pure delivery queue contract", () => {
  it("keeps the adopted exact task-job names and strict minimal positive envelopes", () => {
    expect(MINI_TOOL_DELIVERY_JOB).toBe("deliver-mini-tool-results");
    expect(MINI_TOOL_DELIVERY_DISCOVERY_JOB).toBe("discover-mini-tool-deliveries");
    expect(miniToolDeliveryWakeSchema.parse({ taskId: TASK, deliveryVersion: 7 })).toEqual({ taskId: TASK, deliveryVersion: 7 });
    expect(miniToolDeliveryDiscoverySchema.parse({})).toEqual({});
    expect(miniToolDeliveryDiscoverySchema.parse({ cursor: { taskId: TASK } })).toEqual({ cursor: { taskId: TASK } });
  });

  it.each([
    { taskId: TASK }, { taskId: "not-a-uuid", deliveryVersion: 7 }, { taskId: TASK, deliveryVersion: -1 },
    { taskId: TASK, deliveryVersion: 1.5 }, { taskId: TASK, deliveryVersion: "7" },
    { taskId: TASK, deliveryVersion: 7, userId: "queue-actor" }, { taskId: TASK, deliveryVersion: 7, outputs: [] },
  ])("rejects a wake outside the adopted strict identity: %j", (data) => {
    expect(miniToolDeliveryWakeSchema.safeParse(data).success).toBe(false);
  });

  it.each([{ cursor: { taskId: "bad" } }, { cursor: { taskId: TASK, dueAt: "2026-10-26T00:00:00Z" } }, { limit: 999 }, { taskId: TASK }])("rejects non-keyset discovery data: %j", (data) => {
    expect(miniToolDeliveryDiscoverySchema.safeParse(data).success).toBe(false);
  });

  it("enqueues a wake on tasks without creating another worker", async () => {
    expect(importedWorkers).toEqual([]);
    await delivery.enqueueMiniToolDelivery({ taskId: TASK, deliveryVersion: 7 });
    expect(h.createQueue.mock.calls.every(([name]) => name === "tasks")).toBe(true);
    expect(h.add).toHaveBeenCalledExactlyOnceWith("deliver-mini-tool-results", { taskId: TASK, deliveryVersion: 7 }, expect.objectContaining({ removeOnComplete: true, removeOnFail: true }));
    expect(h.createWorker).not.toHaveBeenCalled();
  });

  it("reads the injected delivery page size and enqueues the exact SQL continuation", async () => {
    h.discover.mockResolvedValue({ items: [{ taskId: TASK, deliveryVersion: 7 }, { taskId: NEXT, deliveryVersion: 9 }], nextCursor: { taskId: NEXT } });
    await delivery.runMiniToolDeliveryJob({ name: "discover-mini-tool-deliveries", data: { cursor: { taskId: TASK } } } as Job<unknown>);
    expect(h.discover).toHaveBeenCalledExactlyOnceWith({ limit: 3, cursor: { taskId: TASK } });
    expect(h.add.mock.calls.map(([name, data]) => [name, data])).toEqual([
      ["deliver-mini-tool-results", { taskId: TASK, deliveryVersion: 7 }],
      ["deliver-mini-tool-results", { taskId: NEXT, deliveryVersion: 9 }],
      ["discover-mini-tool-deliveries", { cursor: { taskId: NEXT } }],
    ]);
    expect(h.read).not.toHaveBeenCalled(); expect(h.ack).not.toHaveBeenCalled(); expect(h.createWorker).not.toHaveBeenCalled();
  });

  it("an empty new-cycle scan has no continuation and does not acknowledge media", async () => {
    await delivery.runMiniToolDeliveryJob({ name: "discover-mini-tool-deliveries", data: {} } as Job<unknown>);
    expect(h.discover).toHaveBeenCalledExactlyOnceWith({ limit: 3 });
    expect(h.add).not.toHaveBeenCalled(); expect(h.ack).not.toHaveBeenCalled();
  });

  it("logs a failed discovery enqueue without treating an output as acknowledged", async () => {
    const failure = new Error("fixture queue unavailable");
    h.discover.mockResolvedValue({ items: [{ taskId: TASK, deliveryVersion: 7 }], nextCursor: null }); h.add.mockRejectedValue(failure);
    try { await delivery.runMiniToolDeliveryJob({ name: "discover-mini-tool-deliveries", data: {} } as Job<unknown>); }
    catch { /* Discovery error propagation does not define the media acknowledgement. */ }
    expect(h.add).toHaveBeenCalledTimes(1); expect(h.ack).not.toHaveBeenCalled(); expect(h.defer).not.toHaveBeenCalled();
    expect(h.error.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: failure })])]));
  });

  it.each([
    { name: "deliver-mini-tool-results", data: { taskId: TASK, deliveryVersion: 7, model: "untrusted" } },
    { name: "discover-mini-tool-deliveries", data: { cursor: { taskId: TASK, dueAt: "2026-10-26T00:00:00Z" } } },
    { name: "unrecognized-delivery-name", data: { taskId: TASK, deliveryVersion: 7 } },
  ])("rejects raw job shape before any SQL recovery: %j", async (job) => {
    await expect(delivery.runMiniToolDeliveryJob(job as Job<unknown>)).rejects.toThrow();
    expect(h.read).not.toHaveBeenCalled(); expect(h.discover).not.toHaveBeenCalled(); expect(h.ack).not.toHaveBeenCalled(); expect(h.add).not.toHaveBeenCalled();
  });

  it.each([
    { name: "deliver-mini-tool-results", data: { taskId: TASK, deliveryVersion: 7 } },
    { name: "discover-mini-tool-deliveries", data: {} },
  ])("dispatches %j before legacy fields or consent handling", async (job) => {
    const route = vi.spyOn(delivery, "runMiniToolDeliveryJob").mockResolvedValue({});
    await expect(runTask(job as unknown as Parameters<typeof runTask>[0], "unused-delivery-token")).resolves.toEqual({});
    expect(route).toHaveBeenCalledExactlyOnceWith(job);
    expect(h.consent).not.toHaveBeenCalled(); expect(h.legacy).not.toHaveBeenCalled();
  });
});
