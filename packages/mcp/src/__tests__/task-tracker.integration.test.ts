// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { createRedisClient, type Redis } from "@breatic/core";
import { mcpInFlightTasksKey } from "@breatic/shared";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { ServerApi } from "@mcp/server-api.js";
import { createTaskTracker, type TaskRow } from "@mcp/tools/task-tracker.js";

let redis: Redis;
beforeAll(async () => {
  redis = createRedisClient(inject("REDIS_MCP_URL"), { name: "mcp-tracker-test" });
  await redis.connect();
});
afterAll(async () => {
  await redis.quit();
});

const PROJECT = randomUUID();
const SPACE = randomUUID();

/**
 * A row of `GET /canvas/node-tasks`.
 * @param taskId - The task.
 * @param status - Its status.
 * @param over - Fields to replace.
 * @returns The row.
 */
function row(taskId: string, status: TaskRow["status"], over: Partial<TaskRow> = {}): TaskRow {
  return { taskId, projectId: PROJECT, spaceId: SPACE, nodeId: randomUUID(), status, content: null, errorMessage: null, ...over };
}

/**
 * A server that answers the task query with `rows`, and records the ids it was asked.
 * @param rows - Every row it knows.
 * @returns The api and the id lists asked.
 */
function serverWith(rows: TaskRow[]): { api: ServerApi; asked: string[][] } {
  const asked: string[][] = [];
  const api: ServerApi = {
    get: async <T>(path: string, query?: Record<string, unknown>): Promise<T> => {
      expect(path).toBe("/canvas/node-tasks");
      const ids = String(query?.ids).split(",");
      asked.push(ids);
      return rows.filter((r) => ids.includes(r.taskId)) as T;
    },
    post: async () => {
      throw new Error("not used");
    },
  };
  return { api, asked };
}

/**
 * A tracker on a fresh prefix.
 * @param maxIds - Most ids one query names.
 * @returns The tracker, its connection and its prefix.
 */
function trackerOf(maxIds = 50): { tracker: ReturnType<typeof createTaskTracker>; connectionId: string; prefix: string } {
  const prefix = `mcp-tracker-${randomUUID().slice(0, 8)}`;
  const connectionId = randomUUID();
  return { tracker: createTaskTracker({ redis, prefix, connectionId, ttlSeconds: 900, maxIdsPerQuery: maxIds }), connectionId, prefix };
}

describe("task tracker", () => {
  it("asks nothing when the connection has no task in flight", async () => {
    const { tracker } = trackerOf();
    const { api, asked } = serverWith([]);
    expect(await tracker.finished(api)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("reports a finished task once, with the tool that started it, and keeps running ones", async () => {
    const { tracker, prefix, connectionId } = trackerOf();
    const done = randomUUID();
    const running = randomUUID();
    await tracker.track(done, "run_generation");
    await tracker.track(running, "understand_node");
    const doneRow = row(done, "done", { content: "https://cdn/x.png" });
    const { api } = serverWith([doneRow, row(running, "running")]);

    expect(await tracker.finished(api)).toEqual([{ ...doneRow, tool: "run_generation" }]);
    expect(await tracker.finished(api)).toEqual([]);
    expect(await redis.hkeys(mcpInFlightTasksKey(prefix, connectionId))).toEqual([running]);
    const ttl = await redis.ttl(mcpInFlightTasksKey(prefix, connectionId));
    expect(ttl).toBeGreaterThan(890);
  });

  it("waits until every node of a task has ended", async () => {
    const { tracker } = trackerOf();
    const task = randomUUID();
    await tracker.track(task, "run_mini_tool");
    const halfway = serverWith([row(task, "done"), row(task, "running")]);
    expect(await tracker.finished(halfway.api)).toEqual([]);
    const ended = serverWith([row(task, "done"), row(task, "failed", { errorMessage: "boom" })]);
    expect((await tracker.finished(ended.api)).map((r) => r.status)).toEqual(["done", "failed"]);
  });

  it("gives one of two concurrent calls each finished task", async () => {
    const { tracker } = trackerOf();
    const task = randomUUID();
    await tracker.track(task, "transcribe_node");
    const { api } = serverWith([row(task, "expired")]);
    const [a, b] = await Promise.all([tracker.finished(api), tracker.finished(api)]);
    expect(a.length + b.length).toBe(1);
  });

  it("asks in batches no longer than the query takes", async () => {
    const { tracker } = trackerOf(2);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await tracker.track(id, "run_generation");
    const { api, asked } = serverWith(ids.map((id) => row(id, "running")));
    await tracker.finished(api);
    expect(asked.map((list) => list.length).sort()).toEqual([1, 2]);
  });

  it("forgets the tasks a result call already reported", async () => {
    const { tracker } = trackerOf();
    const task = randomUUID();
    await tracker.track(task, "run_generation");
    await tracker.forget([task]);
    const { api, asked } = serverWith([row(task, "done")]);
    expect(await tracker.finished(api)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
