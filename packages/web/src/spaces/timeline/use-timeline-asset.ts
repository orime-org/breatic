// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';

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
 * @returns The query.
 * @throws {never} Never.
 */
export function useTimelineAsset(projectId: string, assetId: string): UseQueryResult<Awaited<ReturnType<typeof timelineApi.resolveAsset>>> {
  const queryKey = React.useMemo(() => timelineAssetKey(projectId, assetId), [projectId, assetId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.resolveAsset(projectId, assetId, signal), [projectId, assetId]);
  return useQuery({ queryKey, queryFn, enabled: assetId !== '' });
}

/** One registered asset as the preview reads it. */
export type TimelineAssetQuery = UseQueryResult<Awaited<ReturnType<typeof timelineApi.resolveAsset>>>;

/**
 * Resolve several registered assets at once, sharing each one's cache entry with `useTimelineAsset`.
 * @param projectId - The authorizing Project.
 * @param assetIds - The registered assets.
 * @returns Each asset's query, by asset id.
 * @throws {never} Never.
 */
export function useTimelineAssets(projectId: string, assetIds: readonly string[]): ReadonlyMap<string, TimelineAssetQuery> {
  const queries = React.useMemo(() => assetIds.map((assetId) => ({
    queryKey: timelineAssetKey(projectId, assetId),
    queryFn: ({ signal }: { signal: AbortSignal }) => timelineApi.resolveAsset(projectId, assetId, signal),
  })), [projectId, assetIds]);
  /**
   * Key the results by asset; `useQueries` runs it again only when a result changed, so the map keeps its identity.
   * @param results - The queries' results, in order.
   * @returns Each asset's query, by asset id.
   * @throws {never} Never.
   */
  const combine = React.useCallback((results: TimelineAssetQuery[]): ReadonlyMap<string, TimelineAssetQuery> =>
    new Map(assetIds.map((assetId, index) => [assetId, results[index]!] as const)), [assetIds]);
  return useQueries({ queries, combine });
}
