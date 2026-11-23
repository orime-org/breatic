// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { SceneControlsConfig } from '@breatic/shared';

import { getSceneControls } from '@web/data/api/scene';

/**
 * The Project's 3D settings, read once per Project and signed-in user and shared by every caller (the 3D editor, its
 * upload-progress publisher and Motion's "Put on canvas"). Nothing is read until the user is known, so a read is never
 * made, or cached, for nobody.
 * @param projectId - The Project.
 * @param userId - The signed-in user, or undefined or empty while unknown.
 * @returns The query.
 * @throws {never} Never.
 */
export function useSceneControls(projectId: string, userId: string | undefined): UseQueryResult<SceneControlsConfig> {
  return useQuery({
    queryKey: ['scene-controls', projectId, userId],
    queryFn: ({ signal }) => getSceneControls(projectId, signal),
    enabled: Boolean(userId),
  });
}
