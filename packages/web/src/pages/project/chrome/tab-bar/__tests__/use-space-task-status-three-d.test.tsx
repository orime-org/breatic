// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The 3D tab spinner (inner#2061 design 5.5, 7.3).
 *
 * For a 3D Space, `useSpaceTaskStatus` asks `useSpaceTasks(projectId, spaceId, type === '3d')` for the Space's running
 * rows and spins while there is one; this page's own upload spins too before the server lists it. How the list is
 * read, read again and kept on a failed read is `useSpaceTasks`'s own test.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceType } from '@breatic/shared';

import { useSpaceTaskStatus } from '@web/pages/project/chrome/tab-bar/use-space-task-status';
import { useSpaceTasks } from '@web/spaces/three-d/use-space-tasks';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/spaces/three-d/use-space-tasks', () => ({ useSpaceTasks: vi.fn() }));
// A 3D tab never reads a Motion execution list; its own file covers the Motion branch.
vi.mock('@web/spaces/web-animation/use-motion-running', () => ({ useMotionRunning: () => false }));
vi.mock('@web/spaces/timeline/use-timeline-limits', () => ({ useTimelineLimits: () => undefined }));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';

/**
 * Make the 3D task list report a running count.
 * @param running - The count.
 * @returns Nothing.
 * @throws {never} Never.
 */
function runningRows(running: number): void {
  vi.mocked(useSpaceTasks).mockReturnValue({ running } as ReturnType<typeof useSpaceTasks>);
}

beforeEach(() => {
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(useSpaceTasks).mockReset();
  runningRows(0);
});

describe('useSpaceTaskStatus for a 3D Space', () => {
  it('spins while the Space\'s task list has a running row', () => {
    runningRows(1);
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'));
    expect(result.current).toBe(true);
  });

  it('does not spin when no row runs', () => {
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'));
    expect(result.current).toBe(false);
  });

  it('spins for this page\'s own upload before the server lists it', () => {
    const { result, rerender } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'));
    useSpaceOperationsStore.getState().register(SPACE, 'b0000000-0000-4000-8000-000000000001');
    rerender();
    expect(result.current).toBe(true);
  });

  it.each(['3d', 'canvas', 'document', 'timeline'] as const)('reads the 3D task list for a %s Space only when it is 3D', (type: SpaceType) => {
    renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, type));
    expect(useSpaceTasks).toHaveBeenCalledWith(PROJECT, SPACE, type === '3d');
  });
});
