// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { timelineApi } from '@web/data/api/timeline';
import { ApiException } from '@web/data/api/types';

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
  // A read that failed is tried again from its retry, not by every reader mounting later (a newly selected clip's
  // properties show the same failure its track already shows, inner#1709).
  return useQuery({ queryKey, queryFn, enabled: assetId !== '', retryOnMount: false });
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

/** Why a clip's file cannot be read (inner#1709): the user may not read it, or reading it failed. */
export type TimelineMediaProblem = 'forbidden' | 'readFailed';

/**
 * The problem an asset read and its element report: a 403 from the asset read is no permission; any other read error,
 * or a failed element, is a read failure. Cached data stays usable when a refetch fails.
 * @param asset - The asset read, if any.
 * @param elementFailed - Whether the clip's element or decode failed.
 * @returns The problem, or null when the file can be read.
 * @throws {never} Never.
 */
export function timelineMediaProblem(asset: TimelineAssetQuery | undefined, elementFailed = false): TimelineMediaProblem | null {
  if (asset?.data === undefined && asset?.isError === true) return asset.error instanceof ApiException && asset.error.status === 403 ? 'forbidden' : 'readFailed';
  return elementFailed ? 'readFailed' : null;
}
