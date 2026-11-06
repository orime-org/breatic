// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { apiDelete, apiGet, apiPost } from '@web/data/api/request';
import type { SceneControlsConfig } from '@breatic/shared';

/**
 * Scene controls and model import budgets from the owning Project's readable API.
 * @param projectId - Project whose scene or registered model is being read.
 * @param signal - Cancellation signal for this request.
 * @returns The scale sensitivity and the model import budgets returned by the Project API.
 */
export function getSceneControls(projectId: string, signal?: AbortSignal): Promise<SceneControlsConfig> {
  return apiGet(`/projects/${projectId}/three-d/config`, { signal });
}

/**
 * Resolve an already registered GLB or model package using Project access and its Studio's asset ledger.
 * @param projectId - Project whose scene or registered model is being read.
 * @param assetId - Registered model identity stored in the scene.
 * @param signal - Cancellation signal for this request.
 * @returns Registered model URL, MIME type and registered size.
 */
export function resolveSceneAsset(projectId: string, assetId: string, signal: AbortSignal): Promise<{ url: string; mimeType: string; sizeBytes: number }> {
  return apiGet(`/projects/${projectId}/three-d/assets/${assetId}`, { signal });
}

/** One row of a 3D Space's task list, as the server answers it. */
export interface SpaceTask {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed' | 'expired';
  startedByUserId: string;
  startedAt: string;
  deadlineAt: string;
  errorMessage: string | null;
  assetId: string | null;
}

/** A 3D Space's task list, with the server's clock its deadlines are read against. */
export interface SpaceTaskList {
  serverNow: string;
  tasks: SpaceTask[];
}

/**
 * The query key one 3D Space's task list is cached under; the page's signal listener invalidates it.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @returns The key.
 */
export function spaceTasksQueryKey(projectId: string, spaceId: string): readonly [string, string, string] {
  return ['space-tasks', projectId, spaceId];
}

/**
 * Read a 3D Space's task list (inner#1690); reading it also judges overdue rows dead.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param signal - Cancellation signal for this request.
 * @returns The rows, newest first, and the server's clock.
 */
export function listSpaceTasks(projectId: string, spaceId: string, signal?: AbortSignal): Promise<SpaceTaskList> {
  return apiGet(`/projects/${projectId}/three-d/${spaceId}/tasks`, { signal });
}

/**
 * Remove a failed row, or an expired one holding no model.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @returns Once the server removed it.
 */
export async function removeSpaceTask(projectId: string, spaceId: string, taskId: string): Promise<void> {
  await apiDelete(`/projects/${projectId}/three-d/${spaceId}/tasks/${taskId}`);
}

/**
 * Tell the server this page's bytes never reached the edge.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @returns Once the server recorded it.
 */
export async function reportSpaceTaskFailure(projectId: string, spaceId: string, taskId: string): Promise<void> {
  await apiPost(`/projects/${projectId}/three-d/${spaceId}/tasks/${taskId}/failure`, { reason: 'aborted' });
}
