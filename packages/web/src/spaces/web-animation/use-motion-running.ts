// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useTimelineLimits } from '@web/spaces/timeline/use-timeline-limits';
import { useMotionList } from '@web/spaces/web-animation/use-motion-lists';

/**
 * How many of a Motion Space's own executions are still in progress, read from the same in-progress list the open
 * Space shows, so both share one request and one poll; the Space-task signal reads it again at once (#1490 design
 * §8.3).
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param enabled - Whether this Space is a Motion Space.
 * @returns Whether any is in progress.
 * @throws {never} Never.
 */
export function useMotionRunning(projectId: string, spaceId: string, enabled: boolean): boolean {
  const refreshMs = useTimelineLimits(projectId, enabled)?.webAnimation.sourceRefreshIntervalMs;
  const list = useMotionList(projectId, spaceId, 'space', 'running', refreshMs, enabled);
  return enabled && (list.data?.pages[0]?.totals.inProgress ?? 0) > 0;
}
