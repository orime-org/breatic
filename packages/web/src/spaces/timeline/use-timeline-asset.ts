// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { timelineApi } from '@web/data/api/timeline';

/**
 * The query key every Timeline reader of one registered asset shares.
 * @param projectId - The authorizing Project.
 * @param assetId - The registered asset.
 * @returns The key.
 * @throws {never} Never.
 */
export function timelineAssetKey(projectId: string, assetId: string): readonly ['timeline-asset', string, string] {
  return ['timeline-asset', projectId, assetId];
}

/**
 * Resolve a registered asset for the Timeline: its name, file and cover.
 * @param projectId - The authorizing Project.
 * @param assetId - The registered asset; '' resolves nothing.
 * @param enabled - Whether to fetch; defaults to whenever there is an asset.
 * @returns The query.
 * @throws {never} Never.
 */
export function useTimelineAsset(projectId: string, assetId: string, enabled = assetId !== ''): UseQueryResult<Awaited<ReturnType<typeof timelineApi.resolveAsset>>> {
  const queryKey = React.useMemo(() => timelineAssetKey(projectId, assetId), [projectId, assetId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.resolveAsset(projectId, assetId, signal), [projectId, assetId]);
  return useQuery({ queryKey, queryFn, enabled });
}
