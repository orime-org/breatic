// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { keepPreviousData, useQuery, type Query } from '@tanstack/react-query';
import type { TimelineDocumentV1, TimelineWebResolution } from '@breatic/shared';
import { timelineExecutionEnded } from '@breatic/shared/space-content';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi } from '@web/data/api/timeline';
import { EMPTY_TIMELINE_WEB_RESOLUTION } from '@web/data/yjs/timeline-arrangement';

const NO_IDS: readonly string[] = [];

/**
 * The sorted distinct values.
 * @param values - The values.
 * @returns Them once each, in code-unit order.
 * @throws {never} Never.
 */
function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Resolve the source versions and executions the document's web-animation copies reference (inner#1711 design §3.2,
 * §9). It asks only for those ids, so moving a copy reads nothing; it lives under the Space-task key, so the page's
 * signal refetches it; and it polls while a resolved execution is unfinished, which also covers executions of another
 * Project whose signal this page never hears. A placeholder whose execution succeeded is resolved with its result.
 * @param projectId - The Project the document belongs to.
 * @param spaceId - The Timeline Space.
 * @param document - The current document.
 * @param refreshMs - The polling interval while an execution is unfinished; none polls nothing.
 * @returns The resolution, empty until the first answer.
 * @throws {never} Never.
 */
export function useTimelineWebResolution(projectId: string, spaceId: string, document: TimelineDocumentV1, refreshMs?: number): TimelineWebResolution {
  const references = React.useMemo(() => {
    const sources: string[] = [];
    const executions: string[] = [];
    for (const clip of Object.values(document.clips)) {
      if (clip.kind !== 'web-animation') continue;
      if (clip.contentBinding.baseSourceResultId !== null) sources.push(clip.contentBinding.baseSourceResultId);
      if (clip.contentBinding.operationId !== null) executions.push(clip.contentBinding.operationId);
    }
    return { sources: distinct(sources), executions: distinct(executions) };
  }, [document.clips]);
  // Results of succeeded placeholders that an answer did not include; asked for from then on.
  const [results, setResults] = React.useState(NO_IDS);
  const sourceIds = React.useMemo(() => distinct([...references.sources, ...results]), [references.sources, results]);
  const executionIds = references.executions;
  const queryKey = React.useMemo(
    () => [...spaceTasksQueryKey(projectId, spaceId), 'timeline-web-sources', sourceIds.join(','), executionIds.join(',')],
    [projectId, spaceId, sourceIds, executionIds],
  );
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.resolveWebSources(projectId, { sourceIds, executionIds }, signal),
    [projectId, sourceIds, executionIds]);
  const refetchInterval = React.useCallback((query: Query<TimelineWebResolution>): number | false => {
    const executions = query.state.data?.executions ?? {};
    return refreshMs !== undefined && executionIds.some((id) => { const execution = executions[id]; return execution !== undefined && !timelineExecutionEnded(execution.status); })
      ? refreshMs : false;
  }, [refreshMs, executionIds]);
  const enabled = sourceIds.length > 0 || executionIds.length > 0;
  const { data } = useQuery({ queryKey, queryFn, refetchInterval, enabled, placeholderData: keepPreviousData });
  const missing = React.useMemo(() => {
    if (data === undefined) return NO_IDS;
    return distinct(executionIds.flatMap((id) => {
      const result = data.executions[id]?.resultSourceVersionId ?? null;
      return result === null || data.sources[result] !== undefined || results.includes(result) ? [] : [result];
    }));
  }, [data, executionIds, results]);
  // Adjusting state while rendering: the ids only grow, so this settles after one pass.
  if (missing.length > 0) setResults([...results, ...missing]);
  return enabled ? data ?? EMPTY_TIMELINE_WEB_RESOLUTION : EMPTY_TIMELINE_WEB_RESOLUTION;
}
