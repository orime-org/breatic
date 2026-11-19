// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RouterModule from 'react-router-dom';

type BlockCondition = (args: {
  currentLocation: { pathname: string };
  nextLocation: { pathname: string; state?: unknown };
  historyAction: string;
}) => boolean;

const { routerState } = vi.hoisted(() => ({
  routerState: { condition: null as BlockCondition | null },
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof RouterModule>(),
  useBlocker: (condition: BlockCondition) => {
    routerState.condition = condition;
    return { state: 'unblocked', proceed: vi.fn(), reset: vi.fn() };
  },
}));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import { spaceContentDocName } from '@breatic/shared';
import {
  confirmRequests, handshake, resetProviderSpies, runTimers, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  acquireDocProvider, hasProjectUnsyncedEdits, useProjectUnsyncedEdits, _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { LeaveProjectGuard } from '@web/pages/project/LeaveProjectGuard';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

const PID = '11111111-1111-4111-8111-111111111111';
const TIMELINE_SID = '22222222-2222-4222-8222-222222222222';
const CANVAS_SID = '33333333-3333-4333-8333-333333333333';
const MOTION_SID = '44444444-4444-4444-8444-444444444444';

/**
 * Invokes the production leave predicate.
 * @returns Whether an ordinary navigation away is blocked.
 * @throws {AssertionError} When the guard did not register its predicate.
 */
function blocked(): boolean {
  expect(typeof routerState.condition).toBe('function');
  return routerState.condition!({ currentLocation: { pathname: `/project/demo-${PID}` }, nextLocation: { pathname: '/studio' }, historyAction: 'PUSH' });
}

/**
 * Opens a Space content document of the Project.
 * @param kind - Space type.
 * @param spaceId - Space id.
 * @returns Its name, document and provider spy.
 * @throws {Error} When acquiring fails.
 */
function content(kind: 'canvas' | 'timeline' | 'web_animation', spaceId: string): { name: string; provider: ProviderSpy } {
  const name = spaceContentDocName(PID, spaceId, kind);
  const provider = acquireDocProvider(name, getDoc(name)) as unknown as ProviderSpy;
  return { name, provider };
}

beforeEach(() => {
  resetProviderSpies();
  routerState.condition = null;
  useSpaceOperationsStore.setState({ operations: {} });
  render(<MemoryRouter initialEntries={[`/project/demo-${PID}`]}><Routes><Route path='/project/:projectId' element={<LeaveProjectGuard />} /></Routes></MemoryRouter>);
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('timeline takes no receipts (design 6, inner#1790)', () => {
  it('design 6: an edit of a timeline document sends no sync:confirm and never blocks leaving; a canvas edit still does', async () => {
    const timeline = content('timeline', TIMELINE_SID);
    const canvas = content('canvas', CANVAS_SID);
    await handshake(timeline.name, timeline.provider);
    await handshake(canvas.name, canvas.provider);
    const { result } = renderHook(() => useProjectUnsyncedEdits(PID));

    act(() => { getDoc(timeline.name).getMap('clips').set('c1', 1); });
    await runTimers();
    expect(confirmRequests(timeline.provider)).toHaveLength(0);
    expect(hasProjectUnsyncedEdits(PID)).toBe(false);
    expect(result.current).toBe(false);
    expect(blocked()).toBe(false);

    act(() => { getDoc(canvas.name).getMap('nodesMap').set('n1', 1); });
    await runTimers();
    expect(confirmRequests(canvas.provider)).toHaveLength(1);
    expect(hasProjectUnsyncedEdits(PID)).toBe(true);
    expect(result.current).toBe(true);
    expect(blocked()).toBe(true);
  });
});

describe('a Motion Space\'s annotations are edits the page waits for (#1490 design §3.3)', () => {
  it('asks collab to confirm an annotation write and blocks leaving until it does', async () => {
    const motion = content('web_animation', MOTION_SID);
    await handshake(motion.name, motion.provider);
    const { result } = renderHook(() => useProjectUnsyncedEdits(PID));

    act(() => { getDoc(motion.name).getMap('webAnimationAnnotationThreads').set('t1', 1); });
    await runTimers();
    expect(confirmRequests(motion.provider)).toHaveLength(1);
    expect(hasProjectUnsyncedEdits(PID)).toBe(true);
    expect(result.current).toBe(true);
    expect(blocked()).toBe(true);
  });
});
