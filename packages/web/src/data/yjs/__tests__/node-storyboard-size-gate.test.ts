// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-90: storyboard writes are judged by the
 * kind design 5.2 gives them (answer A6): entering, adding, setting and
 * re-totalling shots are `add`, removing a shot is `delete`, stepping a
 * shot's length is `overwrite`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { addNode, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import {
  addStoryboardShot,
  enterStoryboardShots,
  readShots,
  removeStoryboardShot,
  retotalStoryboard,
  setStoryboardShots,
  shotListOf,
  stepStoryboardShot,
} from '@web/data/yjs/node-storyboard';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import { COPY_EN, F_FULL, F_FULL_NEAR, F_OVER, F_WARNING, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Seeds video v1 in multi-shot mode with two five-second shots while the
 * size is unknown, then delivers one push.
 * @param push - The size push.
 * @returns The ids of the two shots, in order.
 * @throws {Error} When seeding fails.
 */
function storyboardAt(push: DocSizePush, { shots = true }: { shots?: boolean } = {}): { shot0: string; shot1: string } {
  const { provider } = openSizedDoc(NAME);
  addNode(PID, SID, {
    id: 'v1',
    type: 'video',
    position: { x: 0, y: 0 },
    data: { name: 'v1', createdAt: 1, createdBy: 'u1', locked: false, attachments: [], mode: 'multi_shot' },
  } as CanvasNodeFields);
  if (shots) setStoryboardShots(PID, SID, 'v1', [5, 5]);
  const list = readShots(PID, SID, 'v1')!;
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  return { shot0: list[0]?.id ?? '', shot1: list[1]?.id ?? '' };
}

/**
 * The stored shot list as plain JSON.
 * @returns The shots.
 */
function shotsJson(): unknown {
  return (shotListOf(PID, SID, 'v1') as Y.Array<Y.Map<unknown>>).toJSON();
}

beforeEach(() => {
  sizeGateProviders.length = 0;
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.clearAllMocks();
});

describe('W-90 storyboard writes are judged by kind', () => {
  it.each([
    ['addStoryboardShot', (): void => { addStoryboardShot(PID, SID, 'v1', 10, 6); }],
    ['setStoryboardShots', (): void => { setStoryboardShots(PID, SID, 'v1', [3, 3]); }],
  ] as const)('(a) %s is an add and is refused at full', (_name, call) => {
    storyboardAt(F_FULL);
    const before = shotsJson();
    call();
    expect(shotsJson()).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('(b) removing a shot is a delete and goes through over the hard ceiling', () => {
    const { shot0, shot1 } = storyboardAt(F_OVER);
    removeStoryboardShot(PID, SID, 'v1', shot0, 10);
    expect(readShots(PID, SID, 'v1')!.map((s) => s.id)).toEqual([shot1]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('(c) stepping a shot is an overwrite and goes through at full with overwrite room left', () => {
    const { shot0 } = storyboardAt(F_FULL);
    stepStoryboardShot(PID, SID, 'v1', shot0, 1);
    expect(readShots(PID, SID, 'v1')!.map((s) => s.duration)).toEqual([6, 4]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('(d) stepping a shot is refused once the overwrite room is gone', () => {
    const { shot0 } = storyboardAt(F_FULL_NEAR);
    const before = shotsJson();
    stepStoryboardShot(PID, SID, 'v1', shot0, 1);
    expect(shotsJson()).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_OVERWRITE_BLOCKED);
  });

  it('(a) entering the shots on a node with none is an add and is refused at full', () => {
    storyboardAt(F_FULL, { shots: false });
    enterStoryboardShots(PID, SID, 'v1', 10);
    expect(readShots(PID, SID, 'v1')).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
  });

  it.each([
    ['retotalStoryboard', (): void => retotalStoryboard(PID, SID, 'v1', 12)],
    ['enterStoryboardShots on existing shots', (): void => enterStoryboardShots(PID, SID, 'v1', 12)],
  ] as const)('(f) %s rewrites durations as an overwrite at full', (_name, call) => {
    storyboardAt(F_FULL);
    call();
    expect(readShots(PID, SID, 'v1')!.map((s) => s.duration)).toEqual([6, 6]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['retotalStoryboard', (): void => retotalStoryboard(PID, SID, 'v1', 12)],
    ['enterStoryboardShots on existing shots', (): void => enterStoryboardShots(PID, SID, 'v1', 12)],
  ] as const)('(f) %s is refused once the overwrite room is gone', (_name, call) => {
    storyboardAt(F_FULL_NEAR);
    const before = shotsJson();
    call();
    expect(shotsJson()).toEqual(before);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_OVERWRITE_BLOCKED);
  });

  it('(e) re-totalling goes through near full', () => {
    storyboardAt(F_WARNING);
    retotalStoryboard(PID, SID, 'v1', 12);
    expect(readShots(PID, SID, 'v1')!.reduce((sum, s) => sum + s.duration, 0)).toBe(12);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
