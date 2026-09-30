// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel follows one mode's storyboard as it changes (#2218): a tier set,
 * a shot added or a shot's seconds moved, here or by a collaborator.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { CanvasNodeFields } from '@breatic/shared';

import { _resetForTests } from '@web/data/yjs/manager';
import { addNode } from '@web/data/yjs/canvas-space';
import { enterStoryboardShots, setStoryboardKind, stepStoryboardShot } from '@web/data/yjs/node-storyboard';
import { useStoryboard } from '@web/data/yjs/use-storyboard';

const PID = 'p1';
const SID = 's1';

const VIDEO: CanvasNodeFields = {
  id: 'v1',
  type: 'video',
  position: { x: 0, y: 0 },
  data: { name: 'V', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
};

describe('following a storyboard', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, VIDEO);
  });

  it('starts off with no shots', () => {
    const { result } = renderHook(() => useStoryboard(PID, SID, 'v1', 't2v'));
    expect(result.current).toMatchObject({ kind: 'off', shots: [] });
  });

  it('follows a tier change and the shots it brings', () => {
    const { result } = renderHook(() => useStoryboard(PID, SID, 'v1', 't2v'));
    act(() => setStoryboardKind(PID, SID, 'v1', 't2v', 'auto'));
    expect(result.current?.kind).toBe('auto');
    act(() => enterStoryboardShots(PID, SID, 'v1', 't2v', 5));
    expect(result.current?.shots.map((s) => s.duration)).toEqual([2, 3]);
  });

  it('follows a shot seconds change', () => {
    const { result } = renderHook(() => useStoryboard(PID, SID, 'v1', 't2v'));
    act(() => enterStoryboardShots(PID, SID, 'v1', 't2v', 5));
    const first = result.current?.shots[0]?.id ?? '';
    act(() => stepStoryboardShot(PID, SID, 'v1', 't2v', first, 1));
    expect(result.current?.shots.map((s) => s.duration)).toEqual([3, 2]);
  });

  it('reads another mode on its own', () => {
    act(() => setStoryboardKind(PID, SID, 'v1', 't2v', 'auto'));
    const { result } = renderHook(() => useStoryboard(PID, SID, 'v1', 'i2v'));
    expect(result.current?.kind).toBe('off');
  });
});
