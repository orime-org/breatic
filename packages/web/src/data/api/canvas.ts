// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { TaskCreateInput } from '@breatic/shared';

import { apiGet, apiPost } from '@web/data/api/request';

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
   * {@link TaskCreateInput} wire contract (snake_case); build it with
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
};
