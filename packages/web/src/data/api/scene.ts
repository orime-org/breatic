// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { apiGet } from '@web/data/api/request';

/**
 * Runtime controls parameters from the owning Project's readable API.
 * @param projectId - Project whose scene or registered model is being read.
 * @param signal - Cancellation signal for this request.
 * @returns Runtime controls parameters returned by the Project API.
 */
export function getSceneControls(projectId: string, signal?: AbortSignal): Promise<{ scaleSensitivity: number }> {
  return apiGet(`/projects/${projectId}/three-d/config`, { signal });
}

/**
 * Resolve an already registered GLB using Project access and its Studio's asset ledger.
 * @param projectId - Project whose scene or registered model is being read.
 * @param assetId - Registered model identity stored in the scene.
 * @param signal - Cancellation signal for this request.
 * @returns Registered model URL and MIME descriptor.
 */
export function resolveSceneAsset(projectId: string, assetId: string, signal: AbortSignal): Promise<{ url: string; mimeType: string }> {
  return apiGet(`/projects/${projectId}/three-d/assets/${assetId}`, { signal });
}
