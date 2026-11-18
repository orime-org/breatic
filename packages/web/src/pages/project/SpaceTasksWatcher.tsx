// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SPACE_TASKS_KEY } from '@breatic/shared';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { getDoc } from '@web/data/yjs/manager';

/**
 * Read a Space's background-work lists again whenever collab writes a new change version into its document (root
 * `AGENTS.md#space-task-state-lives-in-the-space-document`). Mounted with the tab's connection, so a tab not yet on
 * screen keeps its running mark current, and a reconnect that syncs a newer version reads the lists again too.
 * @param root0 - Props.
 * @param root0.projectId - The Project.
 * @param root0.spaceId - The Space.
 * @param root0.name - The Space's document name.
 * @returns Nothing visible.
 */
export function SpaceTasksWatcher({ projectId, spaceId, name }: { projectId: string; spaceId: string; name: string }): null {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    const tasks = getDoc(name).getMap(SPACE_TASKS_KEY);
    /** Mark every list of this Space stale, reading the ones on screen again. */
    const readAgain = (): void => { void queryClient.invalidateQueries({ queryKey: spaceTasksQueryKey(projectId, spaceId) }); };
    tasks.observe(readAgain);
    return (): void => { tasks.unobserve(readAgain); };
  }, [queryClient, projectId, spaceId, name]);
  return null;
}
