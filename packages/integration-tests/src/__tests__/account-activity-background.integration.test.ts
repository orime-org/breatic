// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import type * as Domain from "@breatic/domain";
import type { createApp } from "@server/app.js";
import { createQueue, getStreamRedis, initCore, loadLocales } from "@breatic/core";
import { nodeTaskService, taskService } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { runUsageLookup } from "@worker/handlers/usage-lookup.js";
import { recordGenerationForNodes } from "@worker/handlers/dispatch.js";
import * as memoryService from "@server/modules/memory/memory.service.js";
import { activityRows, seedActivityProject } from "@server/__tests__/integration/helpers/account-activity-fixture.js";

// The outside provider's eventual cost response is the only substituted boundary.
// Its recorder, SQL, queue, worker handler and user-activity reads remain real.
vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof Domain>(),
  provider: () => ({
    cost: {
      lookup: async () => ({ state: "known", usd: 0.01, source: "billing", tokens: { input: 1, output: 1, cachedInput: 0, reasoning: 0 } }),
      fromGeneration: (generationId: string) => ({ upstream: "openrouter", generationId }),
    },
  }),
}));

initCore({ ...process.env, PAYMENT_ENABLED: "false", WAVESPEED_API_KEY: "unused_activity_background_fixture" });
loadLocales();
let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { sql = postgres(inject("DATABASE_URL"), { max: 5, prepare: false }); app = (await import("@server/app.js")).createApp(); });
afterAll(async () => { await sql?.end({ timeout: 1 }); });

describe("delayed internal work does not create user return activity (inner#1893 P21)", () => {
  it("commits automatic memory and its watermark without appending user activity", async () => {
    const project = await seedActivityProject(sql);
    const [chat] = await sql<{ id: string }[]>`INSERT INTO conversations(user_id,project_id) VALUES(${project.userId},${project.projectId}) RETURNING id`;
    expect(await memoryService.commitConsolidation({ userId: project.userId, projectId: project.projectId, conversationId: chat!.id,
      shown: [], watermarkBefore: 0, newWatermark: 2, progress: "summarized conversation",
      operations: [{ op: "add", scope: "project", title: "Summarized Project", content: "automatic fold" }] })).toBe("written");
    expect(await memoryService.buildContext(project.userId, chat!.id, project.projectId)).toMatchObject({ progress: "summarized conversation" });
    const [row] = await sql<{ last_consolidated_turn: number }[]>`SELECT last_consolidated_turn FROM conversations WHERE id=${chat!.id}`;
    expect(row?.last_consolidated_turn).toBe(2);
    expect(await activityRows(sql, project.userId)).toEqual([]);
  });

  it("records a queued delayed usage lookup while preserving the original user confirmation", async () => {
    const project = await seedActivityProject(sql);
    const visitId = randomUUID();
    const response = await app.request(`/api/v1/projects/${project.projectId}/opened`, {
      method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ visit_id: visitId }),
    });
    expect(response.status).toBe(200);
    await sql`UPDATE account_activity_events SET occurred_at='2026-10-31T23:59:59.123456Z' WHERE user_id=${project.userId}`;
    const before = await activityRows(sql, project.userId);
    expect(before).toHaveLength(1);
    const operationKey = `activity-usage:${randomUUID()}`;
    const queue = createQueue(`activity-lookup-${randomUUID()}`);
    const job = await queue.add("lookup", { generationId: randomUUID(), model: "deepseek-chat", operationKey, feature: "chat_turn", source: "model",
      actorUserId: project.userId, projectId: project.projectId, description: "delayed fixture cost", charge: false }, { attempts: 1 });
    try {
      await runUsageLookup(job);
      const rows = await sql<{ operation_key: string }[]>`SELECT operation_key FROM agent_usage_records WHERE operation_key=${operationKey}`;
      expect(rows).toEqual([{ operation_key: operationKey }]);
      expect(await activityRows(sql, project.userId)).toEqual(before);
    } finally { await job.remove(); await queue.close(); }
  });

  it("finishes a real generation and records its node history without moving its original activity instant", async () => {
    const project = await seedActivityProject(sql);
    const spaceId = randomUUID();
    const nodeId = randomUUID();
    const response = await app.request("/api/v1/canvas/tasks", {
      method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ project_id: project.projectId, space_id: spaceId, task_type: "image", model: "flux-schnell", mode: "append", params: { prompt: "a tree" } }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const taskId = ((await response.json()) as { data: { task_id: string } }).data.task_id;
    await sql`UPDATE account_activity_events SET occurred_at='2026-10-31T23:59:59.654321Z' WHERE user_id=${project.userId}`;
    const before = await activityRows(sql, project.userId);
    expect(before).toHaveLength(1);
    await nodeTaskService.open({ projectId: project.projectId, spaceId, nodeId, kind: "generation", action: "generate", startedByUserId: project.userId,
      budgetMs: 120_000, label: "flux-schnell", taskId });
    const result = { url: "https://assets.example.test/completed.png" };
    await taskService.markCompleted(taskId, result, 0, 1000);
    await recordGenerationForNodes(getStreamRedis(), canvasSpaceDocName(project.projectId, spaceId), {
      projectId: project.projectId, userId: project.userId, taskId, taskType: "image", metadata: { model: "flux-schnell", credits: 0, durationMs: 1000 },
    }, [{ nodeId, content: result.url, mimeType: "image/png", width: 100, height: 100 }], { rethrowOnRecordFailure: true });
    const [task] = await sql<{ status: string }[]>`SELECT status FROM tasks WHERE id=${taskId}`;
    expect(task?.status).toBe("completed");
    const history = await sql`SELECT id FROM node_history WHERE task_id=${taskId} AND node_id=${nodeId}`;
    expect(history).toHaveLength(1);
    expect(await activityRows(sql, project.userId)).toEqual(before);
  });
});
