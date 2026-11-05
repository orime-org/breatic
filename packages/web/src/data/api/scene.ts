// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { apiGet } from '@web/data/api/request';
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
