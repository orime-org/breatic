// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createQueue } from "@breatic/core";
import { call, useInternalApp } from "./internal-api-harness.js";
import { maintenanceWorld, requestKey } from "./maintenance.fixture.js";

const suite = useInternalApp("internal-maintenance");
const base = "/internal/v1/maintenance";

describe("signed maintenance endpoints", () => {
  it("reads independent paused and prioritized counts from the tasks queue", async () => {
    const queue = createQueue("tasks");
    try {
      await queue.obliterate({ force: true });
      await queue.add("normal-before-pause", { fixture: true });
      await queue.add("prioritized-before-pause", { fixture: true }, { priority: 1 });
      await queue.pause();
      await queue.add("normal-after-pause", { fixture: true });
      const observed = await queue.getJobCounts("waiting", "paused", "prioritized", "active", "delayed", "failed", "waiting-children");
      expect(observed).toEqual({ waiting: 0, paused: 2, prioritized: 1, active: 0, delayed: 0, failed: 0, "waiting-children": 0 });
      const before = Date.now();
      const response = await call(suite.baseUrl, `${base}/queue`);
      const after = Date.now();
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({
        queue: "tasks",
        counts: { waiting: 0, paused: 2, prioritized: 1, active: 0, delayed: 0, failed: 0, waitingChildren: 0 },
        retention: { failedAgeSeconds: 86400, failedCount: 1000 },
      });
      expect(typeof response.json.sampledAt).toBe("string");
      expect(Date.parse(response.json.sampledAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(response.json.sampledAt)).toBeLessThanOrEqual(after);
    } finally {
      await queue.resume();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("reports successful lookup absence for an unknown original operation key", async () => {
    const response = await call(suite.baseUrl, `${base}/reclaim/operations/bo-${randomUUID()}`);
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ code: "not_found" });
  });

  it("reports successful lookup absence for an unknown control request key", async () => {
    const response = await call(suite.baseUrl, `${base}/reclaim/controls/bo-${randomUUID()}`);
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ code: "not_found" });
  });

  it.each([
    ["GET", "/queue"],
    ["GET", "/reclaim/candidates"],
    ["GET", `/reclaim/operations/${requestKey()}`],
    ["GET", `/reclaim/controls/${requestKey()}`],
    ["POST", "/reclaim/preview"],
    ["POST", "/reclaim/operations"],
    ["POST", `/reclaim/operations/${requestKey()}/control`],
    ["POST", `/reclaim/operations/${requestKey()}/resume`],
  ] as const)("rejects unsigned %s %s before product state is read", async (method, suffix) => {
    const response = await call(suite.baseUrl, `${base}${suffix}`, { method, unsigned: true, ...(method === "POST" ? { body: {}, idempotencyKey: requestKey() } : {}) });
    expect(response.status).toBe(401);
    expect(response.json).toEqual({ code: "unauthorized" });
  });

  it("does not infer a cover's original grant by stripping a key suffix", async () => {
    const world = await maintenanceWorld(suite.sql, "cover");
    await suite.sql`UPDATE storage_reclaim_queue SET storage_key=${world.storageKey.replace(".png", "_cover.png")} WHERE id=${world.id}`;
    const response = await call(suite.baseUrl, `${base}/reclaim/preview`, { body: { ids: [world.id] } });
    expect(response.status).toBe(200);
    expect(response.json.items).toHaveLength(1);
    expect(response.json.items[0]).toMatchObject({ id: world.id, eligible: false, reason: "origin_missing" });
  });

  it("does not infer an upright candidate's original grant by stripping a key suffix", async () => {
    const world = await maintenanceWorld(suite.sql);
    await suite.sql`UPDATE storage_reclaim_queue SET storage_key=${world.storageKey.replace(".png", "_upright.png")} WHERE id=${world.id}`;
    const response = await call(suite.baseUrl, `${base}/reclaim/preview`, { body: { ids: [world.id] } });
    expect(response.status).toBe(200);
    expect(response.json.items).toHaveLength(1);
    expect(response.json.items[0]).toMatchObject({ id: world.id, eligible: false, reason: "origin_missing" });
  });

  it.each([{}, { ids: [] }, { ids: ["not-a-uuid"] }, { ids: [randomUUID()], unexpected: true }])("rejects malformed preview input %j", async (body) => {
    const response = await call(suite.baseUrl, `${base}/reclaim/preview`, { body });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ code: "invalid_body" });
  });
});
