// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useMotionList } from '@web/spaces/web-animation/use-motion-lists';

/**
 * How many of a Motion Space's own executions are still in progress, read from the same in-progress list the open
 * Space shows, so both share one request; the Space's document reads it again on every change (#1490 design §4.7,
 * §8.3).
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param enabled - Whether this Space is a Motion Space.
 * @returns Whether any is in progress.
 * @throws {never} Never.
 */
export function useMotionRunning(projectId: string, spaceId: string, enabled: boolean): boolean {
  const list = useMotionList(projectId, spaceId, 'space', 'running', enabled);
  return enabled && (list.data?.pages[0]?.totals?.running ?? 0) > 0;
}
