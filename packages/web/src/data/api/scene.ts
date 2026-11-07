// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { apiDelete, apiGet, apiPost, runOnceRequest } from '@web/data/api/request';
import type { ProjectAssetPage, SceneControlsConfig } from '@breatic/shared';

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

/**
 * One row of a 3D Space's task list, as the server answers it: a model
 * import, or a 3D generation (`kind: 'generation'`), which carries what a
 * retry fills the dialog with. Only an import row has `errorMessage`; only a
 * generation row has the fields after it.
 */
export interface SpaceTask {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed' | 'expired';
  startedByUserId: string;
  startedAt: string;
  deadlineAt: string;
  assetId: string | null;
  /** Absent on rows from a server that knew only imports. */
  kind?: 'import' | 'generation';
  errorMessage?: string | null;
  /** The `task-failure` code a generation failed with. */
  errorCode?: string | null;
  origin?: 'space' | 'agent' | null;
  model?: { name: string; displayName: string };
  mode?: string;
  prompt?: string | null;
  negativePrompt?: string | null;
  /** The resolved settings, without the prompt, the negative prompt or the views. */
  params?: Record<string, unknown>;
  /** The views in front, left, back, right order. */
  inputs?: { assetId: string; url: string }[];
}

/** A generation row, with the fields only it carries. */
export type SpaceGenerationTask = SpaceTask & Required<Pick<SpaceTask, 'kind' | 'model' | 'mode' | 'params' | 'inputs'>> & { kind: 'generation' };

/**
 * Whether a row is a 3D generation.
 * @param task - The row.
 * @returns True for a generation row.
 */
export function isGenerationTask(task: SpaceTask): task is SpaceGenerationTask {
  return task.kind === 'generation';
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

/** What a 3D generation submit sends (inner#1691 design 4.2). */
export interface SceneGenerationBody {
  mode: 't23d' | 'i23d';
  model: string;
  prompt?: string;
  params: Record<string, unknown>;
  image_asset_ids?: string[];
  origin: 'space' | 'agent';
}

/** What the server answers a 3D generation submit with; `failed` names a row that holds the reason. */
export interface SceneGenerationAnswer {
  task_id: string;
  row_id: string;
  status: 'pending' | 'failed';
}

/**
 * Submit one 3D generation from a Space's dialog.
 * @param projectId - The project.
 * @param spaceId - The 3D Space whose task list takes the row.
 * @param body - The run.
 * @param key - The press's `Idempotency-Key`.
 * @returns The run and its row.
 */
export function submitSceneGeneration(projectId: string, spaceId: string, body: SceneGenerationBody, key: string): Promise<SceneGenerationAnswer> {
  return apiPost(`/projects/${projectId}/three-d/${spaceId}/generations`, body, runOnceRequest(key));
}

/**
 * Ask the queue how a timed-out generation really stands (design 4.4).
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @returns Still running, a result found and attached, or ended without one.
 */
export function checkSpaceTask(projectId: string, spaceId: string, taskId: string): Promise<{ outcome: 'running' | 'has_result' | 'ended' }> {
  return apiPost(`/projects/${projectId}/three-d/${spaceId}/tasks/${taskId}/check`, undefined, undefined);
}

/**
 * The query key one Project's image list is cached under.
 * @param projectId - The project.
 * @returns The key.
 */
export function projectImagesQueryKey(projectId: string): readonly [string, string] {
  return ['project-images', projectId];
}

/**
 * Read one page of the images this Project references (design 4.1).
 * @param projectId - The project.
 * @param cursor - Where the page starts; the first page when absent.
 * @param signal - Cancellation signal for this request.
 * @returns The page and the cursor of the next one.
 */
export function listProjectImages(projectId: string, cursor?: string, signal?: AbortSignal): Promise<ProjectAssetPage> {
  return apiGet(`/projects/${projectId}/assets`, { params: { kind: 'image', cursor }, signal });
}
