// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { listSpaceTasks, spaceTasksQueryKey, type SpaceTaskList } from '@web/data/api/scene';

/** One 3D Space's task list and how many of its rows run. */
export interface SpaceTasks {
  query: UseQueryResult<SpaceTaskList>;
  /** The rows the last read held as running, a row waiting for a running slot included; 0 before any read. */
  running: number;
}

/**
 * The read of a 3D Space's task list that its task panel, its tab spinner and its Tasks count share. It is read again
 * when the Space's document records a change (`SpaceTasksWatcher`), a deadline included, since the worker's sweep
 * announces it; nothing reads it on a timer. A read that fails keeps the rows it last had.
 * @param projectId - The Project.
 * @param spaceId - The 3D Space.
 * @param enabled - Whether to read the list at all; false reads nothing.
 * @returns The query and its running count.
 * @throws {never} Never.
 */
export function useSpaceTasks(projectId: string, spaceId: string, enabled = true): SpaceTasks {
  const queryKey = React.useMemo(() => spaceTasksQueryKey(projectId, spaceId), [projectId, spaceId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => listSpaceTasks(projectId, spaceId, signal), [projectId, spaceId]);
  const query = useQuery({ queryKey, queryFn, enabled });
  const tasks = query.data?.tasks;
  const running = React.useMemo(() => tasks?.filter((task) => task.status === 'running').length ?? 0, [tasks]);
  return { query, running };
}
