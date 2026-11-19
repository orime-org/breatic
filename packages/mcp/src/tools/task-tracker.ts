// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tasks one connection started and has not been told the end of
 * (breatic#1488 §7 `finishedTasks`, §9). A hash in Redis DB 4 under
 * `mcpInFlightTasksKey`: the task id, and the tool that started it. Every
 * tool call asks the server about the ones listed; whichever call removes a
 * finished task is the one that reports it, so concurrent calls of the same
 * connection (other sessions included) never report one twice.
 */

import type { Redis } from "@breatic/core";
import { mcpInFlightTasksKey } from "@breatic/shared";
import type { ServerApi } from "@mcp/server-api.js";

/** One node row of `GET /canvas/node-tasks`. */
export interface TaskRow {
  taskId: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  status: "running" | "done" | "failed" | "expired";
  content: string | null;
  errorMessage: string | null;
}

/** A finished task's row, with the tool that started it. */
export type FinishedTask = TaskRow & { tool: string };

/** The tracker of one connection. */
export interface TaskTracker {
  /** List a task the connection started. */
  track: (taskId: string, tool: string) => Promise<void>;
  /** The listed tasks that have ended, each reported once; they leave the list. */
  finished: (api: ServerApi) => Promise<FinishedTask[]>;
  /** Take tasks off the list, as a result call that reported them does. */
  forget: (taskIds: readonly string[]) => Promise<void>;
}

/** What the tracker runs on. */
export interface TaskTrackerOptions {
  redis: Redis;
  prefix: string;
  connectionId: string;
  /** How long the list lives after its last task was added: the task budget plus `reply_ttl_seconds`. */
  ttlSeconds: number;
  /** `task_query_max_ids`. */
  maxIdsPerQuery: number;
}

/**
 * Ask the server about tasks, a batch at a time.
 * @param api - The server.
 * @param ids - The task ids.
 * @param size - Most ids one query names.
 * @returns Every row the server answered.
 */
export async function taskRows(api: ServerApi, ids: readonly string[], size: number): Promise<TaskRow[]> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  const answers = await Promise.all(batches.map((batch) => api.get<TaskRow[]>("/canvas/node-tasks", { ids: batch.join(",") })));
  return answers.flat();
}

/**
 * Open the tracker of one connection.
 * @param options - What it runs on.
 * @returns The tracker.
 */
export function createTaskTracker(options: TaskTrackerOptions): TaskTracker {
  const { redis, connectionId, ttlSeconds, maxIdsPerQuery } = options;
  const key = mcpInFlightTasksKey(options.prefix, connectionId);
  return {
    async track(taskId, tool) {
      await redis.multi().hset(key, taskId, tool).expire(key, ttlSeconds).exec();
    },

    async finished(api) {
      const listed = await redis.hgetall(key);
      const ids = Object.keys(listed);
      if (ids.length === 0) return [];
      const byTask = new Map<string, TaskRow[]>();
      for (const one of await taskRows(api, ids, maxIdsPerQuery)) byTask.set(one.taskId, [...(byTask.get(one.taskId) ?? []), one]);
      const ended = [...byTask].filter(([, rows]) => rows.every((r) => r.status !== "running"));
      const removed = await Promise.all(ended.map(([taskId]) => redis.hdel(key, taskId)));
      return ended.flatMap(([taskId, rows], i) => (removed[i] === 1 ? rows.map((r) => ({ ...r, tool: listed[taskId]! })) : []));
    },

    async forget(taskIds) {
      if (taskIds.length > 0) await redis.hdel(key, ...taskIds);
    },
  };
}
