// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { NodeTaskCounts, TaskCreateInput } from '@breatic/shared';

import { apiDelete, apiGet, apiPost } from '@web/data/api/request';

export interface CanvasTask {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  finishedAt?: string;
  resultUrl?: string;
  errorMessage?: string;
}

/** Canvas knobs served by `GET /canvas/limits` (config/limits.yaml, #1782). */
export interface CanvasLimits {
  /**
   * Max entries in one node's reference pool — incoming reference edges +
   * focus crops combined. Enforced by the frontend at add time (soft cap).
   */
  referencePoolCap: number;
  /**
   * Page size the frontend requests per infinite-scroll page of a node's
   * history (#1619). A soft UI knob — the server default (20) applies before
   * this loads.
   */
  nodeHistoryPageSize: number;
}

/**
 * One node-history row (#1619) — a past generation (success or failed) or a
 * user upload. `createdAt` is an ISO-8601 string over the wire (JSON has no
 * Date). `metadata` is the free-form jsonb the backend recorded: a generation
 * carries `model` / `cost`, an upload carries `filename`.
 */
export interface NodeHistoryEntry {
  id: string;
  /**
   * Display name of the operator, joined server-side from their personal
   * studio (pointer model — renames propagate). `null` when unresolved
   * (studio deleted); the row then shows the time alone (#1619).
   */
  operatorName: string | null;
  entryType: 'generation' | 'upload';
  status: 'success' | 'failed';
  /** The result asset URL; `null` for a failed generation. */
  content: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  metadata: {
    model?: string;
    cost?: number;
    filename?: string;
    [k: string]: unknown;
  };
  createdAt: string;
}

/**
 * One row of a node's task list (#186) — what `GET /canvas/nodes/:id/tasks`
 * hands back.
 *
 * `content` / `coverUrl` are what this task put on the node, read across
 * server-side from the history row it names. They are present on a task that
 * landed something, which includes one judged expired before its report
 * arrived; the user replaces the node's content from them without a second
 * request.
 */
export interface NodeTaskEntry {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  /** `upload` or `generation`. */
  kind: string;
  status: 'running' | 'done' | 'failed' | 'expired';
  startedByUserId: string;
  /** Server time the task opened, ISO 8601. */
  startedAt: string;
  /** The conservative allowance this task was given, in ms. */
  budgetMs: number;
  /** What the user reads: the filename or the model name. */
  label: string;
  errorMessage: string | null;
  nodeHistoryId: string | null;
  content: string | null;
  coverUrl: string | null;
}

let limitsCache: CanvasLimits | null = null;

/**
 * Sync accessor for gate callbacks: the cached reference-pool cap, or
 * `null` while the knob has not loaded yet — a soft cap simply does not
 * gate until then (degrade-to-uncapped; no fallback constant that could
 * drift from the yaml value).
 * @returns The cached cap, or null before the first successful fetch.
 */
export function getCachedReferencePoolCap(): number | null {
  return limitsCache ? limitsCache.referencePoolCap : null;
}

export const canvasApi = {
  /**
   * Fetch the canvas limits knobs, cached for the session (they only
   * change on a config redeploy). A failed fetch is NOT cached — the next
   * call retries.
   * @returns The canvas limits (unwrapped from the `{ data }` envelope).
   * @throws {import('@web/data/api/types').ApiException} On a failed request.
   */
  async fetchLimits(): Promise<CanvasLimits> {
    if (limitsCache) return limitsCache;
    const cfg = await apiGet<CanvasLimits>('/canvas/limits');
    limitsCache = cfg;
    return cfg;
  },

  /**
   * Drop the session cache (tests only).
   */
  resetLimitsCache(): void {
    limitsCache = null;
  },

  /**
   * Enqueue a canvas generation task. The body is the shared
   * `TaskCreateInput` wire contract (snake_case); build it with
   * `buildGenerateTaskPayload` for image-node Generate.
   * @param body - The `POST /canvas/tasks` request body.
   * @returns The created task (unwrapped from the `{ data }` envelope).
   * @throws {import('@web/data/api/types').ApiException} On 402 / 409 / 503 etc.
   */
  createTask(body: TaskCreateInput): Promise<CanvasTask> {
    return apiPost<CanvasTask>('/canvas/tasks', body);
  },
  understand(body: {
    projectId: string;
    spaceId: string;
    nodeId: string;
    sourceUrl: string;
    /** asr | description | etc. */
    kind: string;
  }) {
    return apiPost<CanvasTask>('/canvas/understand', body);
  },
  listTasks(projectId: string, params: { page?: number; limit?: number } = {}) {
    return apiGet<{ tasks: CanvasTask[] }>('/canvas/tasks', {
      params: { projectId, ...params },
    });
  },

  /**
   * List a node's content history (generations + uploads), newest first,
   * paginated (#1619). The endpoint nests `{ entries, total }` under `data`,
   * so `apiGet` unwraps it in one hop (no bespoke raw read).
   * @param nodeId - Canvas node id (uuid).
   * @param projectId - Project the node belongs to (tenancy check, viewer+).
   * @param opts - Pagination window.
   * @param opts.limit - Page size (from {@link CanvasLimits.nodeHistoryPageSize}).
   * @param opts.offset - Rows to skip.
   * @returns The page of entries plus the total count matching the node.
   * @throws {import('@web/data/api/types').ApiException} On a failed request.
   */
  listNodeHistory(
    nodeId: string,
    projectId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ entries: NodeHistoryEntry[]; total: number }> {
    return apiGet<{ entries: NodeHistoryEntry[]; total: number }>(
      `/canvas/nodes/${nodeId}/history`,
      {
        params: {
          project_id: projectId,
          limit: opts.limit,
          offset: opts.offset,
        },
      },
    );
  },

  /**
   * List the tasks behind a node's four counts (#186).
   *
   * The document carries the numbers; this carries the rows they were counted
   * from, and only when the user opens the list. Each row already holds what
   * that task landed on the node, so "replace" needs no second request.
   * @param nodeId - Canvas node id (uuid).
   * @param projectId - Project the node belongs to (tenancy check, viewer+).
   * @returns The node's live task rows, newest first.
   * @throws {import('@web/data/api/types').ApiException} On a failed request.
   */
  async listNodeTasks(
    nodeId: string,
    projectId: string,
  ): Promise<NodeTaskEntry[]> {
    const { tasks } = await apiGet<{ tasks: NodeTaskEntry[] }>(
      `/canvas/nodes/${nodeId}/tasks`,
      { params: { project_id: projectId } },
    );
    return tasks;
  },

  /**
   * Drop one task record — the same request behind both "finish" and "clear"
   * (#186 §7.4). Which one it was is decided by the state the row is in.
   *
   * The caller's own node rides along so the server can recount even when it
   * cannot find the row: the user is acting on what their screen shows, and
   * "clear this" means clear it.
   * @param taskId - The row the user acted on.
   * @param at - Where the caller is: the project, space and node.
   * @param at.projectId - Owning project.
   * @param at.spaceId - The space the node lives in.
   * @param at.nodeId - The node whose counts get recomputed.
   * @returns Whether a row was removed, plus the node's counts afterwards.
   * @throws {import('@web/data/api/types').ApiException} On 403, or 409 when
   *   the task has not settled yet.
   */
  dismissNodeTask(
    taskId: string,
    at: { projectId: string; spaceId: string; nodeId: string },
  ): Promise<{ removed: boolean; counts: NodeTaskCounts }> {
    return apiDelete<{ removed: boolean; counts: NodeTaskCounts }>(
      `/canvas/node-tasks/${taskId}`,
      {
        params: {
          project_id: at.projectId,
          space_id: at.spaceId,
          node_id: at.nodeId,
        },
      },
    );
  },
};
